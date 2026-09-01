/**
 * Optional "Unlock with passkey" for the encrypted vault (experimental).
 *
 * Architecture — a strictly ADDITIVE second envelope. The canonical vault in
 * `lib/vaultStore.ts` (password → PBKDF2 → AES-GCM) is untouched and remains
 * the default, fully intact path:
 *
 * - Enrollment (only offered while the vault is unlocked) creates a WebAuthn
 *   credential with the `prf` extension, evaluates the PRF over a random
 *   stored salt to obtain 32 bytes, imports those bytes directly as a raw
 *   AES-256-GCM key, and encrypts THE VAULT PASSWORD ITSELF into a small
 *   localStorage record together with the credential id and salt.
 * - Unlock repeats the ceremony, re-derives the same key, decrypts the wrap,
 *   and hands the password to the caller, which feeds it through the unchanged
 *   `unlockVault` path. The password then exists in memory exactly as if typed.
 *
 * Security properties:
 * - The PRF output and the unwrapped password live only in memory during a
 *   ceremony; neither is ever logged (see `lib/logger.ts`) or persisted. The
 *   stored record is AES-GCM ciphertext, useless without the credential.
 * - The record is schema-validated on read. A corrupt or hostile entry
 *   degrades to "passkey unlock unavailable, use your password" — never to a
 *   bypass: the record can only ever yield the wrapped password, and a wrong
 *   PRF output fails the GCM tag check instead of producing a wrong password.
 * - Staleness is the caller's check: if `unlockVault` rejects the unwrapped
 *   password, the envelope no longer matches the vault and must be re-enrolled.
 *
 * Why there is no upfront PRF feature detection: browsers expose PRF
 * capability only in `getClientExtensionResults()` DURING a ceremony. The
 * synchronous check below gates on WebAuthn + secure context (hiding the
 * enroll control where passkeys cannot exist at all); Safari and Firefox —
 * which have WebAuthn but not PRF — discover the absence during enrollment
 * and receive a clean "unsupported" failure. The ceremony-time result is the
 * only honest signal, so no platform-authenticator probe is used as a gate
 * (it would wrongly exclude hybrid/security-key passkeys while failing to
 * exclude PRF-less browsers that do have platform authenticators).
 */

import { logger } from "./logger"
import {
  isPasskeyUnlockEnvelope,
  PASSKEY_ENVELOPE_VERSION,
  type PasskeyUnlockEnvelope,
  type PasskeyWrappedPassword,
} from "./schema"
import { readJson, removeKey, STORAGE_KEYS, writeJson } from "./storage"

/** Outcome of a passkey-unlock operation, mirroring the vault result convention. */
export type PasskeyResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** PRF output length — and exactly the AES-256 key size. */
const PRF_KEY_BYTES = 32

/** Random salt bytes generated per enrollment and fed to the PRF. */
const PRF_SALT_BYTES = 32

/** Random user-handle bytes per enrollment, making each credential distinct. */
const USER_HANDLE_BYTES = 16

/** AES-GCM initialization vector length. */
const IV_BYTES = 12

/** Ceremony challenge length. Random; its content is never interpreted. */
const CHALLENGE_BYTES = 32

/** AES key size for the raw PRF-output import. */
const AES_KEY_BITS = 256

/** How long the browser may keep the OS prompt open before giving up. */
const CEREMONY_TIMEOUT_MS = 120_000

/** Relying-party name shown by the browser in its passkey UI. */
const RP_NAME = "EthTools"

/** Fixed user name/display name for the vault credential. */
const USER_DISPLAY_NAME = "EthTools Vault"

/** COSE algorithms requested, in preference order (ES256, then RS256). */
const SUPPORTED_ALGS = [-7, -257] as const

// ===== Feature detection =====

/**
 * Synchronous capability hint for the UI.
 *
 * True only where WebAuthn exists in a secure context. This hides the enroll
 * control in environments where a passkey ceremony cannot even start; it
 * deliberately does NOT promise PRF support (see the module docs for why that
 * is impossible before a ceremony). Call after mount — it is false during
 * server rendering by design, so components should render from state set in
 * an effect rather than calling this inline during the first paint.
 */
export function isPasskeyUnlockAvailable(): boolean {
  if (typeof window === "undefined" || window.isSecureContext === false) return false
  return typeof window.PublicKeyCredential === "function"
}

// ===== Encoding helpers =====

/**
 * Encode bytes as base64. Payloads here are tiny (a password wrap), so no
 * chunking is needed unlike the vault's larger envelopes.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Decode base64 requiring an exact byte length, or null when invalid. */
function decodeBase64Exact(value: string, length: number): Uint8Array | null {
  try {
    const binary = atob(value)
    if (binary.length !== length) return null
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch {
    return null
  }
}

/** Decode base64 requiring at least `minLength` bytes, or null when invalid. */
function decodeBase64Min(value: string, minLength: number): Uint8Array | null {
  try {
    const binary = atob(value)
    if (binary.length < minLength) return null
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch {
    return null
  }
}

// ===== PRF output → AES-GCM wrap =====

function getSubtle(): SubtleCrypto | null {
  const c = globalThis.crypto
  return c && "subtle" in c ? c.subtle : null
}

/**
 * Import raw PRF output directly as an AES-256-GCM key.
 *
 * No KDF is applied — and none is wanted. The vault's PBKDF2 exists to slow
 * down brute force of a *low-entropy password*; the PRF output is a uniform
 * 256-bit value keyed by the credential and salt, so stretching it would add
 * cost without adding entropy. This is the raw-key counterpart of
 * `deriveKey` in `lib/vault.ts`.
 */
async function importPrfKey(bytes: Uint8Array, subtle: SubtleCrypto): Promise<CryptoKey> {
  // BufferSource is structurally satisfied by Uint8Array at runtime; the cast
  // keeps TS happy across lib.dom versions that narrow to ArrayBuffer.
  return subtle.importKey(
    "raw",
    bytes as unknown as BufferSource,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false,
    ["encrypt", "decrypt"]
  )
}

/**
 * Wrap (encrypt) the vault password under a raw 32-byte PRF output.
 *
 * @param prfOutput - Exactly 32 bytes from the `prf` extension evaluation.
 * @param password - The current vault password, already verified by the caller.
 */
export async function wrapPasswordWithPrf(
  prfOutput: Uint8Array,
  password: string
): Promise<PasskeyResult<PasskeyWrappedPassword>> {
  const subtle = getSubtle()
  if (!subtle) {
    return {
      ok: false,
      error:
        "Encryption is unavailable in this browser. A secure (HTTPS) connection is required.",
    }
  }
  if (prfOutput.length !== PRF_KEY_BYTES) {
    return { ok: false, error: "The passkey produced an unusable key." }
  }
  if (password.length === 0) {
    return { ok: false, error: "The vault password is empty." }
  }

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await importPrfKey(prfOutput, subtle)
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(password) as unknown as BufferSource
  )

  return {
    ok: true,
    value: { iv: toBase64(iv), cipher: toBase64(new Uint8Array(cipher)) },
  }
}

/**
 * Unwrap (decrypt) the vault password under a raw 32-byte PRF output.
 *
 * AES-GCM is authenticated: a wrong key, a tampered ciphertext, or a truncated
 * payload all fail the tag check and return the same generic failure — the
 * wrap can never silently yield a *wrong* password.
 */
export async function unwrapPasswordWithPrf(
  prfOutput: Uint8Array,
  wrapped: PasskeyWrappedPassword
): Promise<PasskeyResult<string>> {
  const subtle = getSubtle()
  if (!subtle) {
    return {
      ok: false,
      error:
        "Decryption is unavailable in this browser. A secure (HTTPS) connection is required.",
    }
  }
  if (prfOutput.length !== PRF_KEY_BYTES) {
    return { ok: false, error: "The passkey produced an unusable key." }
  }

  const iv = decodeBase64Exact(wrapped.iv, IV_BYTES)
  const cipher = decodeBase64Min(wrapped.cipher, 1)
  if (!iv || !cipher) {
    return { ok: false, error: "The stored passkey unlock data is malformed." }
  }

  const key = await importPrfKey(prfOutput, subtle)
  try {
    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      cipher as unknown as BufferSource
    )
    const password = new TextDecoder().decode(plaintext)
    if (password.length === 0) {
      return { ok: false, error: "The stored passkey unlock data is malformed." }
    }
    return { ok: true, value: password }
  } catch {
    return { ok: false, error: "Passkey unlock failed. Use your vault password instead." }
  }
}

// ===== Stored envelope =====

/**
 * The stored passkey-unlock envelope, or null when absent or unreadable.
 *
 * Corrupt entries read as absent on purpose: the feature must degrade to
 * "passkey unlock unavailable, use your password", never crash a render, and
 * never be treated as a bypass.
 */
export function getPasskeyUnlockEnvelope(): PasskeyUnlockEnvelope | null {
  return readJson<PasskeyUnlockEnvelope | null>(
    STORAGE_KEYS.VAULT_PASSKEY,
    isPasskeyUnlockEnvelope,
    null
  )
}

/** Whether a valid passkey-unlock enrollment exists on this device. */
export function hasPasskeyUnlock(): boolean {
  return getPasskeyUnlockEnvelope() !== null
}

/**
 * Remove the passkey-unlock enrollment.
 *
 * Deletes the stored envelope. The credential itself is intentionally left on
 * the authenticator: without the envelope it wraps nothing and unlocks
 * nothing, and WebAuthn offers no reliable cross-browser way to delete a
 * credential from this side — users who want it gone can remove it in their
 * browser's passkey settings.
 */
export function removePasskeyUnlock(): void {
  removeKey(STORAGE_KEYS.VAULT_PASSKEY)
}

// ===== Ceremony plumbing =====

/**
 * The WebAuthn boundary, resolved at CALL time rather than import time.
 *
 * Server rendering and tests never touch a real authenticator; tests replace
 * `globalThis.navigator` with an honest fake that honours the same contract.
 */
function getCredentialsContainer(): CredentialsContainer | null {
  const nav = globalThis.navigator as { credentials?: CredentialsContainer } | undefined
  return nav?.credentials ?? null
}

/**
 * Structural check for a public-key credential.
 *
 * `instanceof PublicKeyCredential` would throw where the class is not defined
 * (server rendering, test fakes), so the shape is checked instead.
 */
function isPublicKeyCredential(value: Credential | null): value is PublicKeyCredential {
  if (value === null) return false
  return (
    value.type === "public-key" &&
    typeof (value as PublicKeyCredential).getClientExtensionResults === "function"
  )
}

/** Copy a BufferSource into plain bytes without aliasing an input view. */
function toBytes(source: BufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
}

/** Extract the 32-byte first PRF output from extension results, if present. */
function extractPrfBytes(
  results: AuthenticationExtensionsPRFValues | undefined
): Uint8Array | null {
  if (results === undefined) return null
  const first = results.first as unknown as BufferSource | undefined
  if (first === undefined) return null
  const bytes = toBytes(first)
  return bytes.length === PRF_KEY_BYTES ? bytes : null
}

/**
 * Map a WebAuthn ceremony error to a fixed, user-safe sentence.
 *
 * Only the error NAME is trusted: platform messages can embed request
 * parameters, so they are never surfaced raw (the original goes to the
 * redacting logger instead).
 */
function describeCeremonyError(error: unknown, fallback: string): string {
  const name =
    typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : ""

  switch (name) {
    case "NotAllowedError":
      return "The passkey prompt was cancelled or timed out."
    case "InvalidStateError":
      return "This device already holds a matching passkey. Remove it in your browser's passkey settings and try again."
    case "SecurityError":
      return "The passkey request was blocked by the browser."
    case "NotSupportedError":
    case "ConstraintError":
      return "This browser or device does not support passkey unlock."
    case "AbortError":
      return "The passkey request was aborted."
    default:
      return fallback
  }
}

/**
 * Run the assertion ceremony that evaluates a credential's PRF over a salt.
 *
 * Shared by enrollment (second ceremony) and unlock so both derive the key
 * identically. Exactly one allowCredential is passed, which is what lets the
 * `prf.eval` input apply unambiguously to that credential.
 *
 * @returns The 32-byte PRF output, or null when the ceremony completed but
 *   produced no usable PRF result.
 */
async function evaluatePrf(
  credentials: CredentialsContainer,
  credentialId: Uint8Array,
  salt: Uint8Array
): Promise<Uint8Array | null> {
  const assertion = await credentials.get({
    publicKey: {
      challenge: globalThis.crypto.getRandomValues(
        new Uint8Array(CHALLENGE_BYTES)
      ) as unknown as BufferSource,
      allowCredentials: [{ type: "public-key", id: credentialId as unknown as BufferSource }],
      userVerification: "required",
      extensions: {
        prf: { eval: { first: salt as unknown as BufferSource } },
      },
      timeout: CEREMONY_TIMEOUT_MS,
    },
  })
  if (!isPublicKeyCredential(assertion)) return null
  return extractPrfBytes(assertion.getClientExtensionResults().prf?.results)
}

// ===== Public ceremonies =====

/**
 * Create a passkey with the PRF extension and wrap the vault password under
 * the PRF-derived key.
 *
 * Only call while the vault is unlocked and the password has been VERIFIED
 * against the current vault (the UI re-asks for it, so mere access to an
 * unlocked screen can never enroll a passkey and thereby learn the password).
 * The ceremony:
 *
 * 1. `navigator.credentials.create` requesting `prf` WITH an `eval` — platforms
 *    that can evaluate during creation do so in one prompt.
 * 2. When creation returned no PRF result, a second `navigator.credentials.get`
 *    ceremony evaluates it — the platform-standard pattern, since several
 *    browsers only expose PRF outputs on the second ceremony.
 * 3. If neither yields 32 bytes, the environment cannot do PRF: report
 *    unsupported and persist nothing.
 *
 * Nothing is written until every step has succeeded, so a failed enrollment
 * cannot destroy a working one; a previously stored envelope (re-enrollment
 * attempt) simply stays valid.
 *
 * @param password - The CURRENT vault password, already verified by the caller.
 */
export async function enrollPasskeyUnlock(password: string): Promise<PasskeyResult<void>> {
  const credentials = getCredentialsContainer()
  const subtle = getSubtle()
  if (!credentials || !subtle) {
    return { ok: false, error: "Passkeys are unavailable in this browser." }
  }

  // Fresh randomness per enrollment. The salt fixes the PRF output for this
  // credential; a fresh user handle makes each enrollment a DISTINCT
  // credential, so re-enrolling never collides with a passkey the
  // authenticator already holds for this site.
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(PRF_SALT_BYTES))
  const userHandle = globalThis.crypto.getRandomValues(new Uint8Array(USER_HANDLE_BYTES))

  const rp: PublicKeyCredentialRpEntity = { name: RP_NAME }
  // WebAuthn scopes credentials to the site's registrable domain; deriving the
  // id from the hostname keeps dev, preview, and production deployments
  // separate. Omitted when no hostname exists so the browser default applies.
  if (typeof location !== "undefined" && location.hostname !== "") {
    rp.id = location.hostname
  }

  let created: PublicKeyCredential
  try {
    const credential = await credentials.create({
      publicKey: {
        challenge: globalThis.crypto.getRandomValues(
          new Uint8Array(CHALLENGE_BYTES)
        ) as unknown as BufferSource,
        rp,
        user: {
          id: userHandle as unknown as BufferSource,
          name: USER_DISPLAY_NAME,
          displayName: USER_DISPLAY_NAME,
        },
        pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key" as const, alg })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
        // Requesting `eval` here lets PRF-capable platforms evaluate during
        // creation; platforms without that support ignore it and the second
        // ceremony below takes over. Clients are required by the WebAuthn
        // spec's extension rules to ignore extension inputs they cannot
        // process rather than fail the ceremony.
        extensions: {
          prf: { eval: { first: salt as unknown as BufferSource } },
        },
        timeout: CEREMONY_TIMEOUT_MS,
      },
    })
    if (!isPublicKeyCredential(credential)) {
      return { ok: false, error: "This browser or device does not support passkeys." }
    }
    created = credential
  } catch (error) {
    logger.warn("Passkey enrollment ceremony failed", { error })
    return { ok: false, error: describeCeremonyError(error, "The passkey could not be created.") }
  }

  const creationPrf = created.getClientExtensionResults().prf
  if (creationPrf === undefined || creationPrf.enabled !== true) {
    // The browser or authenticator declined PRF. Nothing has been written and
    // nothing needs cleanup: this credential wraps nothing, and the password
    // path is untouched.
    return {
      ok: false,
      error:
        "This browser or authenticator does not support passkey unlock. Your password continues to work.",
    }
  }

  let prfBytes = extractPrfBytes(creationPrf.results)
  if (prfBytes === null) {
    // Several platforms only expose PRF outputs on the SECOND ceremony, so
    // evaluate now with the stored salt before persisting anything.
    try {
      prfBytes = await evaluatePrf(credentials, toBytes(created.rawId), salt)
    } catch (error) {
      logger.warn("Passkey PRF evaluation failed during enrollment", { error })
      return { ok: false, error: describeCeremonyError(error, "The passkey could not be used.") }
    }
  }

  if (prfBytes === null) {
    return {
      ok: false,
      error:
        "This browser or authenticator does not support passkey unlock. Your password continues to work.",
    }
  }

  const wrapped = await wrapPasswordWithPrf(prfBytes, password)
  if (!wrapped.ok) return wrapped

  const record: PasskeyUnlockEnvelope = {
    version: PASSKEY_ENVELOPE_VERSION,
    credentialId: toBase64(toBytes(created.rawId)),
    salt: toBase64(salt),
    userHandle: toBase64(userHandle),
    envelope: wrapped.value,
  }

  const written = writeJson(STORAGE_KEYS.VAULT_PASSKEY, record)
  if (!written.ok) return { ok: false, error: written.error }

  return { ok: true, value: undefined }
}

/**
 * Run the passkey ceremony and unwrap the vault password.
 *
 * @returns The password for the caller to feed IMMEDIATELY into
 *   `unlockVault`; the caller should then let it go out of scope. A stale wrap
 *   (the vault password changed since enrollment) is the caller's to detect —
 *   the returned password simply fails `unlockVault`, which must be surfaced
 *   as "passkey unlock no longer matches this vault" with an offer to
 *   re-enroll, never as a silent failure of the password path.
 */
export async function unlockWithPasskey(): Promise<PasskeyResult<string>> {
  const credentials = getCredentialsContainer()
  if (!credentials) {
    return { ok: false, error: "Passkeys are unavailable in this browser." }
  }

  const record = getPasskeyUnlockEnvelope()
  if (record === null) {
    return { ok: false, error: "Passkey unlock is not set up on this device." }
  }

  const credentialId = decodeBase64Min(record.credentialId, 16)
  const salt = decodeBase64Exact(record.salt, PRF_SALT_BYTES)
  if (!credentialId || !salt) {
    // The schema guard passed but the bytes are wrong (e.g. a hand-edited
    // entry). Degrade to password unlock rather than attempting anything.
    return {
      ok: false,
      error: "The stored passkey unlock data is malformed. Use your vault password.",
    }
  }

  let prfBytes: Uint8Array | null
  try {
    prfBytes = await evaluatePrf(credentials, credentialId, salt)
  } catch (error) {
    logger.warn("Passkey unlock ceremony failed", { error })
    return { ok: false, error: describeCeremonyError(error, "The passkey could not be used.") }
  }

  if (prfBytes === null) {
    // The ceremony completed but produced no PRF output: the browser lost PRF
    // support for this credential, or the extension was ignored.
    return {
      ok: false,
      error:
        "This browser or authenticator does not support passkey unlock. Use your vault password.",
    }
  }

  return unwrapPasswordWithPrf(prfBytes, record.envelope)
}
