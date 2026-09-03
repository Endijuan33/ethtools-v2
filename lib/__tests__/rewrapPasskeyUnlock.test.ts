import { test } from "node:test"
import assert from "node:assert/strict"
import { setLogSink } from "../logger"
import {
  enrollPasskeyUnlock,
  hasPasskeyUnlock,
  rewrapPasskeyUnlock,
  unlockWithPasskey,
} from "../webauthnUnlock"
import { createMemoryBackend, readRaw, setStorageBackend, STORAGE_KEYS, writeJson, type StorageBackend } from "../storage"

// Expected-failure paths log warnings through the app logger; silence them so
// the test output stays about assertions, not console noise. Each test file
// runs in its own process, so this cannot leak into other suites.
setLogSink(() => {})

const PASSWORD = "Correct-Horse-9!"
const NEW_PASSWORD = "Another-Horse-8?"

/**
 * A deterministic stand-in for the fake authenticator in
 * `webauthnUnlock.test.ts` — same contract, kept local so this suite stays
 * independent of that file's internals. `get` serves a DETERMINISTIC "PRF"
 * (HMAC-SHA256 under a fixed secret over the requested salt), so enrollment,
 * unlock, and re-wrap all derive the same key from the same credential+salt.
 */

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

interface FakeAuthenticator {
  restore: () => void
  stats: { createCalls: number; getCalls: number }
}

interface FakeOptions {
  /** Reject get() with this error, simulating a cancelled prompt. */
  getError?: Error
  /** Complete get() but return no PRF results (lost PRF support). */
  getDropsResults?: boolean
}

function installFakeAuthenticator(options: FakeOptions = {}): FakeAuthenticator {
  const { getError, getDropsResults = false } = options

  const rawId = FAKE_CREDENTIAL_ID.slice().buffer
  const id = Buffer.from(FAKE_CREDENTIAL_ID).toString("base64")
  const stats = { createCalls: 0, getCalls: 0 }

  const container = {
    create: async () => {
      stats.createCalls += 1
      // PRF-enabled but NOT evaluated at create, so enrollment runs the
      // second ceremony — the platform-standard two-prompt flow.
      return {
        type: "public-key" as const,
        id,
        rawId,
        getClientExtensionResults: () => ({ prf: { enabled: true } }),
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
        "the re-wrap ceremony must target the enrolled credential"
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

function useStore(): void {
  setStorageBackend(createMemoryBackend())
}

function resetStore(): void {
  setStorageBackend(null)
}

/** Read the stored envelope as a plain record for field-level assertions. */
function storedRecord(): Record<string, Record<string, unknown> | string | number> {
  return JSON.parse(readRaw(STORAGE_KEYS.VAULT_PASSKEY) ?? "{}") as Record<
    string,
    Record<string, unknown> | string | number
  >
}

// ===== Happy path =====

test("re-wrap after a password change unlocks with the NEW password", async () => {
  useStore()
  const fake = installFakeAuthenticator()
  try {
    const enrolled = await enrollPasskeyUnlock(PASSWORD)
    assert.equal(enrolled.ok, true)
    const before = storedRecord()

    const rewrapped = await rewrapPasskeyUnlock(NEW_PASSWORD)
    assert.equal(rewrapped.ok, true)

    // The wrap actually changed — the new password is not the old ciphertext.
    const after = storedRecord()
    assert.notEqual(
      (before.envelope as Record<string, unknown>).cipher,
      (after.envelope as Record<string, unknown>).cipher,
      "the re-wrapped ciphertext must differ from the old one"
    )

    // Same credential, salt, and user handle: re-wrap replaces the wrapped
    // password only, never the credential the user enrolled with.
    assert.equal(after.credentialId, before.credentialId)
    assert.equal(after.salt, before.salt)
    assert.equal(after.userHandle, before.userHandle)

    // No create ceremony: re-wrap re-uses the existing credential.
    assert.equal(fake.stats.createCalls, 1, "re-wrap must not create a new credential")

    // The crypto boundary, end to end: unwrap under the same PRF key yields
    // the NEW password, which now opens the vault.
    const unlocked = await unlockWithPasskey()
    assert.equal(unlocked.ok, true)
    if (unlocked.ok) assert.equal(unlocked.value, NEW_PASSWORD)

    // And the old password is no longer what the envelope yields.
    assert.notEqual(unlocked.ok && unlocked.value, PASSWORD)
  } finally {
    fake.restore()
    resetStore()
  }
})

// ===== Failure paths: fail to REMOVED, never to stale =====

test("a declined re-wrap ceremony removes the envelope instead of leaving it stale", async () => {
  useStore()
  const enrollFake = installFakeAuthenticator()
  try {
    await enrollPasskeyUnlock(PASSWORD)
    assert.equal(hasPasskeyUnlock(), true)
  } finally {
    enrollFake.restore()
  }

  const declinedFake = installFakeAuthenticator({
    getError: new DOMException(
      "The operation either timed out or was not allowed.",
      "NotAllowedError"
    ),
  })
  try {
    const rewrapped = await rewrapPasskeyUnlock(NEW_PASSWORD)
    assert.equal(rewrapped.ok, false)
    if (rewrapped.ok) return
    assert.match(rewrapped.error, /removed because it could not be re-wrapped/i)

    // No stale envelope may survive: passkey unlock now reads as absent, never
    // as an enrolled passkey that produces a confusing wrong-password error.
    assert.equal(hasPasskeyUnlock(), false)
    assert.equal(readRaw(STORAGE_KEYS.VAULT_PASSKEY), null)

    const unlocked = await unlockWithPasskey()
    assert.equal(unlocked.ok, false)
    if (unlocked.ok) return
    assert.match(unlocked.error, /not set up/i)
  } finally {
    declinedFake.restore()
    resetStore()
  }
})

test("a ceremony that completes without PRF output removes the envelope", async () => {
  useStore()
  const enrollFake = installFakeAuthenticator()
  try {
    await enrollPasskeyUnlock(PASSWORD)
  } finally {
    enrollFake.restore()
  }

  const prflessFake = installFakeAuthenticator({ getDropsResults: true })
  try {
    const rewrapped = await rewrapPasskeyUnlock(NEW_PASSWORD)
    assert.equal(rewrapped.ok, false)
    if (rewrapped.ok) return
    assert.match(rewrapped.error, /removed because it could not be re-wrapped/i)
    assert.equal(readRaw(STORAGE_KEYS.VAULT_PASSKEY), null)
  } finally {
    prflessFake.restore()
    resetStore()
  }
})

test("a byte-invalid stored envelope is removed rather than re-wrapped", async () => {
  useStore()
  const fake = installFakeAuthenticator()
  try {
    await enrollPasskeyUnlock(PASSWORD)

    // Same shape, but the salt is not base64: passes the schema guard, fails
    // the byte decode. The envelope is unusable and must be removed.
    const record = storedRecord()
    record.salt = "not base64 !!"
    writeJson(STORAGE_KEYS.VAULT_PASSKEY, record)

    const rewrapped = await rewrapPasskeyUnlock(NEW_PASSWORD)
    assert.equal(rewrapped.ok, false)
    if (rewrapped.ok) return
    assert.match(rewrapped.error, /removed because it could not be re-wrapped/i)
    assert.equal(readRaw(STORAGE_KEYS.VAULT_PASSKEY), null)
  } finally {
    fake.restore()
    resetStore()
  }
})

test("a re-wrap whose envelope cannot be persisted removes the stale envelope", async () => {
  useStore()
  const enrollFake = installFakeAuthenticator()
  try {
    await enrollPasskeyUnlock(PASSWORD)
  } finally {
    enrollFake.restore()
  }

  // A backend whose writes are blocked (policy, quota, private browsing) but
  // whose reads and deletes still work: the ceremony succeeds, the write of
  // the replacement envelope fails, and the OLD envelope — now stale — must
  // not survive.
  const map = new Map<string, string>()
  const blockedWrites: StorageBackend = {
    getItem: (k) => map.get(k) ?? null,
    setItem: () => {
      throw new Error("blocked by policy")
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
  map.set(STORAGE_KEYS.VAULT_PASSKEY, readRaw(STORAGE_KEYS.VAULT_PASSKEY) ?? "")

  const rewrapFake = installFakeAuthenticator()
  try {
    setStorageBackend(blockedWrites)
    const rewrapped = await rewrapPasskeyUnlock(NEW_PASSWORD)
    assert.equal(rewrapped.ok, false)
    if (rewrapped.ok) return
    assert.match(rewrapped.error, /removed because it could not be re-wrapped/i)
    assert.equal(readRaw(STORAGE_KEYS.VAULT_PASSKEY), null, "the stale envelope must be gone")
  } finally {
    rewrapFake.restore()
    resetStore()
  }
})

test("re-wrap without an enrollment reports that it is not set up", async () => {
  useStore()
  const fake = installFakeAuthenticator()
  try {
    const rewrapped = await rewrapPasskeyUnlock(NEW_PASSWORD)
    assert.equal(rewrapped.ok, false)
    if (rewrapped.ok) return
    assert.match(rewrapped.error, /not set up/i)
    assert.equal(readRaw(STORAGE_KEYS.VAULT_PASSKEY), null)
  } finally {
    fake.restore()
    resetStore()
  }
})

test("re-wrap without WebAuthn removes the stale envelope", async () => {
  useStore()
  const enrollFake = installFakeAuthenticator()
  try {
    await enrollPasskeyUnlock(PASSWORD)
  } finally {
    enrollFake.restore()
  }

  try {
    // Node's real navigator has no credentials container: an environment that
    // cannot run the ceremony also cannot re-wrap, and the envelope is stale.
    const rewrapped = await rewrapPasskeyUnlock(NEW_PASSWORD)
    assert.equal(rewrapped.ok, false)
    if (rewrapped.ok) return
    assert.match(rewrapped.error, /removed because it could not be re-wrapped/i)
    assert.equal(readRaw(STORAGE_KEYS.VAULT_PASSKEY), null)
  } finally {
    resetStore()
  }
})

test("the stored re-wrapped record contains no readable password", async () => {
  useStore()
  const fake = installFakeAuthenticator()
  try {
    await enrollPasskeyUnlock(PASSWORD)
    const rewrapped = await rewrapPasskeyUnlock(NEW_PASSWORD)
    assert.equal(rewrapped.ok, true)

    const raw = readRaw(STORAGE_KEYS.VAULT_PASSKEY) ?? ""
    assert.equal(raw.includes(NEW_PASSWORD), false, "no readable new password at rest")
    assert.equal(raw.includes(PASSWORD), false, "no readable old password at rest")
  } finally {
    fake.restore()
    resetStore()
  }
})
