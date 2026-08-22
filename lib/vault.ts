/**
 * Client-side encryption primitives for secret material at rest.
 *
 * Everything here runs in the browser via WebCrypto. No key, password, or
 * derived material is ever transmitted, logged, or persisted in cleartext.
 *
 * Format: PBKDF2-HMAC-SHA256 -> AES-256-GCM. GCM is authenticated, so a wrong
 * password or a tampered payload fails decryption rather than yielding garbage.
 */

/** Current envelope format version. Bump on any breaking format change. */
export const VAULT_FORMAT_VERSION = 1

/**
 * PBKDF2 iteration count for newly created envelopes.
 * Follows the OWASP recommendation for PBKDF2-HMAC-SHA256.
 */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000

/**
 * Accepted iteration bounds when *reading* an envelope.
 *
 * An imported file is untrusted input: without an upper bound a hostile backup
 * could specify a billion iterations and wedge the browser on the main thread.
 * The lower bound stops a downgrade attack that would make a stolen file cheap
 * to brute-force.
 */
export const MIN_PBKDF2_ITERATIONS = 100_000
export const MAX_PBKDF2_ITERATIONS = 5_000_000

const SALT_BYTES = 16
const IV_BYTES = 12
const AES_KEY_BITS = 256

/** An encrypted payload, safe to write to disk or embed in a QR code. */
export interface EncryptedEnvelope {
  /** Envelope format version. */
  v: number
  /** Key derivation function identifier. */
  kdf: "PBKDF2"
  /** PBKDF2 digest. */
  hash: "SHA-256"
  /** PBKDF2 iteration count used to derive the key. */
  iterations: number
  /** Base64 PBKDF2 salt. */
  salt: string
  /** Base64 AES-GCM initialization vector. */
  iv: string
  /** Base64 AES-GCM ciphertext with the authentication tag appended. */
  cipher: string
}

/** Outcome of an operation driven by user input. */
export type VaultResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; reason: VaultFailureReason }

/** Why a vault operation failed, for callers that need to branch. */
export type VaultFailureReason =
  | "unsupported-environment"
  | "weak-password"
  | "malformed-envelope"
  | "unsupported-version"
  | "iterations-out-of-range"
  | "wrong-password"
  | "corrupt-payload"

// ===== Encoding helpers =====

/**
 * Encode bytes as base64 using only APIs present in both browsers and Node.
 * Chunked to avoid building an oversized intermediate string.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk)
    for (let j = 0; j < slice.length; j++) {
      binary += String.fromCharCode(slice[j])
    }
  }
  return btoa(binary)
}

/**
 * Decode base64 to bytes.
 * @throws {Error} If the input is not valid base64.
 */
function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * WebCrypto rejects a zero-length AES-GCM payload, and an empty salt/IV would
 * silently weaken the scheme, so treat empty base64 fields as malformed.
 */
function decodeRequiredBase64(value: string, min: number): Uint8Array | null {
  try {
    const bytes = fromBase64(value)
    return bytes.length >= min ? bytes : null
  } catch {
    return null
  }
}

// ===== Environment =====

function getSubtle(): SubtleCrypto | null {
  const c = globalThis.crypto
  return c && "subtle" in c ? c.subtle : null
}

/**
 * Whether encryption is available in the current environment.
 *
 * WebCrypto requires a secure context, so this is false on plain http:// pages
 * other than localhost. Callers must surface that rather than silently falling
 * back to storing cleartext.
 */
export function isVaultSupported(): boolean {
  return getSubtle() !== null && typeof globalThis.crypto?.getRandomValues === "function"
}

// ===== Password strength =====

/** A qualitative password assessment shown next to the password field. */
export interface PasswordAssessment {
  /** 0-4, where 0 is unusable and 4 is strong. */
  score: 0 | 1 | 2 | 3 | 4
  /** Short English label for the score. */
  label: string
  /** Concrete, actionable suggestions. Empty when the password is strong. */
  issues: string[]
  /** Whether the password clears the minimum bar for encrypting funds. */
  acceptable: boolean
}

/** Minimum password length accepted when creating a vault. */
export const MIN_PASSWORD_LENGTH = 10

/**
 * Assess a password for use as a vault passphrase.
 *
 * Deliberately heuristic and offline: no wordlist is shipped and nothing is
 * sent anywhere. The goal is to steer users away from trivially guessable
 * passwords, not to compute true entropy.
 */
export function assessPassword(password: string): PasswordAssessment {
  const issues: string[] = []

  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    issues.push("Mix uppercase and lowercase letters.")
  }
  if (!/[0-9]/.test(password)) {
    issues.push("Add at least one number.")
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    issues.push("Add at least one symbol.")
  }
  if (/^(.)\1*$/.test(password) && password.length > 0) {
    issues.push("Avoid repeating a single character.")
  }

  let score = 0
  if (password.length >= MIN_PASSWORD_LENGTH) score++
  if (password.length >= 16) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) score++

  const clamped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4
  const labels = ["Unusable", "Weak", "Fair", "Good", "Strong"] as const

  return {
    score: clamped,
    label: labels[clamped],
    issues,
    acceptable: password.length >= MIN_PASSWORD_LENGTH && issues.length === 0,
  }
}

// ===== Core crypto =====

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  subtle: SubtleCrypto
): Promise<CryptoKey> {
  const material = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  )

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      // BufferSource is structurally satisfied by Uint8Array at runtime; the
      // cast keeps TS happy across lib.dom versions that narrow to ArrayBuffer.
      salt: salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false,
    ["encrypt", "decrypt"]
  )
}

/**
 * Structural check that an unknown value is a well-formed envelope.
 *
 * Used to tell an encrypted backup from a legacy cleartext one, and to reject
 * malformed input before touching WebCrypto.
 */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== "object" || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.v === "number" &&
    e.kdf === "PBKDF2" &&
    e.hash === "SHA-256" &&
    typeof e.iterations === "number" &&
    Number.isInteger(e.iterations) &&
    typeof e.salt === "string" &&
    typeof e.iv === "string" &&
    typeof e.cipher === "string"
  )
}

/**
 * Encrypt a JSON-serializable value under a password.
 *
 * @param data - Value to encrypt. Must be JSON-serializable.
 * @param password - User passphrase. Rejected if below the minimum length.
 * @param iterations - PBKDF2 iterations. Defaults to {@link DEFAULT_PBKDF2_ITERATIONS}.
 * @returns The envelope, or a failure describing what to fix.
 */
export async function encryptJson<T>(
  data: T,
  password: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<VaultResult<EncryptedEnvelope>> {
  const subtle = getSubtle()
  if (!subtle) {
    return {
      ok: false,
      reason: "unsupported-environment",
      error:
        "Encryption is unavailable in this browser. A secure (HTTPS) connection is required.",
    }
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: "weak-password",
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    }
  }

  const safeIterations = Math.min(
    MAX_PBKDF2_ITERATIONS,
    Math.max(MIN_PBKDF2_ITERATIONS, Math.floor(iterations))
  )

  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(password, salt, safeIterations, subtle)

  const plaintext = new TextEncoder().encode(JSON.stringify(data))
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    plaintext as unknown as BufferSource
  )

  return {
    ok: true,
    value: {
      v: VAULT_FORMAT_VERSION,
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: safeIterations,
      salt: toBase64(salt),
      iv: toBase64(iv),
      cipher: toBase64(new Uint8Array(cipher)),
    },
  }
}

/**
 * Decrypt an envelope produced by {@link encryptJson}.
 *
 * A wrong password is indistinguishable from a tampered payload at the crypto
 * layer (both fail the GCM tag check), so both map to `wrong-password`, which
 * is the overwhelmingly likely cause in practice.
 *
 * @param envelope - Untrusted envelope, typically parsed from a user file.
 * @param password - Candidate passphrase.
 * @returns The decrypted value, or a failure describing the cause.
 */
export async function decryptJson<T>(
  envelope: unknown,
  password: string
): Promise<VaultResult<T>> {
  const subtle = getSubtle()
  if (!subtle) {
    return {
      ok: false,
      reason: "unsupported-environment",
      error:
        "Decryption is unavailable in this browser. A secure (HTTPS) connection is required.",
    }
  }

  if (!isEncryptedEnvelope(envelope)) {
    return {
      ok: false,
      reason: "malformed-envelope",
      error: "This file is not a recognized encrypted backup.",
    }
  }

  if (envelope.v !== VAULT_FORMAT_VERSION) {
    return {
      ok: false,
      reason: "unsupported-version",
      error: `Unsupported backup format version ${envelope.v}. This app supports version ${VAULT_FORMAT_VERSION}.`,
    }
  }

  if (
    envelope.iterations < MIN_PBKDF2_ITERATIONS ||
    envelope.iterations > MAX_PBKDF2_ITERATIONS
  ) {
    return {
      ok: false,
      reason: "iterations-out-of-range",
      error: "This backup declares an unsafe key-derivation cost and was rejected.",
    }
  }

  const salt = decodeRequiredBase64(envelope.salt, SALT_BYTES)
  const iv = decodeRequiredBase64(envelope.iv, IV_BYTES)
  const cipher = decodeRequiredBase64(envelope.cipher, 1)
  if (!salt || !iv || !cipher) {
    return {
      ok: false,
      reason: "malformed-envelope",
      error: "This backup file is malformed or incomplete.",
    }
  }

  const key = await deriveKey(password, salt, envelope.iterations, subtle)

  let plaintext: ArrayBuffer
  try {
    plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      cipher as unknown as BufferSource
    )
  } catch {
    return {
      ok: false,
      reason: "wrong-password",
      error: "Incorrect password, or the backup file has been modified.",
    }
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(plaintext)) as T }
  } catch {
    return {
      ok: false,
      reason: "corrupt-payload",
      error: "The backup decrypted but its contents are not valid JSON.",
    }
  }
}
