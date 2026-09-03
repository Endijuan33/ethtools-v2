
/**
 * Read-only Gnosis Safe inspection.
 *
 * Talks to the Safe contract itself with raw `eth_call`s — no SDK, no API key,
 * no third-party service — using the five function selectors every Safe version
 * implements. The decoders here are hostile-safe: contract return data is
 * untrusted input, so every offset, length and count is bounds-checked before
 * anything is read, and any malformation yields `null` rather than a throw or
 * a fabricated value.
 */

import { getAddress, isAddress, toUtf8String } from "ethers"
import { RpcError, withProvider, type Network } from "./ethers"
import { describeError } from "./logger"

// ===== Types =====

/** A successfully read Safe. */
export interface SafeInfo {
  /** The checksummed Safe address that was read. */
  address: string
  /** Signers, checksummed, in the order the contract reports them. */
  owners: string[]
  /** How many owner signatures a transaction needs. */
  threshold: bigint
  /** The Safe's current nonce, which replay protection keys off. */
  nonce: bigint
  /** The Safe's self-reported contract version, e.g. `1.3.0`. */
  version: string
  /** The chain id the Safe reports, or null on Safes too old to expose it. */
  chainId: bigint | null
}

/**
 * Outcome of reading a Safe.
 *
 * On failure, `error` is a complete, user-presentable English sentence.
 */
export type SafeReadResult = { ok: true; value: SafeInfo } | { ok: false; error: string }

// ===== Verified selectors =====

/**
 * Selectors for the five Safe reads.
 *
 * Every value below was verified two ways: computed as
 * `id(signature).slice(0, 10)` with ethers, and confirmed against a live
 * mainnet Safe (`0x0DA0C3e52C977Ed3cBc641fF02DD271c3ED55aFe`) with direct
 * `eth_call`s. Two constants that circulate in the wild — `0xe75235bf` for
 * `getThreshold()` and `0x1cff79cd` for `getChainId()` — hash the wrong
 * strings and revert against real Safes, so the computed values are used.
 */
const GET_OWNERS_SELECTOR = "0xa0e67e2b" // getOwners()
const GET_THRESHOLD_SELECTOR = "0xe75235b8" // getThreshold()
const NONCE_SELECTOR = "0xaffed0e0" // nonce()
const VERSION_SELECTOR = "0xffa1ad74" // VERSION()
const GET_CHAIN_ID_SELECTOR = "0x3408e470" // getChainId()

/** Upper bound on the owner count this module will decode. */
const MAX_OWNERS = 512

/** Upper bound on the version string this module will decode, in bytes. */
const MAX_VERSION_BYTES = 128

/** Bytes in one ABI-encoded word, and its hex character count. */
const WORD_HEX_LENGTH = 64

// ===== Pure decoding =====

/**
 * Normalize an `eth_call` result into plain lowercase hex.
 *
 * @param data - A raw `eth_call` result, `0x`-prefixed
 * @returns The hex body without the prefix, or null when `data` is not hex
 */
function normalizeCallData(data: string): string | null {
  if (typeof data !== "string" || !data.startsWith("0x")) return null
  const body = data.slice(2).toLowerCase()
  return /^[0-9a-f]*$/.test(body) ? body : null
}

/**
 * Read one 32-byte word of ABI-encoded data as a `bigint`.
 *
 * @param hex - Normalized hex body
 * @param wordIndex - Zero-based word position
 * @returns The word's value, or null when the word lies outside the data
 */
function readWord(hex: string, wordIndex: number): bigint | null {
  const start = wordIndex * WORD_HEX_LENGTH
  const slice = hex.slice(start, start + WORD_HEX_LENGTH)
  if (slice.length !== WORD_HEX_LENGTH) return null
  return BigInt(`0x${slice}`)
}

/**
 * Decode a `getOwners()` result: a dynamic `address[]`.
 *
 * @param result - The raw `eth_call` return data
 * @returns The checksummed owners, or null when the data is not a well-formed
 *   owner array (which includes the empty `0x` a contract-less address returns)
 */
export function decodeSafeOwners(result: string): string[] | null {
  const hex = normalizeCallData(result)
  if (hex === null || hex.length < 2 * WORD_HEX_LENGTH) return null

  // A dynamic array in a return value is always at offset 32: the first word
  // is the array's own offset, the second its length.
  const offset = readWord(hex, 0)
  const count = readWord(hex, 1)
  if (offset === null || count === null) return null
  if (offset !== 32n) return null
  if (count < 0n || count > BigInt(MAX_OWNERS)) return null

  // Every claimed owner needs a full word; a short buffer means the data is
  // lying about its length.
  const needed = 2 * WORD_HEX_LENGTH + Number(count) * WORD_HEX_LENGTH
  if (hex.length < needed) return null

  const owners: string[] = []
  for (let index = 0; index < Number(count); index += 1) {
    const wordStart = (2 + index) * WORD_HEX_LENGTH
    // Addresses live in the low 160 bits of their word; the top 96 bits must
    // be zero for a canonical encoding, but accepting them keeps the decode
    // robust to padding oddities without affecting the address itself.
    const addressHex = hex.slice(wordStart + 24, wordStart + WORD_HEX_LENGTH)
    try {
      owners.push(getAddress(`0x${addressHex}`))
    } catch {
      return null
    }
  }
  return owners
}

/**
 * Decode a `getThreshold()` or `nonce()` result: a single `uint256`.
 *
 * @param result - The raw `eth_call` return data
 * @returns The value, or null when the data is not exactly one word
 */
export function decodeSafeUint(result: string): bigint | null {
  const hex = normalizeCallData(result)
  if (hex === null || hex.length !== WORD_HEX_LENGTH) return null
  return readWord(hex, 0)
}

/**
 * Decode a `VERSION()` result: an ABI-encoded `string`.
 *
 * @param result - The raw `eth_call` return data
 * @returns The decoded string, or null when the encoding is malformed or the
 *   length is implausible for a version string
 */
export function decodeSafeString(result: string): string | null {
  const hex = normalizeCallData(result)
  if (hex === null || hex.length < 2 * WORD_HEX_LENGTH) return null

  const offset = readWord(hex, 0)
  const length = readWord(hex, 1)
  if (offset === null || length === null) return null
  if (offset !== 32n) return null
  if (length < 0n || length > BigInt(MAX_VERSION_BYTES)) return null

  const byteLength = Number(length)
  const needed = 2 * WORD_HEX_LENGTH + byteLength * 2
  if (hex.length < needed) return null

  try {
    return toUtf8String(`0x${hex.slice(2 * WORD_HEX_LENGTH, needed)}`)
  } catch {
    return null
  }
}

// ===== The read =====

/** Internal marker: the address did not respond like a Gnosis Safe. */
class NotASafeError extends Error {}

/**
 * Read a Gnosis Safe's configuration from its own contract.
 *
 * Sends five `eth_call`s through the shared RPC pool. `getOwners()` is the
 * gate: an address whose `getOwners()` reverts or returns garbage is reported
 * as not a Safe rather than as a network failure, because that is the more
 * likely explanation and the more useful message. `getChainId()` is
 * best-effort — Safes older than v1.1.0 do not expose it — so it degrades to
 * null instead of failing an otherwise successful read.
 *
 * @param network - Network key to read on
 * @param address - The Safe address
 * @param signal - Optional cancellation signal
 * @returns The Safe's configuration, or a failure carrying a user-presentable message
 */
export async function readSafe(
  network: Network,
  address: string,
  signal?: AbortSignal
): Promise<SafeReadResult> {
  const trimmed = address.trim()
  if (!isAddress(trimmed)) {
    return { ok: false, error: "Enter a valid Safe address." }
  }
  const to = getAddress(trimmed)

  // Each read goes through the pool individually rather than being bundled
  // into one work callback: a revert is deterministic, so bundling would make
  // the pool replay it against every endpoint before giving up.
  const call = async (selector: string): Promise<string> =>
    withProvider(network, (provider) => provider.call({ to, data: selector }), signal)

  // A real RPC failure must surface as a network error, not as "not a Safe",
  // so RpcError is rethrown and only contract-level reverts fall through to
  // the NotASafe path.
  const callOrNotSafe = async (selector: string): Promise<string> => {
    try {
      return await call(selector)
    } catch (cause) {
      if (cause instanceof RpcError) throw cause
      throw new NotASafeError()
    }
  }

  try {
    const ownersData = await callOrNotSafe(GET_OWNERS_SELECTOR)
    const owners = decodeSafeOwners(ownersData)
    if (owners === null) throw new NotASafeError()

    const [thresholdData, nonceData, versionData] = await Promise.all([
      callOrNotSafe(GET_THRESHOLD_SELECTOR),
      callOrNotSafe(NONCE_SELECTOR),
      callOrNotSafe(VERSION_SELECTOR),
    ])

    const threshold = decodeSafeUint(thresholdData)
    const nonce = decodeSafeUint(nonceData)
    const version = decodeSafeString(versionData)
    if (threshold === null || nonce === null || version === null) {
      throw new NotASafeError()
    }
    if (threshold === 0n || threshold > BigInt(owners.length)) {
      // A threshold of zero or above the owner count is impossible in a real
      // Safe; the bytes are not what they claim to be.
      throw new NotASafeError()
    }

    // Best-effort: older Safes do not implement getChainId().
    let chainId: bigint | null = null
    try {
      chainId = decodeSafeUint(await call(GET_CHAIN_ID_SELECTOR))
    } catch {
      chainId = null
    }

    return {
      ok: true,
      value: { address: to, owners, threshold, nonce, version, chainId },
    }
  } catch (cause) {
    if (cause instanceof NotASafeError) {
      return {
        ok: false,
        error: "Not a Gnosis Safe on this network. Check the address and the selected network.",
      }
    }
    if (cause instanceof RpcError) {
      return { ok: false, error: cause.userMessage }
    }
    return {
      ok: false,
      error: describeError(cause, "Could not read the Safe. Check your connection and try again."),
    }
  }
}
