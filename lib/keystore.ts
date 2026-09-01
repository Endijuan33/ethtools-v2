/**
 * Keystore V3 (Web3 Secret Storage) import and export.
 *
 * The V3 keystore is the de-facto interchange format for a single Ethereum
 * private key: geth, MetaMask, MyCrypto, and most hardware-wallet companions
 * read and write it. It is a *different* format from this app's own vault
 * envelope (`lib/vault.ts`, PBKDF2 -> AES-256-GCM). V3 mandates AES-128-CTR,
 * which has no built-in authentication, so integrity comes from a keccak-256
 * MAC over the second half of the derived key and the ciphertext. WebCrypto
 * provides the KDF and the cipher but not keccak, so the MAC uses ethers'
 * `keccak256` — the one deliberate dependency outside WebCrypto. The two
 * modules share only the environment check and the password policy, never
 * encryption code.
 *
 * Security ordering in {@link decryptKeystore}: validate the untrusted JSON
 * shape, derive the key, verify the MAC, and only then decrypt. A wrong
 * password or an edited file therefore fails the MAC check and can never
 * yield a plausible-looking private key. No key, password, or derived
 * material is logged or persisted here; a decrypted key is returned to the
 * caller and to no one else.
 */

import { concat, getBytes, isHexString, keccak256, Wallet } from "ethers"
import { isVaultSupported, MIN_PASSWORD_LENGTH } from "./vault"

/**
 * PBKDF2 iteration count for keystores this app writes.
 *
 * 310,000 is a documented OWASP Password Storage Cheat Sheet figure for
 * PBKDF2-HMAC-SHA256 (the vault's at-rest envelope commits to the same cheat
 * sheet's newer 600,000 number). The difference is a deliberate tradeoff:
 * unlike the vault — which only this app ever unlocks, on this device — a V3
 * keystore is an interchange file that third-party wallets open on whatever
 * device holds it, frequently a phone where a 600,000-round PBKDF2 makes the
 * unlock feel broken. 310,000 still exceeds the iteration counts found in
 * real-world pbkdf2 keystores (65k-262k) by a wide margin, so a stolen file
 * remains far beyond cheap offline guessing.
 */
export const KEYSTORE_PBKDF2_ITERATIONS = 310_000

/**
 * Bounds accepted when *reading* `kdfparams.c` from an untrusted keystore.
 *
 * The floor is far lower than the vault's 100,000 on purpose: keystrokes
 * exported by other tools legitimately carry c as low as 1024, and refusing
 * them would break imports of files this app never created. The bounds exist
 * to stop hostile values — a billion iterations would wedge the tab, and
 * near-zero iterations would make a stolen file trivially brute-forceable
 * through this app.
 */
export const MIN_KEYSTORE_ITERATIONS = 1_000
export const MAX_KEYSTORE_ITERATIONS = 5_000_000

/** Largest keystore JSON accepted on import. A real V3 file is under 2 KB. */
export const MAX_KEYSTORE_BYTES = 64 * 1024

const SALT_BYTES = 32
const MIN_SALT_BYTES = 16
const MAX_SALT_BYTES = 64
const IV_BYTES = 16
const KEY_BYTES = 32
const DK_BYTES = 32
const MAC_BYTES = 32

/** Outcome of an operation driven by user input. */
export type KeystoreResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** A V3 keystore file. Hex fields carry no `0x` prefix in files we write. */
export interface V3Keystore {
  version: 3
  /** UUID identifying the file. */
  id: string
  /** Account address: 40 hex characters, lowercase, no `0x` prefix. */
  address: string
  crypto: {
    /** Hex-encoded encrypted private key (32 bytes for secp256k1). */
    ciphertext: string
    cipher: string
    cipherparams: { iv: string }
    kdf: string
    /**
     * PBKDF2 fields when `kdf` is "pbkdf2"; scrypt keystores carry n/r/p
     * instead. Only loosely typed — the strict pbkdf2 shape is enforced by
     * {@link decryptKeystore}, which also produces the errors that name
     * exactly which field failed.
     */
    kdfparams: {
      prf?: string
      c?: number
      dklen?: number
      salt?: string
      n?: number
      r?: number
      p?: number
    }
    /** keccak256 of dk[16..32] || ciphertext, hex-encoded. */
    mac: string
  }
}

/** A private key recovered from a keystore. The key is secret; the address is not. */
export interface RecoveredKeystoreAccount {
  /** Checksummed address derived from the recovered key. */
  address: string
  /** `0x`-prefixed private key. */
  privateKey: string
}

/** Overridable entropy and cost for {@link encryptKeystore}. Random by default. */
export interface EncryptKeystoreOptions {
  /** PBKDF2 iterations. Defaults to {@link KEYSTORE_PBKDF2_ITERATIONS}. */
  iterations?: number
  /** Salt bytes. Defaults to 32 random bytes. */
  salt?: Uint8Array
  /** Exactly 16 bytes. Defaults to random. */
  iv?: Uint8Array
  /** File UUID. Defaults to a random RFC 4122 v4 UUID. */
  id?: string
}

// ===== Encoding helpers =====

/** Encode bytes as lowercase hex without the `0x` prefix, as the V3 format requires. */
function toHex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0")
  }
  return out
}

/**
 * Decode hex into bytes, tolerating an optional `0x` prefix (some exporters
 * emit one) and requiring between `minBytes` and `maxBytes`.
 *
 * Returns null rather than throwing: an imported keystore is untrusted input
 * and a bad field is a user-facing error, not an exception.
 */
function fromHex(value: string, minBytes: number, maxBytes: number): Uint8Array | null {
  const body = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value
  if (body.length % 2 !== 0) return null
  if (body.length < minBytes * 2 || body.length > maxBytes * 2) return null
  if (!/^[0-9a-fA-F]+$/.test(body)) return null

  const bytes = new Uint8Array(body.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Length-safe, constant-time byte comparison.
 *
 * The MAC check compares a derived secret against a value read from an
 * untrusted file; a naive early-exit comparison would leak how many leading
 * bytes matched.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
}

/** A random RFC 4122 v4 UUID, with a manual fallback for older WebViews. */
function randomUuid(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === "function") return c.randomUUID()

  const bytes = c.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function getSubtle(): SubtleCrypto | null {
  const c = globalThis.crypto
  return c && "subtle" in c ? c.subtle : null
}

// ===== Core crypto =====

/**
 * Derive the 32-byte V3 derived key: PBKDF2-HMAC-SHA256(password, salt, c).
 *
 * `deriveBits` rather than `deriveKey` because the V3 format needs the raw
 * bytes: the first 16 feed AES-128 and the last 16 feed the MAC, which no
 * single WebCrypto key object can express.
 */
async function deriveDk(
  password: string,
  salt: Uint8Array,
  iterations: number,
  subtle: SubtleCrypto
): Promise<Uint8Array> {
  const material = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      // BufferSource is structurally satisfied by Uint8Array at runtime; the
      // cast keeps TS happy across lib.dom versions that narrow to ArrayBuffer.
      salt: salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    material,
    DK_BYTES * 8
  )
  return new Uint8Array(bits)
}

/**
 * AES-128-CTR over exactly the given bytes.
 *
 * The 16-byte IV is used as the initial counter block, per the V3 spec. A
 * secp256k1 key is 32 bytes (two blocks), so the counter increments once and
 * the 64-bit counter width can never wrap.
 */
async function aesCtr(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
  subtle: SubtleCrypto,
  usage: "encrypt" | "decrypt"
): Promise<Uint8Array> {
  const cryptoKey = await subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "AES-CTR", length: 128 },
    false,
    [usage]
  )
  const params = { name: "AES-CTR", counter: iv as unknown as BufferSource, length: 64 }
  const out =
    usage === "encrypt"
      ? await subtle.encrypt(params, cryptoKey, data as unknown as BufferSource)
      : await subtle.decrypt(params, cryptoKey, data as unknown as BufferSource)
  return new Uint8Array(out)
}

/**
 * Normalize and validate a hex private key into the wallet it controls.
 *
 * Returns a result rather than throwing so callers can surface a precise
 * error instead of an ethers stack trace.
 */
function walletFromPrivateKey(privateKey: string): KeystoreResult<Wallet> {
  const trimmed = privateKey.trim()
  const normalized = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed : `0x${trimmed}`
  if (!isHexString(normalized, KEY_BYTES)) {
    return { ok: false, error: "A private key must be 64 hexadecimal characters." }
  }
  try {
    return { ok: true, value: new Wallet(normalized) }
  } catch {
    return { ok: false, error: "This is not a valid private key." }
  }
}

// ===== Type guard =====

/**
 * Structural check that an unknown JSON value is a V3 keystore.
 *
 * Deliberately accepts both spec KDFs and validates only field shapes, not
 * hex contents: a scrypt keystore from geth *is* a V3 keystore, and the import
 * flow must recognize it so {@link decryptKeystore} can explain precisely why
 * it cannot be opened, rather than claiming the file is unrecognizable.
 * Deep validation (hex, lengths, bounds, MAC) belongs to the decrypt path,
 * which produces the errors that name the failing field.
 */
export function isV3Keystore(value: unknown): value is V3Keystore {
  if (typeof value !== "object" || value === null) return false
  const k = value as Record<string, unknown>
  if (k.version !== 3) return false
  if (typeof k.id !== "string" || k.id.length === 0 || k.id.length > 128) return false
  if (typeof k.address !== "string" || !/^(0x)?[0-9a-fA-F]{40}$/.test(k.address)) return false

  const c = k.crypto
  if (typeof c !== "object" || c === null) return false
  const crypto = c as Record<string, unknown>
  const cipherparams = crypto.cipherparams as Record<string, unknown> | undefined
  return (
    typeof crypto.ciphertext === "string" &&
    typeof crypto.cipher === "string" &&
    typeof cipherparams === "object" &&
    cipherparams !== null &&
    typeof cipherparams.iv === "string" &&
    typeof crypto.kdf === "string" &&
    typeof crypto.kdfparams === "object" &&
    crypto.kdfparams !== null &&
    typeof crypto.mac === "string"
  )
}

// ===== Export =====

/**
 * Encrypt one private key into a V3 keystore JSON object.
 *
 * The address is computed from the key itself, so the file can never claim an
 * account the key does not control. Salt, IV, and UUID are fresh per file;
 * the optional overrides exist for deterministic tests, never for callers
 * that want to reuse entropy.
 *
 * @param privateKey - Hex private key, with or without the `0x` prefix.
 * @param password - Passphrase protecting the file. Rejected below the vault
 *   minimum, because a keystore protects funds exactly like the vault does.
 * @param options - Deterministic overrides for tests.
 * @returns The keystore object, ready to serialize and download.
 */
export async function encryptKeystore(
  privateKey: string,
  password: string,
  options: EncryptKeystoreOptions = {}
): Promise<KeystoreResult<V3Keystore>> {
  const subtle = getSubtle()
  if (subtle === null || !isVaultSupported()) {
    return {
      ok: false,
      error:
        "Encryption is unavailable in this browser. A secure (HTTPS) connection is required.",
    }
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    }
  }

  const wallet = walletFromPrivateKey(privateKey)
  if (!wallet.ok) return wallet

  // Explicit values are honored exactly (not clamped): an out-of-range request
  // is a programming error and should fail loudly, not silently produce a
  // weaker or stronger file than the caller asked for.
  const iterations = options.iterations ?? KEYSTORE_PBKDF2_ITERATIONS
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < MIN_KEYSTORE_ITERATIONS ||
    iterations > MAX_KEYSTORE_ITERATIONS
  ) {
    return {
      ok: false,
      error: `Iterations must be a whole number between ${MIN_KEYSTORE_ITERATIONS.toLocaleString()} and ${MAX_KEYSTORE_ITERATIONS.toLocaleString()}.`,
    }
  }

  const salt = options.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES) {
    return {
      ok: false,
      error: `The salt must be between ${MIN_SALT_BYTES} and ${MAX_SALT_BYTES} bytes.`,
    }
  }

  const iv = options.iv ?? globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  if (iv.length !== IV_BYTES) {
    return { ok: false, error: `The IV must be exactly ${IV_BYTES} bytes.` }
  }

  const id = options.id ?? randomUuid()
  if (id.length === 0 || id.length > 128) {
    return { ok: false, error: "The keystore id must be a non-empty string." }
  }

  const dk = await deriveDk(password, salt, iterations, subtle)

  // A secp256k1 key is exactly 32 bytes, so the ciphertext carries no padding.
  const ciphertext = await aesCtr(
    dk.subarray(0, 16),
    iv,
    getBytes(wallet.value.privateKey),
    subtle,
    "encrypt"
  )

  // MAC per spec: keccak256 over the MAC half of the derived key and the
  // ciphertext. This is what makes a wrong password detectable before decrypt.
  const mac = keccak256(concat([dk.subarray(16, DK_BYTES), ciphertext]))

  return {
    ok: true,
    value: {
      version: 3,
      id,
      // Spec: lowercase hex, no 0x prefix.
      address: wallet.value.address.slice(2).toLowerCase(),
      crypto: {
        ciphertext: toHex(ciphertext),
        cipher: "aes-128-ctr",
        cipherparams: { iv: toHex(iv) },
        kdf: "pbkdf2",
        kdfparams: {
          prf: "hmac-sha256",
          c: iterations,
          dklen: DK_BYTES,
          salt: toHex(salt),
        },
        mac: mac.slice(2).toLowerCase(),
      },
    },
  }
}

/**
 * Suggested download filename for a keystore, named after its account so a
 * folder of exports stays unambiguous. Mirrors `backupFilename` in lib/backup.
 */
export function keystoreFilename(keystore: V3Keystore): string {
  return `keystore-${keystore.address}.json`
}

// ===== Import =====

/**
 * Decrypt a V3 keystore and recover its private key.
 *
 * Order of operations is security-critical and must not be reordered:
 * 1. Validate the untrusted JSON shape and every parameter bound.
 * 2. Derive the key with the file's own PBKDF2 parameters.
 * 3. Verify the MAC — a wrong password or an edited file fails here, before
 *    any decryption is attempted, so a garbage key can never be produced.
 * 4. Only then decrypt, and re-derive the address to cross-check the file.
 *
 * Scrypt keystores are rejected with an error naming the limitation, because
 * scrypt in a browser tab is a memory-denial-of-service hazard and the app
 * deliberately does not ship it.
 *
 * @param keystore - Untrusted parsed JSON, typically from a user file.
 * @param password - The password the file was created with.
 * @returns The recovered key and its address, for the caller to handle. The
 *   key is never displayed, logged, or persisted by this module.
 */
export async function decryptKeystore(
  keystore: unknown,
  password: string
): Promise<KeystoreResult<RecoveredKeystoreAccount>> {
  const subtle = getSubtle()
  if (subtle === null || !isVaultSupported()) {
    return {
      ok: false,
      error:
        "Decryption is unavailable in this browser. A secure (HTTPS) connection is required.",
    }
  }

  if (!isV3Keystore(keystore)) {
    return { ok: false, error: "This file is not a recognized keystore (V3) file." }
  }

  // KDF and cipher are checked before any expensive work so unsupported files
  // fail fast with an actionable message instead of an opaque crypto error.
  if (keystore.crypto.kdf === "scrypt") {
    return {
      ok: false,
      error:
        "This keystore uses the scrypt key-derivation function, which this app cannot derive. Re-export the account from its original wallet as a recovery phrase, a raw private key, or a PBKDF2 keystore, then import that instead.",
    }
  }
  if (keystore.crypto.kdf !== "pbkdf2") {
    return {
      ok: false,
      error: `This keystore uses the "${keystore.crypto.kdf}" key-derivation function. Only pbkdf2 (hmac-sha256) keystores are supported.`,
    }
  }
  if (keystore.crypto.cipher !== "aes-128-ctr") {
    return {
      ok: false,
      error: `This keystore uses the "${keystore.crypto.cipher}" cipher. Only aes-128-ctr is supported.`,
    }
  }

  const kdfparams = keystore.crypto.kdfparams
  if (kdfparams.prf !== "hmac-sha256") {
    return {
      ok: false,
      error: `This keystore's kdfparams prf is ${JSON.stringify(kdfparams.prf) ?? "missing"}, but only "hmac-sha256" is supported.`,
    }
  }
  if (kdfparams.dklen !== DK_BYTES) {
    return {
      ok: false,
      error: `This keystore's kdfparams dklen is ${JSON.stringify(kdfparams.dklen) ?? "missing"}; only 32 is supported.`,
    }
  }
  const c = kdfparams.c
  if (
    typeof c !== "number" ||
    !Number.isInteger(c) ||
    c < MIN_KEYSTORE_ITERATIONS ||
    c > MAX_KEYSTORE_ITERATIONS
  ) {
    return {
      ok: false,
      error: "This keystore declares an unsafe or hostile PBKDF2 iteration count and was rejected.",
    }
  }

  const salt = fromHex(kdfparams.salt ?? "", MIN_SALT_BYTES, MAX_SALT_BYTES)
  const iv = fromHex(keystore.crypto.cipherparams.iv, IV_BYTES, IV_BYTES)
  // A secp256k1 key is exactly 32 bytes, so a valid ciphertext is too.
  const ciphertext = fromHex(keystore.crypto.ciphertext, KEY_BYTES, KEY_BYTES)
  const mac = fromHex(keystore.crypto.mac, MAC_BYTES, MAC_BYTES)
  if (!salt || !iv || !ciphertext || !mac) {
    return {
      ok: false,
      error: "This keystore file is malformed: a hex field is missing or has the wrong length.",
    }
  }

  const dk = await deriveDk(password, salt, c, subtle)

  // MAC first, always. A wrong password or an edited file must fail here,
  // before any decryption is attempted, so it can never yield a garbage key
  // that merely looks like a private key.
  const computedMac = getBytes(keccak256(concat([dk.subarray(16, DK_BYTES), ciphertext])))
  if (!constantTimeEqual(computedMac, mac)) {
    return {
      ok: false,
      error: "Incorrect keystore password, or the keystore file has been modified.",
    }
  }

  const plaintext = await aesCtr(dk.subarray(0, 16), iv, ciphertext, subtle, "decrypt")
  if (plaintext.length !== KEY_BYTES) {
    return {
      ok: false,
      error: "The keystore decrypted to something other than a private key.",
    }
  }

  const privateKey = `0x${toHex(plaintext)}`
  let wallet: Wallet
  try {
    wallet = new Wallet(privateKey)
  } catch {
    return {
      ok: false,
      error: "The keystore decrypted, but the recovered data is not a valid private key.",
    }
  }

  // The address in the file is the one every other wallet will display for it.
  // If it disagrees with the key the file actually contains, the file was
  // edited or corrupted, and importing it would mislabel the account.
  const fileAddress = keystore.address.replace(/^0x/i, "").toLowerCase()
  const derivedAddress = wallet.address.replace(/^0x/i, "").toLowerCase()
  if (derivedAddress !== fileAddress) {
    return {
      ok: false,
      error: `The address in this keystore (0x${fileAddress}) does not match the key it contains (${wallet.address}). The file may have been edited or corrupted.`,
    }
  }

  return { ok: true, value: { address: wallet.address, privateKey: wallet.privateKey } }
}
