/**
 * EIP-191 `personal_sign` message signing and verification.
 *
 * Everything here runs locally against ethers v6: no provider, no network, no
 * persistence. The private key is accepted as an argument, used once, and never
 * embedded in an error message — a failed sign must not echo the key back into
 * the DOM.
 *
 * This module also owns the input normalization shared by both signing tools
 * (private keys, addresses, and 65-byte signatures), so `signTypedData.ts`
 * imports it rather than re-deriving subtly different rules.
 */

import { Wallet, getAddress, hashMessage, verifyMessage } from "ethers"

// ===== Result types =====

/**
 * Outcome of an operation that can legitimately fail because of user input.
 *
 * On failure, `error` is a complete, user-presentable English sentence.
 */
export type SignResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** What a verification concluded about the recovered signer. */
export interface Verification {
  /** The checksummed address recovered from the signature. */
  recovered: string
  /** Whether `recovered` equals the expected address. */
  matches: boolean
}

// ===== Shared input normalization =====

/**
 * Largest message accepted for signing or verifying, in UTF-8 bytes.
 *
 * personal_sign has no protocol limit, but an unbounded textarea would let a
 * multi-megabyte paste freeze the main thread during hashing and, more
 * importantly, let someone sign a blob they clearly have not read. 10 KB is far
 * beyond any human-readable message.
 */
export const MAX_MESSAGE_BYTES = 10 * 1024

/**
 * Measure a string in UTF-8 bytes.
 *
 * `string.length` counts UTF-16 code units, so "é" reports 1 but occupies 2
 * bytes on the wire; the cap must be enforced on the encoded size.
 *
 * @param text - The text to measure
 * @returns The length of the UTF-8 encoding, in bytes
 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/**
 * Normalize and structurally validate a pasted private key.
 *
 * Whitespace is collapsed and an optional `0x` prefix is added, mirroring how
 * the converter accepts keys. Only the shape is checked here: whether the scalar
 * is usable for signing is enforced by the `Wallet` constructor at sign time.
 * The error messages deliberately never include the input.
 *
 * @param input - Raw key text, with or without the `0x` prefix
 * @returns The normalized `0x`-prefixed key, or a failure carrying a user-presentable message
 */
export function normalizePrivateKey(input: string): SignResult<string> {
  const normalized = input.trim().replace(/\s+/g, "")
  if (normalized === "") {
    return { ok: false, error: "Enter a private key." }
  }
  const withPrefix = /^0x/i.test(normalized) ? normalized : `0x${normalized}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    return {
      ok: false,
      error: "A private key must be 64 hexadecimal characters, with or without the 0x prefix.",
    }
  }
  return { ok: true, value: withPrefix.toLowerCase() }
}

/**
 * Normalize and validate an address, returning its EIP-55 checksummed form.
 *
 * A checksum is not required, but ethers rejects a mixed-case address whose
 * checksum is wrong, which is exactly the typo this catches before a
 * verification reports a confusing mismatch.
 *
 * @param input - Raw address text
 * @returns The checksummed address, or a failure carrying a user-presentable message
 */
export function normalizeAddress(input: string): SignResult<string> {
  const trimmed = input.trim()
  if (trimmed === "") {
    return { ok: false, error: "Enter an Ethereum address." }
  }
  try {
    return { ok: true, value: getAddress(trimmed) }
  } catch {
    // ethers accepts all-lowercase or all-uppercase without a checksum check,
    // so reaching here with a 40-hex-digit shape means the checksum is wrong.
    if (/^(0x)?[0-9a-fA-F]{40}$/.test(trimmed)) {
      return {
        ok: false,
        error: "This address is mixed-case but its EIP-55 checksum is invalid. Check for a mistyped character.",
      }
    }
    return {
      ok: false,
      error: "An address must be 0x followed by 40 hexadecimal characters.",
    }
  }
}

/**
 * Normalize a pasted ECDSA signature.
 *
 * Whitespace is stripped because signatures survive copy-paste with line
 * breaks. Both the standard 65-byte (r, s, v) form and the 64-byte EIP-2098
 * compact form are accepted; ethers can recover from either.
 *
 * @param input - Raw signature text
 * @returns The lowercase `0x`-prefixed signature, or a failure carrying a user-presentable message
 */
export function normalizeSignature(input: string): SignResult<string> {
  const compact = input.replace(/\s+/g, "").replace(/^0[xX]/, "")
  // 128 or 130 hex digits: the compact 64-byte or standard 65-byte form.
  if (!/^[0-9a-fA-F]+$/.test(compact) || ![128, 130].includes(compact.length)) {
    return {
      ok: false,
      error:
        "A signature must be 65 bytes of hexadecimal (0x followed by 130 characters); the compact 64-byte form is also accepted.",
    }
  }
  return { ok: true, value: `0x${compact.toLowerCase()}` }
}

// ===== personal_sign =====

/**
 * Compute the EIP-191 digest a wallet signs for a text message.
 *
 * Exposed so the UI can show what is actually hashed — the message the user
 * reads is prefixed with `"\x19Ethereum Signed Message:\n"` and its byte length
 * before keccak256, and making that visible discourages trusting a signature
 * over a message that was never displayed.
 *
 * @param message - The message text, encoded as UTF-8
 * @returns The 32-byte digest as `0x`-prefixed hex
 */
export function hashPersonalMessage(message: string): string {
  return hashMessage(message)
}

/**
 * Sign a message with EIP-191 `personal_sign`.
 *
 * The key never leaves this call: it is turned into an offline `Wallet`, used
 * once, and dropped. Deterministic (RFC 6979) nonces mean the same key and
 * message always produce the same signature.
 *
 * @param privateKey - The key text; see {@link normalizePrivateKey}
 * @param message - The message to sign
 * @returns The 65-byte signature as `0x`-prefixed hex, or a failure carrying a user-presentable message
 */
export async function signPersonalMessage(
  privateKey: string,
  message: string
): Promise<SignResult<string>> {
  if (message === "") {
    return { ok: false, error: "Enter a message to sign." }
  }
  const bytes = utf8ByteLength(message)
  if (bytes > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      error: `The message is ${(bytes / 1024).toFixed(1)} KB. Messages are limited to 10 KB so that what is signed stays readable.`,
    }
  }
  const key = normalizePrivateKey(privateKey)
  if (!key.ok) {
    return key
  }

  try {
    // A structurally valid 64-hex-digit string can still be an unusable scalar
    // (zero, or ≥ the curve order), which the Wallet constructor rejects.
    const wallet = new Wallet(key.value)
    return { ok: true, value: await wallet.signMessage(message) }
  } catch {
    return { ok: false, error: "This private key cannot be used for signing." }
  }
}

/**
 * Recover the signer of a `personal_sign` signature and compare it with an
 * expected address.
 *
 * A cryptographic mismatch is reported through the result value (`matches:
 * false`) rather than as a failure: the operation succeeded, and the UI must be
 * able to present a mismatch without it reading like a tool error.
 *
 * @param address - The address the signature is claimed to belong to
 * @param message - The message that was signed
 * @param signature - The signature text; see {@link normalizeSignature}
 * @returns The recovered address and whether it matches, or a failure carrying a user-presentable message
 */
export function verifyPersonalSignature(
  address: string,
  message: string,
  signature: string
): SignResult<Verification> {
  if (message === "") {
    return { ok: false, error: "Enter the message that was signed." }
  }
  if (utf8ByteLength(message) > MAX_MESSAGE_BYTES) {
    return { ok: false, error: "The message exceeds the 10 KB limit." }
  }
  const expected = normalizeAddress(address)
  if (!expected.ok) {
    return expected
  }
  const sig = normalizeSignature(signature)
  if (!sig.ok) {
    return sig
  }

  try {
    const recovered = getAddress(verifyMessage(message, sig.value))
    return { ok: true, value: { recovered, matches: recovered === expected.value } }
  } catch {
    return { ok: false, error: "The signature could not be verified. Check that it is complete." }
  }
}
