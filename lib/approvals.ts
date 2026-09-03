"use client"

/**
 * ERC-20 approval discovery, display, and revocation.
 *
 * An approval is dangerous long after it was granted: a spender allowed
 * "unlimited" USDC in 2021 can still drain the account today unless the owner
 * revokes it. Two data sources are therefore combined, and the split is the
 * security posture of the whole module:
 *
 * - **Which spenders ever had an approval** comes from `Approval` event logs on
 *   the public Blockscout-family explorers (the same keyless APIs the token
 *   discovery card uses). Log *values* are deliberately ignored for display:
 *   they record the amount at grant time, not what remains after spending or
 *   revocation, so treating them as balances would show phantom allowances.
 * - **What each spender holds right now** comes from live `allowance()` calls
 *   through the app's pooled RPC (`withProvider`), so the normal failover
 *   applies and every number the user sees is current, not historical.
 *
 * The explorer payload is hostile input by assumption: token and spender are
 * validated as addresses, log data is bounded before `BigInt` ever sees it, and
 * a bad entry is discarded silently rather than erroring a whole network.
 *
 * Revocation mirrors `components/SendForm.tsx` end to end — gas estimate first
 * (a revert aborts before any fee is spent), then sign locally, then broadcast
 * exactly once through `withProviderOnce` (retrying an ambiguous broadcast
 * could double-submit), then record in history and resolve the real receipt
 * status. The private key exists only in the caller's memory during the
 * ceremony and is never logged.
 */

import { Interface, Wallet, getAddress, type TransactionRequest } from "ethers"
import { RpcError, NETWORKS, withProvider, withProviderOnce } from "./ethers"
import { EXPLORER_APIS } from "./tokenDetection"
import { saveTransaction, updateTransactionStatus } from "./transactionHistory"
import { isEthAddress, isRecord } from "./schema"
import { describeError, logger } from "./logger"

// ===== Types =====

/**
 * Outcome of a scan or revoke call.
 *
 * Matches the `{ ok, value | error }` convention of `lib/tokenDetection.ts`;
 * on failure, `error` is a complete user-presentable sentence.
 */
export type ApprovalsResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** A distinct (token contract, spender) approval found in event history. */
export interface ApprovalPair {
  /** Token contract, normalized to EIP-55 checksum form. */
  token: string
  /** Spender, normalized to EIP-55 checksum form. */
  spender: string
}

/**
 * An approval with a live, non-zero allowance.
 *
 * Metadata fields are optional because the explorer's token endpoint is
 * enrichment, not a dependency: when it fails the row degrades to addresses
 * rather than disappearing.
 */
export interface ActiveApproval {
  /** Network key the approval lives on, e.g. `"mainnet"`. */
  networkKey: string
  /** Token contract, EIP-55 checksum form. */
  token: string
  /** Token symbol, when the explorer served usable metadata. */
  tokenSymbol?: string
  /** Token name, when the explorer served usable metadata. */
  tokenName?: string
  /** Token decimals, when the explorer served usable metadata. */
  tokenDecimals?: number
  /**
   * Token's USD price from the explorer's `exchange_rate`, or null when the
   * explorer served none (or garbage). Drives the per-row USD exposure line;
   * absent entirely when metadata enrichment itself failed.
   */
  tokenPriceUsd?: number | null
  /** Spender, EIP-55 checksum form. */
  spender: string
  /** Current allowance in base units, read from the chain seconds ago. */
  allowance: bigint
  /** Whether the allowance is effectively unlimited (at least 2^128). */
  unlimited: boolean
}

/** One network's raw scan outcome, before aggregation. */
export interface NetworkApprovals {
  /** Distinct (token, spender) pairs found in history, bounded by the cap. */
  pairs: ApprovalPair[]
  /** Pairs whose live allowance was read as non-zero, sorted risk-first. */
  current: ActiveApproval[]
  /** Whether any safety cap stopped the scan short of complete history. */
  truncated: boolean
}

/** One network's aggregated outcome, successful or not. */
export interface NetworkApprovalScan {
  networkKey: string
  networkName: string
  isTestnet: boolean
  status: "ok" | "failed"
  /** Approvals with a confirmed non-zero current allowance. */
  approvals: ActiveApproval[]
  /** Distinct (token, spender) pairs found in history, including revoked ones. */
  pairsFound: number
  /** Whether a safety cap stopped this network's scan short. */
  truncated: boolean
  /** Already-sanitised, user-presentable failure message; empty when ok. */
  error: string
}

/** Everything the card renders for one address after one scan. */
export interface ApprovalScanSnapshot {
  address: string
  /** One entry per scanned network, in registry order. */
  networks: readonly NetworkApprovalScan[]
  /** The subset of {@link networks} that failed, so the UI can name them. */
  failures: readonly NetworkApprovalScan[]
  /** Epoch milliseconds, so the UI can state how fresh the results are. */
  fetchedAt: number
}

/**
 * Outcome of a revoke attempt.
 *
 * `ok: true` means the transaction was broadcast; `status` then reports the
 * receipt outcome exactly like `SendForm` — a missing receipt is `"unknown"`,
 * never a silent success, because claiming a revoke happened when it may not
 * have is the one lie this feature must never tell.
 */
export type RevokeResult =
  | { ok: true; txHash: string; status: "success" | "failed" | "unknown"; historyWarning?: string }
  | { ok: false; error: string }

// ===== Constants =====

/**
 * `Approval(address owner, address indexed spender, uint256 value)` topic.
 *
 * Both owner and spender are indexed, so a genuine ERC-20 Approval log always
 * carries three topics; the value rides in the data field, which is why log
 * values can never substitute for a live `allowance()` read.
 */
export const APPROVAL_TOPIC0 = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"

/**
 * Logs a single explorer `eth_getLogs` call returns before silently cutting
 * the page. Measured live on mainnet: a full-history query for a heavy address
 * returns exactly this many, which is what forces the range-splitting policy.
 */
export const LOG_PAGE_CAP = 1000

/** Hard bound on raw log entries collected per network, honesty about the rest. */
export const MAX_LOGS_PER_NETWORK = 3000

/**
 * Distinct (token, spender) pairs kept per network.
 *
 * Most addresses have well under a few hundred; the bound exists so a hostile
 * or pathological history cannot turn the scan into thousands of `eth_call`s.
 */
export const MAX_PAIRS_PER_NETWORK = 200

/**
 * Explorer log requests allowed per network, seeds plus splits.
 *
 * The bound exists so a hostile explorer returning page-capped results forever
 * cannot keep the scan open: once it trips, the network is reported truncated.
 */
export const MAX_LOG_REQUESTS_PER_NETWORK = 64

/**
 * Seed chunk size for the block walk, in blocks.
 *
 * 2,000,000 is the measured-safe chunk on mainnet (a full-history mainnet
 * query — 22M+ blocks — answers in ~5s, so a 2M slice is comfortably inside
 * the timeout). See {@link MAX_SEED_CHUNKS} for why taller chains adapt.
 */
export const CHUNK_BLOCK_SIZE = 2_000_000

/**
 * Most seed chunks one network's walk is allowed to need.
 *
 * Arbitrum emits a block roughly every quarter second, so its height is in the
 * hundreds of millions: fixed 2M chunks would mean hundreds of sequential
 * requests per scan. The walk instead widens its seed chunk so it never needs
 * more than this many seed requests; on mainnet (well under 50M blocks) the
 * computed size stays at the 2M floor and the walk is exactly the measured
 * policy. Only taller chains get proportionally larger, still-safe slices.
 */
export const MAX_SEED_CHUNKS = 24

/** Log requests in flight per network; polite to public explorers, still parallel. */
const SCAN_CONCURRENCY = 4

/** Deadline for one explorer request. Absorbs the worst measured case, not the average. */
const REQUEST_TIMEOUT_MS = 45_000

/** Entries `extractApprovalPairs` will even look at, bounding main-thread work. */
const MAX_LOG_ENTRIES_PARSED = 5000

/** Default pair cap for {@link extractApprovalPairs} when the caller omits one. */
const DEFAULT_PAIR_CAP = 500

/**
 * Largest approval value accepted from a log: anything with more than 78
 * decimal digits exceeds uint256 and is hostile or corrupt, not a value.
 */
const MAX_APPROVAL_VALUE = 10n ** 78n

/** An allowance at or above 2^128 is effectively unlimited (max uint256 included). */
const UNLIMITED_THRESHOLD = 2n ** 128n

/** Safety bound on ranges materialized, so a hostile tip cannot exhaust memory. */
const MAX_RANGES = 1024

/** Allowance `eth_call`s fired per round; small batches keep public RPCs responsive. */
const ALLOWANCE_BATCH_SIZE = 8

/** Token-metadata fetches in flight per round. */
const METADATA_BATCH_SIZE = 8

/** Display clamp for token symbols, mirroring the discovery card. */
const MAX_SYMBOL_LENGTH = 16

/** Display clamp for token names, mirroring the discovery card. */
const MAX_NAME_LENGTH = 64

/** Longest decimal string accepted for a balance, ~uint256 plus slack. */
const MAX_BALANCE_DIGITS = 78

/** Upper bound on a single returned log page; larger is treated as malformed. */
const MAX_PAGE_LENGTH = 5000

/**
 * ERC-20 fragments this module needs.
 *
 * Kept as one `Interface` so the selectors are derived by ethers rather than
 * hand-typed hex strings that could silently drift from the ABI.
 */
const ERC20_INTERFACE = new Interface([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
])

// ===== Pure helpers: log parsing =====

/**
 * Whether a 20-byte address appears in a 32-byte zero-padded topic slot.
 *
 * An indexed `address` parameter is always left-padded with 24 zero hex
 * characters; anything else in those positions is not an address encoding and
 * is discarded rather than mis-decoded.
 *
 * @param raw - Candidate topic from an `eth_getLogs` result. Hostile input.
 * @returns The EIP-55 checksummed address, or null when the topic is not one.
 */
function parseTopicAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null
  if (!raw.startsWith("0x000000000000000000000000")) return null
  return toChecksummed(`0x${raw.slice(26)}`)
}

/**
 * Whether a log's `address` field (the token contract) is a valid address.
 *
 * `getAddress` rejects a wrong mixed-case checksum, which real nodes never
 * send, so this doubles as a hostile-payload filter.
 *
 * @param raw - Candidate contract address. Hostile input.
 * @returns The EIP-55 checksummed address, or null.
 */
function parseLogAddress(raw: unknown): string | null {
  if (!isEthAddress(raw)) return null
  return toChecksummed(raw)
}

/**
 * Decode a log's `data` field (the approved value) with hostile-input bounds.
 *
 * The value is not used for display — the live `allowance()` read is — but a
 * log whose data is not a bounded numeric is not a genuine Approval event, so
 * validating it is part of deciding the entry exists at all.
 *
 * @param raw - Candidate `data` field. Hostile input.
 * @returns The value, or null when the data is malformed or absurdly large.
 */
function parseLogValue(raw: unknown): bigint | null {
  if (typeof raw !== "string") return null
  // 1–32 bytes, even-length hex: the shape an ABI-encoded uint256 comes in.
  if (!/^0x(?:[0-9a-fA-F]{2}){1,32}$/.test(raw)) return null
  let value: bigint
  try {
    value = BigInt(raw)
  } catch {
    return null
  }
  return value < MAX_APPROVAL_VALUE ? value : null
}

/**
 * Whether a log's `blockNumber` field is a hex quantity.
 *
 * A presence check only: the block number orders nothing here, but a log
 * missing even this field is malformed and discarded.
 *
 * @param raw - Candidate `blockNumber` field. Hostile input.
 */
function isHexQuantity(raw: unknown): raw is string {
  return typeof raw === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(raw)
}

/**
 * Extract distinct (token, spender) pairs from raw `eth_getLogs` results.
 *
 * Accepts either the bare log array or a full JSON-RPC envelope
 * (`{ result: [...] }`), because both shapes cross this boundary in practice.
 * Every field is validated before it is believed: the token contract comes from
 * the log address, the spender from the third topic (topic0 must be the
 * Approval signature), and garbage entries are discarded silently so one bad
 * log can never cost the network its whole result. Reorged-out entries
 * (`removed: true`) are skipped. Duplicate pairs collapse to one; the pair cap
 * bounds both memory and the number of follow-up `eth_call`s.
 *
 * @param logs - Raw `eth_getLogs` result. Hostile input.
 * @param cap - Maximum distinct pairs to return. Defaults to a generous bound.
 * @returns The deduplicated, bounded pairs and whether anything was left unexamined.
 */
export function extractApprovalPairs(
  logs: unknown,
  cap = DEFAULT_PAIR_CAP
): { pairs: ApprovalPair[]; truncated: boolean } {
  const effectiveCap = Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_PAIR_CAP

  let entries: unknown = logs
  if (isRecord(logs) && Array.isArray(logs.result)) entries = logs.result
  if (!Array.isArray(entries)) return { pairs: [], truncated: false }

  const pairs: ApprovalPair[] = []
  const seen = new Set<string>()
  const bound = Math.min(entries.length, MAX_LOG_ENTRIES_PARSED)
  // Anything beyond the parse bound went unexamined; say so rather than imply completeness.
  let truncated = entries.length > MAX_LOG_ENTRIES_PARSED

  for (let index = 0; index < bound; index++) {
    const entry = entries[index]
    if (!isRecord(entry)) continue
    if (entry.removed === true) continue

    const topics = entry.topics
    if (!Array.isArray(topics) || topics.length < 3) continue
    if (topics[0] !== APPROVAL_TOPIC0) continue

    const token = parseLogAddress(entry.address)
    if (token === null) continue
    const spender = parseTopicAddress(topics[2])
    if (spender === null) continue
    if (parseLogValue(entry.data) === null) continue
    if (!isHexQuantity(entry.blockNumber)) continue

    const key = `${token.toLowerCase()}:${spender.toLowerCase()}`
    if (seen.has(key)) continue
    if (pairs.length >= effectiveCap) {
      truncated = true
      break
    }
    seen.add(key)
    pairs.push({ token, spender })
  }

  return { pairs, truncated }
}

// ===== Pure helpers: range policy =====

/** An inclusive block range to query. */
export interface BlockRange {
  fromBlock: number
  toBlock: number
}

/**
 * Split a range of blocks into inclusive, contiguous chunks.
 *
 * The pagination policy lives here — not inside the fetch loop — so it is
 * unit-testable: same inputs, same ranges, no network.
 *
 * @param latestBlock - Current chain tip; ranges cover 0 through it exactly.
 * @param chunkSize - Blocks per chunk. Invalid values yield no ranges rather
 *   than an infinite or degenerate walk.
 * @returns The chunks, ordered from genesis; bounded in count so a hostile
 *   tip cannot exhaust memory.
 */
export function chunkBlockRanges(latestBlock: number, chunkSize: number): BlockRange[] {
  if (!Number.isInteger(latestBlock) || latestBlock < 0) return []
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) return []

  const ranges: BlockRange[] = []
  for (let from = 0; from <= latestBlock && ranges.length < MAX_RANGES; from += chunkSize) {
    ranges.push({ fromBlock: from, toBlock: Math.min(from + chunkSize - 1, latestBlock) })
  }
  return ranges
}

/**
 * Whether a page that returned `logCount` entries must be re-queried in halves.
 *
 * Explorers cut a log page at {@link LOG_PAGE_CAP} without warning, so a page
 * *at or above* the cap means "there may be more here": the only way to see
 * them is to narrow the range and ask again.
 *
 * @param logCount - Entries the page actually returned.
 * @param cap - The server's page cap.
 */
export function needsSplitting(logCount: number, cap: number): boolean {
  return (
    Number.isInteger(cap) && cap > 0 && Number.isInteger(logCount) && logCount >= cap
  )
}

/**
 * Split one range into two halves.
 *
 * @param range - The range to halve.
 * @returns Both halves, contiguous and exactly covering the input, or null when
 *   the range is a single block (or malformed) and cannot be narrowed further.
 */
export function splitBlockRange(range: BlockRange): [BlockRange, BlockRange] | null {
  const { fromBlock, toBlock } = range
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) return null
  if (fromBlock < 0 || toBlock < fromBlock) return null
  const size = toBlock - fromBlock + 1
  if (size <= 1) return null
  const firstSize = Math.floor(size / 2)
  return [
    { fromBlock, toBlock: fromBlock + firstSize - 1 },
    { fromBlock: fromBlock + firstSize, toBlock },
  ]
}

// ===== Pure helpers: value decoding =====

/**
 * Whether an allowance value is effectively unlimited.
 *
 * 2^128 as the threshold covers both max uint256 and every "very large"
 * approval pattern (USDT-style 2^160, year-2038 style 2^62 does not qualify).
 * Display never calls this on a formatted string: the decision must be exact.
 *
 * @param value - Allowance in base units.
 */
export function isUnlimitedAllowance(value: bigint): boolean {
  return value >= UNLIMITED_THRESHOLD
}

/**
 * Decode the hex result of an `allowance(owner, spender)` `eth_call`.
 *
 * A conforming node returns exactly 32 bytes; anything else — odd-length hex,
 * wrong size, no `0x`, non-string — is hostile or broken and yields null so
 * the caller can treat the value as unreadable rather than as zero (which
 * would silently hide a live approval).
 *
 * @param result - The `eth_call` result. Hostile input.
 * @returns The allowance in base units, or null when undecodable.
 */
export function decodeAllowanceResult(result: string | unknown): bigint | null {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) return null
  try {
    return BigInt(result)
  } catch {
    return null
  }
}

// ===== Explorer RPC =====

/**
 * POST one JSON-RPC call to a Blockscout explorer's `eth-rpc` endpoint.
 *
 * Never throws across this boundary: the outcome is a result type so callers
 * can degrade per network without try/catch scaffolding. A timeout is reported
 * as its own sentence, distinct from user cancellation.
 *
 * @param base - Explorer base URL from {@link EXPLORER_APIS}.
 * @param networkName - Human-readable name for error sentences.
 * @param method - JSON-RPC method name.
 * @param params - JSON-RPC parameters.
 * @param signal - Optional cancellation, relayed into the request.
 */
async function explorerRpc<T>(
  base: string,
  networkName: string,
  method: string,
  params: readonly unknown[],
  signal?: AbortSignal
): Promise<ApprovalsResult<T>> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${base}/api/eth-rpc`, {
      method: "POST",
      signal: controller.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })

    if (!response.ok) {
      return { ok: false, error: `${networkName} did not answer (status ${response.status}).` }
    }

    const payload: unknown = await response.json()
    if (!isRecord(payload)) {
      return { ok: false, error: `${networkName} returned an unusable response.` }
    }
    if (payload.error !== undefined) {
      logger.warn("Explorer rejected an RPC call", { method, network: networkName })
      return { ok: false, error: `${networkName} rejected the request.` }
    }
    return { ok: true, value: payload.result as T }
  } catch (error) {
    if (timedOut) {
      return { ok: false, error: `${networkName} did not answer in time.` }
    }
    if (controller.signal.aborted || signal?.aborted) {
      return { ok: false, error: "The scan was cancelled." }
    }
    logger.warn("Explorer RPC request failed", { method, network: networkName, error })
    return { ok: false, error: describeError(error, `${networkName} could not be reached.`) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Re-checksum an address that already passed `isEthAddress`.
 *
 * `isAddress` checks shape only, so a mixed-case address with a broken
 * checksum gets this far and would make the bare `getAddress` throw — a
 * hostile or mistyped value must resolve to null instead of an exception.
 *
 * @param raw - Candidate address.
 * @returns The EIP-55 checksummed address, or null.
 */
function toChecksummed(raw: string): string | null {
  try {
    return getAddress(raw)
  } catch {
    return null
  }
}

/** A non-negative hex quantity, as JSON-RPC wants block numbers. */
function toHexQuantity(value: number): string {
  return `0x${value.toString(16)}`
}

/** Parse an `eth_blockNumber` result into a safe integer, or null. */
function parseBlockQuantity(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{1,12}$/.test(raw)) return null
  const value = Number.parseInt(raw, 16)
  return Number.isSafeInteger(value) ? value : null
}

/** Left-pad a 20-byte address into its 32-byte indexed-topic encoding. */
function padTopicAddress(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`
}

/**
 * Fetch one page of Approval logs for an owner over one block range.
 *
 * @param base - Explorer base URL.
 * @param networkName - Human-readable name for error sentences.
 * @param paddedOwner - The owner address in its 32-byte topic encoding.
 * @param range - Inclusive block range to query.
 * @param signal - Optional cancellation.
 * @returns The raw log entries, or a user-presentable error.
 */
async function fetchApprovalLogs(
  base: string,
  networkName: string,
  paddedOwner: string,
  range: BlockRange,
  signal?: AbortSignal
): Promise<ApprovalsResult<unknown[]>> {
  const page = await explorerRpc<unknown>(
    base,
    networkName,
    "eth_getLogs",
    [
      {
        fromBlock: toHexQuantity(range.fromBlock),
        toBlock: toHexQuantity(range.toBlock),
        topics: [APPROVAL_TOPIC0, paddedOwner],
      },
    ],
    signal
  )
  if (!page.ok) return page

  if (!Array.isArray(page.value)) {
    return { ok: false, error: `${networkName} returned an unusable response.` }
  }
  if (page.value.length > MAX_PAGE_LENGTH) {
    // A page this size cannot be a legitimate capped result, and spreading it
    // into the accumulator could exhaust the call stack.
    return { ok: false, error: `${networkName} returned an oversized log page.` }
  }
  return { ok: true, value: page.value }
}

interface LogCollection {
  logs: unknown[]
  truncated: boolean
}

/**
 * Walk a network's whole history for the owner's Approval logs.
 *
 * A shared worklist of block ranges is drained by a few small workers. When a
 * page comes back at the explorer's cap, its range is split in half and both
 * halves go back to the front of the queue — the capped page itself is
 * discarded and re-fetched as part of the halves, so no log is counted twice
 * and no log is missed. Two hard bounds keep a hostile or pathological
 * explorer from holding the scan open: total requests and total logs; when
 * either trips, the result says `truncated` so the UI can be honest that older
 * approvals may be missing. The seed chunk adapts to the chain height (see
 * {@link MAX_SEED_CHUNKS}); on mainnet it stays at the measured 2M default.
 *
 * @param base - Explorer base URL.
 * @param networkName - Human-readable name for error sentences.
 * @param paddedOwner - Owner address in topic encoding.
 * @param latestBlock - Current chain tip.
 * @param signal - Optional cancellation, checked between requests.
 * @returns The collected raw logs and truncation flag, or a presentable error.
 */
async function collectApprovalLogs(
  base: string,
  networkName: string,
  paddedOwner: string,
  latestBlock: number,
  signal?: AbortSignal
): Promise<ApprovalsResult<LogCollection>> {
  const seedSize = Math.max(CHUNK_BLOCK_SIZE, Math.ceil((latestBlock + 1) / MAX_SEED_CHUNKS))
  const queue: BlockRange[] = chunkBlockRanges(latestBlock, seedSize)

  const logs: unknown[] = []
  let requestCount = 0
  let truncated = false
  let exhausted = false
  let failure = ""

  const worker = async (): Promise<void> => {
    while (failure === "" && !exhausted) {
      if (signal?.aborted) {
        failure = "The scan was cancelled."
        return
      }
      const range = queue.shift()
      if (range === undefined) return

      if (requestCount >= MAX_LOG_REQUESTS_PER_NETWORK) {
        truncated = true
        exhausted = true
        return
      }
      requestCount += 1

      const page = await fetchApprovalLogs(base, networkName, paddedOwner, range, signal)
      if (!page.ok) {
        failure = page.error
        return
      }

      if (needsSplitting(page.value.length, LOG_PAGE_CAP)) {
        const halves = splitBlockRange(range)
        if (halves !== null) {
          queue.unshift(halves[0], halves[1])
          continue
        }
        // A single block at the page cap cannot be narrowed further; keep what
        // the page did return and flag that the network's result is incomplete.
        truncated = true
      }

      logs.push(...page.value)
      if (logs.length >= MAX_LOGS_PER_NETWORK) {
        truncated = true
        exhausted = true
        return
      }
    }
  }

  const workerCount = Math.min(SCAN_CONCURRENCY, Math.max(queue.length, 1))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  if (failure !== "") return { ok: false, error: failure }
  return { ok: true, value: { logs, truncated } }
}

// ===== Current allowance and token metadata =====

/**
 * Read the live allowance for every pair through the app's pooled RPC.
 *
 * The pooled provider — not the explorer — is used on purpose: it carries the
 * app's endpoint failover, and a current balance is only as trustworthy as the
 * node that served it. Pairs whose call fails or whose result is undecodable
 * are skipped (counted and logged once in aggregate): an unreadable allowance
 * must not display as zero, which would hide a live approval, and must not
 * display at all, which would invent one. Zero allowances are simply inactive.
 *
 * @param networkKey - Network to read allowances on.
 * @param owner - The approved owner address.
 * @param pairs - Distinct pairs found in history.
 * @param signal - Optional cancellation.
 * @returns Pairs with a confirmed non-zero current allowance.
 */
async function readCurrentAllowances(
  networkKey: string,
  owner: string,
  pairs: readonly ApprovalPair[],
  signal?: AbortSignal
): Promise<ActiveApproval[]> {
  const active: ActiveApproval[] = []
  let failed = 0

  for (let offset = 0; offset < pairs.length; offset += ALLOWANCE_BATCH_SIZE) {
    if (signal?.aborted) return active
    const batch = pairs.slice(offset, offset + ALLOWANCE_BATCH_SIZE)
    const settled = await Promise.allSettled(
      batch.map((pair) =>
        withProvider(
          networkKey,
          async (provider) =>
            decodeAllowanceResult(
              await provider.call({
                to: pair.token,
                data: ERC20_INTERFACE.encodeFunctionData("allowance", [owner, pair.spender]),
              })
            ),
          signal
        )
      )
    )

    for (let index = 0; index < settled.length; index++) {
      const outcome = settled[index]
      if (outcome.status !== "fulfilled") {
        failed += 1
        continue
      }
      const value = outcome.value
      if (value === null || value <= 0n) continue
      active.push({
        networkKey,
        token: batch[index].token,
        spender: batch[index].spender,
        allowance: value,
        unlimited: isUnlimitedAllowance(value),
      })
    }
  }

  if (failed > 0) {
    logger.warn("Some allowance reads failed during the approval scan", {
      network: networkKey,
      failed,
    })
  }
  return active
}

/**
 * Parse a token's decimals from the explorer's token endpoint.
 *
 * Nulls, fractions, negatives, and absurd magnitudes all yield null — a wrong
 * decimals value misformats the allowance by orders of magnitude, and a silent
 * default would present that guess as fact.
 */
function parseDecimalsField(raw: unknown): number | null {
  let candidate: number
  if (typeof raw === "number") {
    candidate = raw
  } else if (typeof raw === "string" && /^\d{1,3}$/.test(raw)) {
    candidate = Number(raw)
  } else {
    return null
  }
  return Number.isInteger(candidate) && candidate >= 0 && candidate <= 36 ? candidate : null
}

/**
 * Clean a free-text field (symbol or name) for display.
 *
 * Mirrors the private helper in `lib/tokenDetection.ts`, which is not exported:
 * control characters become spaces, whitespace collapses, and the result is
 * clamped by code points so a multi-byte character is never cut in half.
 */
function cleanDisplayText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  if (cleaned === "") return null
  const characters = [...cleaned]
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength).join("")}…`
    : cleaned
}

/**
 * Parse a token's USD price from the explorer's `exchange_rate` field.
 *
 * The field is a decimal string (or occasionally null) from a hostile
 * endpoint. Zero, negative, non-finite, and unparsable values all yield null
 * rather than 0: an unknown price and a free token are different facts, and
 * conflating them would show a phantom "$0.00" exposure — the same
 * missing-price-is-missing-value philosophy the portfolio module applies.
 *
 * Exported for unit tests.
 *
 * @param raw - Candidate `exchange_rate` value. Hostile input.
 * @returns The price, or null.
 */
export function parseTokenPriceUsd(raw: unknown): number | null {
  let candidate: number
  if (typeof raw === "number") {
    // Some Blockscout deployments emit a JSON number where the documented
    // shape says string; both are accepted, both validated identically.
    candidate = raw
  } else if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed === "" || !/^\d+(\.\d+)?$/.test(trimmed)) return null
    candidate = Number(trimmed)
  } else {
    return null
  }
  return Number.isFinite(candidate) && candidate > 0 ? candidate : null
}

/**
 * Estimate a finite allowance's USD exposure.
 *
 * Pure: the UI supplies the already-humanized allowance string and the
 * validated per-token price; neither the bigint nor the decimals need to be
 * re-derived here. Any unusable input — a non-finite or non-positive allowance,
 * or a null/zero price — yields null so the caller renders nothing rather than
 * inventing a number. An *unlimited* allowance never reaches this function by
 * convention: infinity times any price is not a fact worth displaying.
 *
 * @param allowanceHuman - Human-readable allowance, e.g. `"2500.5"`.
 * @param priceUsd - Token price in USD, or null when no quote is available.
 * @returns The exposure in USD, or null.
 */
export function estimateAllowanceUsd(
  allowanceHuman: string,
  priceUsd: number | null
): number | null {
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return null
  if (typeof allowanceHuman !== "string") return null
  const trimmed = allowanceHuman.trim()
  // Plain decimals only — the exact shape `formatBalanceForDisplay` emits.
  // Anything else (a dust marker like "<0.000001", a locale-grouped number) is
  // not an estimate-able amount and reads as null.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const allowance = Number(trimmed)
  if (!Number.isFinite(allowance) || allowance <= 0) return null
  const exposure = allowance * priceUsd
  return Number.isFinite(exposure) ? exposure : null
}

/** Enrichment metadata for one token, all fields optional by design. */
interface TokenMetadata {
  tokenSymbol?: string
  tokenName?: string
  tokenDecimals?: number
  tokenPriceUsd?: number | null
}

/**
 * Fetch one token's metadata from the explorer's public `api/v2` endpoint.
 *
 * Enrichment, not a dependency: any failure returns null and the row degrades
 * to raw addresses rather than disappearing.
 */
async function fetchTokenMetadata(
  base: string,
  token: string,
  signal?: AbortSignal
): Promise<TokenMetadata | null> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${base}/api/v2/tokens/${token}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    if (!isRecord(payload)) return null

    const symbol = cleanDisplayText(payload.symbol, MAX_SYMBOL_LENGTH)
    const name = cleanDisplayText(payload.name, MAX_NAME_LENGTH)
    const decimals = parseDecimalsField(payload.decimals)
    const priceUsd = parseTokenPriceUsd(payload.exchange_rate)

    const metadata: TokenMetadata = {}
    if (symbol !== null) metadata.tokenSymbol = symbol
    if (name !== null) metadata.tokenName = name
    if (decimals !== null) metadata.tokenDecimals = decimals
    // Null is meaningful ("the explorer knows the token but not its price") and
    // is stored, so the row can honestly omit the USD line rather than
    // re-attempt a price it will not get.
    metadata.tokenPriceUsd = priceUsd
    return metadata
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** Distinct token contracts among the active approvals, in first-seen order. */
function uniqueTokenAddresses(approvals: readonly ActiveApproval[]): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const approval of approvals) {
    const key = approval.token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tokens.push(approval.token)
  }
  return tokens
}

/**
 * Fetch metadata for every distinct token, in small parallel batches.
 *
 * @returns Metadata keyed by lowercase token address; tokens that fail are absent.
 */
async function fetchTokensMetadata(
  base: string,
  tokens: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, TokenMetadata>> {
  const metadata = new Map<string, TokenMetadata>()
  for (let offset = 0; offset < tokens.length; offset += METADATA_BATCH_SIZE) {
    if (signal?.aborted) return metadata
    const batch = tokens.slice(offset, offset + METADATA_BATCH_SIZE)
    const settled = await Promise.allSettled(
      batch.map((token) => fetchTokenMetadata(base, token, signal))
    )
    for (let index = 0; index < settled.length; index++) {
      const outcome = settled[index]
      if (outcome.status === "fulfilled" && outcome.value !== null) {
        metadata.set(batch[index].toLowerCase(), outcome.value)
      }
    }
  }
  return metadata
}

/**
 * Display order for active approvals.
 *
 * Unlimited approvals first — they are the ones that can drain an account —
 * then alphabetical by token (address as fallback) and spender, so the order
 * is stable across renders and never implies a ranking the data cannot support.
 */
function compareActiveApprovals(a: ActiveApproval, b: ActiveApproval): number {
  if (a.unlimited !== b.unlimited) return a.unlimited ? -1 : 1
  const nameA = a.tokenSymbol ?? a.token
  const nameB = b.tokenSymbol ?? b.token
  if (nameA !== nameB) return nameA < nameB ? -1 : 1
  if (a.spender !== b.spender) return a.spender < b.spender ? -1 : 1
  return 0
}

// ===== Scan =====

/**
 * Scan one network for the owner's approvals and their current allowances.
 *
 * Only the address crosses this boundary. The walk is: chain tip, then log
 * pages over adaptive chunked ranges with cap-triggered splitting, then live
 * `allowance()` reads through the pooled RPC, then token metadata enrichment.
 * Every failure mode degrades to a single user-presentable error sentence —
 * the caller never has to catch.
 *
 * @param networkKey - Network key; must exist in {@link EXPLORER_APIS}.
 * @param address - Owner address. Public information.
 * @param signal - Optional cancellation, e.g. an unmount or account switch.
 * @returns The pairs, the active approvals, and the truncation flag, or an error.
 */
export async function scanApprovals(
  networkKey: string,
  address: string,
  signal?: AbortSignal
): Promise<ApprovalsResult<NetworkApprovals>> {
  const api = EXPLORER_APIS[networkKey]
  if (api === undefined) {
    return { ok: false, error: `Approval scanning is not available on "${networkKey}".` }
  }
  if (!isEthAddress(address)) {
    return { ok: false, error: "This is not a valid Ethereum address." }
  }

  const networkName = NETWORKS[networkKey]?.name ?? networkKey
  const owner = toChecksummed(address)
  if (owner === null) {
    return { ok: false, error: "This is not a valid Ethereum address." }
  }

  const tip = await explorerRpc<unknown>(api.base, networkName, "eth_blockNumber", [], signal)
  if (!tip.ok) return tip
  const latestBlock = parseBlockQuantity(tip.value)
  if (latestBlock === null) {
    return { ok: false, error: `${networkName} returned an unusable response.` }
  }

  const collection = await collectApprovalLogs(
    api.base,
    networkName,
    padTopicAddress(owner),
    latestBlock,
    signal
  )
  if (!collection.ok) return collection

  const extraction = extractApprovalPairs(collection.value.logs, MAX_PAIRS_PER_NETWORK)

  const active = await readCurrentAllowances(networkKey, owner, extraction.pairs, signal)
  if (signal?.aborted) return { ok: false, error: "The scan was cancelled." }

  const metadata = await fetchTokensMetadata(
    api.base,
    uniqueTokenAddresses(active),
    signal
  )
  if (signal?.aborted) return { ok: false, error: "The scan was cancelled." }

  const current = active
    .map((approval) => ({
      ...approval,
      ...(metadata.get(approval.token.toLowerCase()) ?? {}),
    }))
    .sort(compareActiveApprovals)

  return {
    ok: true,
    value: {
      pairs: extraction.pairs,
      current,
      truncated: collection.value.truncated || extraction.truncated,
    },
  }
}

/**
 * Scan every network in {@link EXPLORER_APIS} for the owner's approvals.
 *
 * Each network is scanned independently via `Promise.allSettled`, mirroring
 * `detectTokensAcrossNetworks`: one unreachable explorer costs one muted note
 * naming it, never the whole scan. Only when every network fails is the result
 * an error. Only an address ever crosses this boundary.
 *
 * @param address - Account to scan. Public information.
 * @param signal - Optional cancellation for the whole batch.
 * @returns The per-network snapshot, or a user-presentable error.
 */
export async function scanApprovalsAcrossNetworks(
  address: string,
  signal?: AbortSignal
): Promise<ApprovalsResult<ApprovalScanSnapshot>> {
  if (!isEthAddress(address)) {
    return { ok: false, error: "This is not a valid Ethereum address." }
  }

  const keys = Object.keys(EXPLORER_APIS)
  const settled = await Promise.allSettled(
    keys.map((key) => scanApprovals(key, address, signal))
  )

  // `fetch` cannot un-send a request, so results can still arrive after an
  // abort; report cancellation rather than a partial snapshot.
  if (signal?.aborted) {
    return { ok: false, error: "The scan was cancelled." }
  }

  const networks: NetworkApprovalScan[] = settled.map((outcome, index) => {
    const networkKey = keys[index]
    const config = NETWORKS[networkKey]
    const base = {
      networkKey,
      networkName: config?.name ?? networkKey,
      isTestnet: config?.type === "testnet",
    }

    if (outcome.status === "fulfilled" && outcome.value.ok) {
      return {
        ...base,
        status: "ok" as const,
        approvals: outcome.value.value.current,
        pairsFound: outcome.value.value.pairs.length,
        truncated: outcome.value.value.truncated,
        error: "",
      }
    }

    // `scanApprovals` never rejects, so a rejection here is a bug; degrade to
    // a generic per-network failure rather than crashing the card.
    const error =
      outcome.status === "fulfilled" && !outcome.value.ok
        ? outcome.value.error
        : "The scan failed unexpectedly."
    logger.warn("Approval scan failed for a network", { network: networkKey })
    return {
      ...base,
      status: "failed" as const,
      approvals: [],
      pairsFound: 0,
      truncated: false,
      error,
    }
  })

  const failures = networks.filter((network) => network.status === "failed")
  if (failures.length === networks.length) {
    return { ok: false, error: `Could not reach any explorer. ${failures[0].error}` }
  }

  return {
    ok: true,
    value: { address, networks, failures, fetchedAt: Date.now() },
  }
}

// ===== Revoke =====

/**
 * Revoke one approval by sending `approve(spender, 0)`.
 *
 * Mirrors `SendForm`'s ceremony exactly, because the same failure modes and
 * the same safety properties apply:
 *
 * 1. **Estimate first.** `estimateGas` through the pooled provider; a revert
 *    aborts before any fee is spent, with the error surfaced.
 * 2. **Sign locally.** The key never leaves this function's frame; it is never
 *    logged, and the signer exists only inside the broadcast callback.
 * 3. **Broadcast exactly once.** `withProviderOnce` deliberately does not
 *    retry or fail over: an ambiguous timeout might already be on-chain, and
 *    resubmitting could double-spend the fee.
 * 4. **Record honestly.** `saveTransaction` writes a pending record the moment
 *    a hash exists (a storage failure is reported, not fatal — the transaction
 *    is already on the network), then the receipt resolves it to success,
 *    failed, or unknown. A missing receipt stays "unknown": reporting it as
 *    success would claim a revoke that may not have happened.
 *
 * @param networkKey - Network to revoke on.
 * @param account - The key-holding account; the key is used only to sign.
 * @param token - Token contract whose allowance is being revoked.
 * @param spender - The approval's spender.
 * @param currency - Native currency symbol for the history record (the fee asset).
 * @returns The transaction hash with its resolved status, or a presentable error.
 */
export async function revokeApproval(
  networkKey: string,
  account: { address: string; privateKey: string },
  token: string,
  spender: string,
  currency: string
): Promise<RevokeResult> {
  if (!isEthAddress(account.address)) {
    return { ok: false, error: "This is not a valid Ethereum address." }
  }
  if (!isEthAddress(token)) {
    return { ok: false, error: "That token address is not valid." }
  }
  if (!isEthAddress(spender)) {
    return { ok: false, error: "That spender address is not valid." }
  }
  if (typeof account.privateKey !== "string" || account.privateKey === "") {
    return { ok: false, error: "This account has no private key to sign with." }
  }

  // Validate the key before anything touches the network, and make sure it
  // actually controls the account being shown: a mismatched key would revoke
  // a different account's approval than the one the user is looking at.
  let signer: Wallet
  try {
    signer = new Wallet(account.privateKey)
  } catch {
    return { ok: false, error: "This account has no usable private key." }
  }
  const owner = toChecksummed(account.address)
  const tokenContract = toChecksummed(token)
  const spenderAddress = toChecksummed(spender)
  if (owner === null || tokenContract === null || spenderAddress === null) {
    return { ok: false, error: "That address is not valid." }
  }
  if (signer.address !== owner) {
    return { ok: false, error: "The unlocked key does not control this address." }
  }

  const request: TransactionRequest = {
    to: tokenContract,
    data: ERC20_INTERFACE.encodeFunctionData("approve", [spenderAddress, 0n]),
  }

  try {
    // Estimate as the account itself, so token-side owner checks are simulated
    // honestly. A revert here means the revoke cannot succeed on-chain.
    try {
      const estimated = await withProvider(networkKey, (provider) =>
        provider.estimateGas({ ...request, from: owner })
      )
      request.gasLimit = (estimated * 120n) / 100n
    } catch (estError) {
      logger.warn("Revoke gas estimation failed", { network: networkKey, error: estError })
      return {
        ok: false,
        error:
          estError instanceof RpcError
            ? estError.userMessage
            : "This transaction is expected to fail, so it was not sent. The token contract may not allow revoking this spender.",
      }
    }

    // Broadcast exactly once; no retry, no failover. See the function doc.
    const response = await withProviderOnce(networkKey, async (provider) => {
      const wallet = new Wallet(account.privateKey, provider)
      return wallet.sendTransaction(request)
    })

    const txHash = response.hash

    // The transaction is on the network now; a history failure must not read
    // as a failed revoke, so it rides along as a warning instead.
    const saved = saveTransaction({
      hash: txHash,
      network: networkKey,
      from: owner,
      to: tokenContract,
      amount: "0",
      currency,
      status: "pending",
    })
    const historyWarning = saved.ok ? undefined : saved.error

    try {
      const receipt = await response.wait(1)
      if (receipt === null) {
        updateTransactionStatus(txHash, "unknown")
        return { ok: true, txHash, status: "unknown", historyWarning }
      }
      if (receipt.status === 1) {
        updateTransactionStatus(txHash, "success")
        return { ok: true, txHash, status: "success", historyWarning }
      }
      updateTransactionStatus(txHash, "failed")
      return { ok: true, txHash, status: "failed", historyWarning }
    } catch (confirmError) {
      // Broadcast but unconfirmed: neither a success nor a failure.
      logger.warn("Revoke confirmation wait failed", { network: networkKey, error: confirmError })
      updateTransactionStatus(txHash, "unknown")
      return { ok: true, txHash, status: "unknown", historyWarning }
    }
  } catch (sendError) {
    // No hash exists in this path — `withProviderOnce` throwing means the
    // broadcast never resolved, so there is no history record to correct.
    logger.error("Revoke failed", { network: networkKey, error: sendError })
    return {
      ok: false,
      error:
        sendError instanceof RpcError
          ? sendError.userMessage
          : describeError(sendError, "The transaction could not be sent."),
    }
  }
}
