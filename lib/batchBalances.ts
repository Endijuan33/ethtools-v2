
/**
 * Batch native-balance lookups across networks.
 *
 * Split the way `lib/gasTracker.ts` splits: a pure, synchronous parser that
 * turns pasted text into a validated, deduplicated address list (unit-testable
 * with plain fixtures), and a thin async fetcher that fans out one pooled
 * `eth_getBalance` per network through the shared RPC pool.
 *
 * Per-network failures are reported, never fatal: an address that has a balance
 * on Ethereum but whose Polygon endpoint is down still shows the Ethereum
 * number, with the failure visible in that cell alone.
 */

import { getAddress, isAddress } from "ethers"
import {
  getAllNetworks,
  getBalanceWei,
  getNativeDecimals,
  RpcError,
  type Network,
} from "./ethers"
import { describeError } from "./logger"

// ===== Types =====

/**
 * Outcome of an operation that can legitimately fail because of user input.
 *
 * On failure, `error` is a complete, user-presentable English sentence.
 */
export type BatchResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * How many addresses one check may cover.
 *
 * Each address costs one RPC request per network, so an unbounded list is an
 * unbounded request fan-out against public endpoints. 25 × 7 networks is the
 * deliberate ceiling.
 */
export const MAX_BATCH_ADDRESSES = 25

/** One rejected line of pasted text. */
export interface InvalidLine {
  /** 1-based line number within the original text, empty lines included. */
  line: number
  /** Why the line was rejected, as a user-presentable sentence. */
  reason: string
}

/** Outcome of parsing a pasted address list. */
export interface ParsedAddressList {
  /** Valid, checksummed, deduplicated addresses in order of first appearance. */
  addresses: string[]
  /** Every non-empty line that was not a valid address, with its line number. */
  invalidLines: InvalidLine[]
  /**
   * Set when the list holds more unique valid addresses than the cap allows.
   *
   * `addresses` is then truncated to the cap, but the UI must treat the parse
   * as failed: silently checking only the first N addresses would look like a
   * complete result.
   */
  error?: string
}

/** The native balance of one address on one network, or why it is unknown. */
export interface NetworkBalanceResult {
  /** Network key the balance was requested for. */
  network: Network
  /** Display name of the network. */
  name: string
  /** Native currency symbol, e.g. `ETH` or `BNB`. */
  symbol: string
  /** Decimal places of the native currency. */
  decimals: number
  /** Balance in base units, or null when the lookup failed. */
  value: bigint | null
  /** Why the lookup failed, or null when it succeeded. */
  error: string | null
}

/** A per-symbol sum of the balances that were actually retrieved. */
export interface SymbolTotal {
  /** Native currency symbol the total is denominated in. */
  symbol: string
  /** Decimal places of the summed unit. */
  decimals: number
  /** Sum in base units, only across networks with this exact symbol. */
  total: bigint
}

// ===== Pure parsing =====

/** Longest snippet of a bad line echoed back in an error message. */
const SNIPPET_LIMIT = 48

/**
 * Parse a pasted address list.
 *
 * Every non-empty line must be a valid address. Empty lines are skipped so a
 * list pasted with blank separators still works. Duplicates are removed
 * case-insensitively, keeping the first occurrence. More unique valid addresses
 * than `maxAddresses` is an error that names the cap — a silent truncation
 * would look like a complete check.
 *
 * @param text - Raw textarea content
 * @param maxAddresses - Maximum number of unique valid addresses; defaults to {@link MAX_BATCH_ADDRESSES}
 * @returns The parsed list; never throws
 */
export function parseAddressList(
  text: string,
  maxAddresses: number = MAX_BATCH_ADDRESSES
): ParsedAddressList {
  const addresses: string[] = []
  const seen = new Set<string>()
  const invalidLines: InvalidLine[] = []

  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (trimmed === "") continue

    const normalized = normalizeAddress(trimmed)
    if (normalized === null) {
      invalidLines.push({
        line: index + 1,
        reason: `${describeSnippet(trimmed)} is not a valid Ethereum address.`,
      })
      continue
    }

    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    addresses.push(normalized)
  }

  if (addresses.length > maxAddresses) {
    return {
      // Truncated so the UI still knows what the first N would be, but the
      // error must stop the check from running on a partial list.
      addresses: addresses.slice(0, maxAddresses),
      invalidLines,
      error: `At most ${maxAddresses} addresses can be checked at once; this list has ${addresses.length}. Remove the extras and check again.`,
    }
  }

  return { addresses, invalidLines }
}

/**
 * Validate and checksum one address.
 *
 * @param candidate - A trimmed non-empty line
 * @returns The EIP-55 checksummed address, or null when invalid
 */
function normalizeAddress(candidate: string): string | null {
  if (!isAddress(candidate)) return null
  try {
    return getAddress(candidate)
  } catch {
    // `isAddress` accepts all-uppercase hex, which `getAddress` rejects as a
    // failed checksum; a second pass on the lowercased form recovers it.
    try {
      return getAddress(candidate.toLowerCase())
    } catch {
      return null
    }
  }
}

/**
 * Render a short echo of a rejected line for an error message.
 *
 * Bounded so a hostile multi-kilobyte line cannot balloon the message.
 *
 * @param text - The rejected line
 * @returns A quoted snippet, truncated with an ellipsis
 */
function describeSnippet(text: string): string {
  const snippet = text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}…` : text
  return `"${snippet}"`
}

// ===== Pure aggregation =====

/**
 * Sum retrieved balances per currency symbol.
 *
 * A total must never mix units: `ETH` on mainnet, Base, Optimism and Arbitrum
 * is one ETH total, while BNB and MATIC stay separate. Networks whose lookups
 * failed are simply absent from the sum — a missing network is reported by the
 * UI, not papered over as zero.
 *
 * @param results - Per-network balance results for a single address
 * @returns Totals grouped by symbol, ETH first, then alphabetical
 */
export function sumBalancesBySymbol(
  results: readonly NetworkBalanceResult[]
): SymbolTotal[] {
  const totals = new Map<string, SymbolTotal>()
  for (const result of results) {
    if (result.value === null) continue
    const key = `${result.symbol}:${result.decimals}`
    const existing = totals.get(key)
    if (existing === undefined) {
      totals.set(key, { symbol: result.symbol, decimals: result.decimals, total: result.value })
    } else {
      existing.total += result.value
    }
  }

  return Array.from(totals.values()).sort((a, b) => {
    if (a.symbol === "ETH" && b.symbol !== "ETH") return -1
    if (b.symbol === "ETH" && a.symbol !== "ETH") return 1
    return a.symbol.localeCompare(b.symbol)
  })
}

// ===== Async fetch =====

/**
 * Fetch one address's native balance on every requested network.
 *
 * One pooled `eth_getBalance` per network, all in flight at once, with each
 * network settled independently: a failing endpoint produces an `error` entry
 * rather than rejecting the whole batch.
 *
 * @param address - A validated address
 * @param networks - Network keys to query
 * @param signal - Optional cancellation signal
 * @returns One result per network, in the same order as `networks`
 * @throws {Error} If `address` is not a valid address
 */
export async function getAddressBalances(
  address: string,
  networks: readonly Network[],
  signal?: AbortSignal
): Promise<NetworkBalanceResult[]> {
  // Defensive: every caller is expected to go through parseAddressList first,
  // but this is a public boundary and a bad address would otherwise be sent to
  // every endpoint before failing.
  if (!isAddress(address)) throw new Error("Invalid address.")

  const allNetworks = getAllNetworks()
  const settled = await Promise.allSettled(
    networks.map((network) => getBalanceWei(address, network, signal))
  )

  return settled.map((outcome, index) => {
    const network = networks[index]
    const config = allNetworks[network]
    const base = {
      network,
      name: config?.name ?? network,
      symbol: config?.currency ?? "",
      decimals: getNativeDecimals(network),
    }
    if (outcome.status === "fulfilled") {
      return { ...base, value: outcome.value, error: null }
    }
    return {
      ...base,
      value: null,
      error:
        outcome.reason instanceof RpcError
          ? outcome.reason.userMessage
          : describeError(outcome.reason, "Balance lookup failed."),
    }
  })
}
