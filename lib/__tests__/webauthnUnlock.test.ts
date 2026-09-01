import { test } from "node:test"
import assert from "node:assert/strict"
import { setLogSink } from "../logger"
import {
  enrollPasskeyUnlock,
  hasPasskeyUnlock,
  isPasskeyUnlockAvailable,
  removePasskeyUnlock,
  unlockWithPasskey,
  unwrapPasswordWithPrf,
  wrapPasswordWithPrf,
} from "../webauthnUnlock"
import {
  isPasskeyUnlockEnvelope,
  PASSKEY_ENVELOPE_VERSION,
} from "../schema"
import {
  createMemoryBackend,
  readRaw,
  setStorageBackend,
  STORAGE_KEYS,
  writeJson,
} from "../storage"

// Expected-failure paths log warnings through the app logger; silence them so
// the test output stays about assertions, not console noise. Each test file
// runs in its own process, so this cannot leak into other suites.
setLogSink(() => {})

const PASSWORD = "Correct-Horse-9!"
const OTHER_PASSWORD = "Another-Horse-8?"

/** A deterministic stand-in for 32 bytes of PRF output. */
function prfKey(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => (i + seed) % 256)
}

function useStore(): void {
  setStorageBackend(createMemoryBackend())
}

function resetStore(): void {
  setStorageBackend(null)
}

// ===== Wrap / unwrap (pure crypto) =====

test("wrap/unwrap round-trips the password under a raw 32-byte key", async () => {
  const key = prfKey(1)
  const wrapped = await wrapPasswordWithPrf(key, PASSWORD)
  assert.equal(wrapped.ok, true)
  if (!wrapped.ok) return

  // The wrap must not contain the password in any readable form.
  const serialized = JSON.stringify(wrapped.value)
  assert.equal(serialized.includes(PASSWORD), false, "the wrap must not be plaintext")

  const unwrapped = await unwrapPasswordWithPrf(key, wrapped.value)
  assert.equal(unwrapped.ok, true)
  if (unwrapped.ok) assert.equal(unwrapped.value, PASSWORD)
})

test("a tampered wrap is rejected instead of yielding a wrong password", async () => {
  const wrapped = await wrapPasswordWithPrf(prfKey(2), PASSWORD)
  assert.equal(wrapped.ok, true)
  if (!wrapped.ok) return

  const bytes = Buffer.from(wrapped.value.cipher, "base64")
  bytes[0] ^= 0xff
  const tampered = { ...wrapped.value, cipher: bytes.toString("base64") }

  const unwrapped = await unwrapPasswordWithPrf(prfKey(2), tampered)
  assert.equal(unwrapped.ok, false, "a flipped ciphertext byte must fail the GCM tag check")
})

test("a wrong key cannot unwrap the password", async () => {
  const wrapped = await wrapPasswordWithPrf(prfKey(3), PASSWORD)
  assert.equal(wrapped.ok, true)
  if (!wrapped.ok) return

  const unwrapped = await unwrapPasswordWithPrf(prfKey(4), wrapped.value)
  assert.equal(unwrapped.ok, false)
})

test("wrap rejects a PRF output that is not exactly 32 bytes, and an empty password", async () => {
  const shortKey = await wrapPasswordWithPrf(prfKey(5).subarray(1), PASSWORD)
  assert.equal(shortKey.ok, false)

  const emptyPassword = await wrapPasswordWithPrf(prfKey(6), "")
  assert.equal(emptyPassword.ok, false)
})

// ===== Schema =====

/** A structurally valid envelope with placeholder base64 fields. */
function validEnvelope(): Record<string, unknown> {
  return {
    version: PASSKEY_ENVELOPE_VERSION,
    credentialId: "AbCdEf1234567890AbCdEf12",
    salt: "A".repeat(44),
    userHandle: "B".repeat(24),
    envelope: { iv: "C".repeat(16), cipher: "D".repeat(44) },
  }
}

test("schema accepts a well-formed envelope", () => {
  assert.equal(isPasskeyUnlockEnvelope(validEnvelope()), true)
})

test("schema rejects corrupt or hostile envelopes", () => {
  const base = validEnvelope()

  const wrongs: Array<[string, unknown]> = [
    ["future version", { ...base, version: 2 }],
    ["string version", { ...base, version: "1" }],
    ["missing credentialId", { ...base, credentialId: undefined }],
    ["numeric salt", { ...base, salt: 123 }],
    ["empty userHandle", { ...base, userHandle: "" }],
    ["missing wrapped envelope", { ...base, envelope: undefined }],
    ["wrapped envelope as string", { ...base, envelope: "nope" }],
    ["wrapped envelope missing cipher", { ...base, envelope: { iv: "C".repeat(16) } }],
    ["empty iv", { ...base, envelope: { iv: "", cipher: "D".repeat(44) } }],
    ["null", null],
    ["array", [base]],
    ["plain string", "envelope"],
  ]

  for (const [label, value] of wrongs) {
    assert.equal(isPasskeyUnlockEnvelope(value), false, `${label} must be rejected`)
  }
})

// ===== Fake authenticator =====

/**
 * Install a fake WebAuthn layer over `globalThis.navigator`.
 *
 * Honours the parts of the real contract this module relies on: `create`
 * reports PRF support the way a PRF-capable platform does, `get` serves a
 * DETERMINISTIC "PRF" (HMAC-SHA256 under a fixed secret over the requested
 * salt) so enrollment and unlock derive the same bytes, and both ceremonies
 * verify the request shape they were given.
 */
interface FakeAuthenticator {
  restore: () => void
  stats: { createCalls: number; getCalls: number }
}

interface FakeOptions {
  /** Report the credential as PRF-enabled (default true). */
  prfEnabled?: boolean
  /** Evaluate the PRF during create(), skipping the second ceremony. */
  evaluateAtCreate?: boolean
  /** Reject create() with this error, simulating a cancelled prompt. */
  createError?: Error
  /** Reject get() with this error, simulating a cancelled prompt. */
  getError?: Error
  /** Complete get() but return no PRF results. */
  getDropsResults?: boolean
}

/** One authenticator, so every install serves the same credential id. */
const FAKE_CREDENTIAL_ID = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + (i % 16))

const FAKE_PRF_SECRET = new Uint8Array(32).fill(7)

function sourceBytes(source: unknown): Uint8Array {
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  throw new Error("the fake authenticator received an unexpected id type")
}

async function evaluateLike(salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    FAKE_PRF_SECRET,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, salt as unknown as BufferSource)
  return new Uint8Array(signature)
}

function installFakeAuthenticator(options: FakeOptions = {}): FakeAuthenticator {
  const {
    prfEnabled = true,
    evaluateAtCreate = false,
    createError,
    getError,
    getDropsResults = false,
  } = options

  const rawId = FAKE_CREDENTIAL_ID.slice().buffer
  const id = Buffer.from(FAKE_CREDENTIAL_ID).toString("base64")
  const creationOutputs: {
    prf?: { enabled?: boolean; results?: { first: Uint8Array } }
  } = {}
  const stats = { createCalls: 0, getCalls: 0 }

  const container = {
    create: async (request: CredentialCreationOptions) => {
      stats.createCalls += 1
      if (createError) throw createError

      const prfInput = request.publicKey?.extensions?.prf as
        | { eval?: { first?: unknown } }
        | undefined
      creationOutputs.prf = { enabled: prfEnabled }
      if (prfEnabled && evaluateAtCreate) {
        creationOutputs.prf.results = { first: await evaluateLike(sourceBytes(prfInput?.eval?.first)) }
      }

      return {
        type: "public-key" as const,
        id,
        rawId,
        getClientExtensionResults: () => creationOutputs,
      }
    },

    get: async (request: CredentialRequestOptions) => {
      stats.getCalls += 1
      if (getError) throw getError

      const allowed = request.publicKey?.allowCredentials ?? []
      assert.equal(allowed.length, 1, "PRF eval applies to exactly one allowCredential")
      assert.deepEqual(
        sourceBytes(allowed[0]?.id),
        FAKE_CREDENTIAL_ID,
        "the ceremony must target the enrolled credential"
      )

      const prfInput = request.publicKey?.extensions?.prf as
        | { eval?: { first?: unknown } }
        | undefined
      const first = await evaluateLike(sourceBytes(prfInput?.eval?.first))

      return {
        type: "public-key" as const,
        id,
        rawId,
        getClientExtensionResults: () => ({
          prf: getDropsResults ? {} : { results: { first } },
        }),
      }
    },
  }

  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", {
    value: { credentials: container },
    configurable: true,
    writable: true,
  })

  return {
    stats,
    restore: () => {
      if (previous) {
        Object.defineProperty(globalThis, "navigator", previous)
      }
    },
  }
}

// ===== Feature detection =====

test("isPasskeyUnlockAvailable is false without a browser window", () => {
  // Node has no `window`, matching server rendering.
  assert.equal(isPasskeyUnlockAvailable(), false)
})

// ===== Enrollment and unlock =====

test("enroll → unlock round-trips the vault password through storage", async () => {
  useStore()
  const fake = installFakeAuthenticator()
  try {
    assert.equal(hasPasskeyUnlock(), false)

    const enrolled = await enrollPasskeyUnlock(PASSWORD)
    assert.equal(enrolled.ok, true)
    assert.equal(hasPasskeyUnlock(), true)

    // The stored record must contain no readable password.
    const raw = readRaw(STORAGE_KEYS.VAULT_PASSKEY) ?? ""
    assert.equal(raw.includes(PASSWORD), false, "no readable password at rest")

    // The fake does not evaluate at create, so enrollment needed the second
    // ceremony — the platform-standard two-prompt PRF flow.
    assert.equal(fake.stats.createCalls, 1)
    assert.equal(fake.stats.getCalls, 1)

    const unlocked = await unlockWithPasskey()
    assert.equal(unlocked.ok, true)
    if (unlocked.ok) assert.equal(unlocked.value, PASSWORD)

    // Deterministic PRF: a second unlock derives the same key.
    const again = await unlockWithPasskey()
    assert.equal(again.ok, true)
    if (again.ok) assert.equal(again.value, PASSWORD)
  } finally {
    fake.restore()
    resetStore()
  }
})

test("enrollment succeeds in a single ceremony when the platform evaluates at create", async () => {
  useStore()
  const fake = installFakeAuthenticator({ evaluateAtCreate: true })
  try {
    const enrolled = await enrollPasskeyUnlock(PASSWORD)
    assert.equal(enrolled.ok, true)
    assert.equal(fake.stats.getCalls, 0, "eval-at-create must not need a second ceremony")

    const unlocked = await unlockWithPasskey()
    assert.equal(unlocked.ok, true)
    if (unlocked.ok) assert.equal(unlocked.value, PASSWORD)
  } finally {
    fake.restore()
    resetStore()
  }
})

test("each enrollment records a distinct user handle and salt", async () => {
  useStore()
  const fake = installFakeAuthenticator({ evaluateAtCreate: true })
  try {
    await enrollPasskeyUnlock(PASSWORD)
    const first = JSON.parse(readRaw(STORAGE_KEYS.VAULT_PASSKEY) ?? "{}") as Record<string, unknown>
    await enrollPasskeyUnlock(PASSWORD)
    const second = JSON.parse(readRaw(STORAGE_KEYS.VAULT_PASSKEY) ?? "{}") as Record<string, unknown>

    // Distinct handles make each enrollment a distinct credential, so
    // re-enrolling never collides with a passkey already held.
    assert.notEqual(first.userHandle, second.userHandle)
    assert.notEqual(first.salt, second.salt)
  } finally {
    fake.restore()
    resetStore()
  }
})

test("an authenticator without PRF support is rejected and writes nothing", async () => {
  useStore()
  const fake = installFakeAuthenticator({ prfEnabled: false })
  try {
    const enrolled = await enrollPasskeyUnlock(PASSWORD)
    assert.equal(enrolled.ok, false)
    if (enrolled.ok) return
    assert.match(enrolled.error, /does not support/i)

    assert.equal(hasPasskeyUnlock(), false)
    assert.equal(readRaw(STORAGE_KEYS.VAULT_PASSKEY), null, "nothing may be persisted")
  } finally {
    fake.restore()
    resetStore()
  }
})

test("PRF enabled at create but never evaluating is rejected and writes nothing", async () => {
  useStore()
  const fake = installFakeAuthenticator({ getDropsResults: true })
  try {
    const enrolled = await enrollPasskeyUnlock(PASSWORD)
    assert.equal(enrolled.ok, false)

    assert.equal(hasPasskeyUnlock(), false)
    assert.equal(readRaw(STORAGE_KEYS.VAULT_PASSKEY), null, "nothing may be persisted")
  } finally {
    fake.restore()
    resetStore()
  }
})

test("enrollment without WebAuthn reports unavailability and writes nothing", async () => {
  useStore()
  try {
    // Node's real navigator has no credentials container.
    const enrolled = await enrollPasskeyUnlock(PASSWORD)
    assert.equal(enrolled.ok, false)
    if (enrolled.ok) return
    assert.match(enrolled.error, /unavailable/i)
    assert.equal(hasPasskeyUnlock(), false)
  } finally {
    resetStore()
  }
})

test("a cancelled enrollment prompt maps to a user-safe message", async () => {
  useStore()
  const fake = installFakeAuthenticator({
    createError: new DOMException(
      "The operation either timed out or was not allowed.",
      "NotAllowedError"
    ),
  })
  try {
    const enrolled = await enrollPasskeyUnlock(PASSWORD)
    assert.equal(enrolled.ok, false)
    if (enrolled.ok) return
    assert.equal(enrolled.error, "The passkey prompt was cancelled or timed out.")
    assert.equal(hasPasskeyUnlock(), false)
  } finally {
    fake.restore()
    resetStore()
  }
})

test("a cancelled unlock prompt maps to a user-safe message", async () => {
  useStore()
  const enrollFake = installFakeAuthenticator({ evaluateAtCreate: true })
  try {
    const enrolled = await enrollPasskeyUnlock(PASSWORD)
    assert.equal(enrolled.ok, true)
  } finally {
    enrollFake.restore()
  }

  const unlockFake = installFakeAuthenticator({
    getError: new DOMException(
      "The operation either timed out or was not allowed.",
      "NotAllowedError"
    ),
  })
  try {
    const unlocked = await unlockWithPasskey()
    assert.equal(unlocked.ok, false)
    if (unlocked.ok) return
    assert.equal(unlocked.error, "The passkey prompt was cancelled or timed out.")
  } finally {
    unlockFake.restore()
    resetStore()
  }
})

test("unlock without an enrollment reports that it is not set up", async () => {
  useStore()
  const fake = installFakeAuthenticator()
  try {
    const unlocked = await unlockWithPasskey()
    assert.equal(unlocked.ok, false)
    if (unlocked.ok) return
    assert.match(unlocked.error, /not set up/i)
  } finally {
    fake.restore()
    resetStore()
  }
})

test("a structurally valid but byte-invalid envelope degrades to password unlock", async () => {
  useStore()
  const fake = installFakeAuthenticator({ evaluateAtCreate: true })
  try {
    const enrolled = await enrollPasskeyUnlock(PASSWORD)
    assert.equal(enrolled.ok, true)

    // Same shape, but the salt is not base64: passes the schema guard, fails
    // the byte decode. Must degrade, never bypass.
    const record = JSON.parse(readRaw(STORAGE_KEYS.VAULT_PASSKEY) ?? "{}") as Record<string, unknown>
    record.salt = "not base64 !!"
    writeJson(STORAGE_KEYS.VAULT_PASSKEY, record)

    const unlocked = await unlockWithPasskey()
    assert.equal(unlocked.ok, false)
    if (unlocked.ok) return
    assert.match(unlocked.error, /malformed|not set up/i)
  } finally {
    fake.restore()
    resetStore()
  }
})

test("an envelope from an unreadable future version reads as absent", async () => {
  useStore()
  try {
    writeJson(STORAGE_KEYS.VAULT_PASSKEY, {
      version: 99,
      credentialId: "AbCdEf1234567890AbCdEf12",
      salt: "A".repeat(44),
      userHandle: "B".repeat(24),
      envelope: { iv: "C".repeat(16), cipher: "D".repeat(44) },
    })
    assert.equal(hasPasskeyUnlock(), false, "an unknown version must read as not enrolled")
  } finally {
    resetStore()
  }
})

test("removePasskeyUnlock deletes the enrollment", async () => {
  useStore()
  const fake = installFakeAuthenticator({ evaluateAtCreate: true })
  try {
    await enrollPasskeyUnlock(PASSWORD)
    assert.equal(hasPasskeyUnlock(), true)

    removePasskeyUnlock()
    assert.equal(hasPasskeyUnlock(), false)
    assert.equal(readRaw(STORAGE_KEYS.VAULT_PASSKEY), null)

    const unlocked = await unlockWithPasskey()
    assert.equal(unlocked.ok, false, "removed enrollment must not unlock")
  } finally {
    fake.restore()
    resetStore()
  }
})

test("a failed re-enrollment leaves an existing enrollment intact", async () => {
  useStore()
  const enrollFake = installFakeAuthenticator({ evaluateAtCreate: true })
  try {
    await enrollPasskeyUnlock(PASSWORD)
  } finally {
    enrollFake.restore()
  }

  const failedFake = installFakeAuthenticator({
    createError: new DOMException("cancelled", "NotAllowedError"),
  })
  try {
    const result = await enrollPasskeyUnlock(OTHER_PASSWORD)
    assert.equal(result.ok, false)
    assert.equal(hasPasskeyUnlock(), true, "the previous envelope must survive")

    // The surviving envelope still unwraps the ORIGINAL password.
    const unlocked = await unlockWithPasskey()
    assert.equal(unlocked.ok, true)
    if (unlocked.ok) assert.equal(unlocked.value, PASSWORD)
  } finally {
    failedFake.restore()
    resetStore()
  }
})
