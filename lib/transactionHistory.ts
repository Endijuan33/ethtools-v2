/**
 * Bounded, validated, quota-safe transaction history.
 *
 * Three properties matter here and none of them held before:
 *
 * 1. **A write must never throw.** `saveTransaction` runs immediately after a
 *    transaction has been broadcast. A raw `localStorage.setItem` throws
 *    `QuotaExceededError` when the origin is full — Safari private browsing
 *    grants almost no quota — and that throw surfaced to the user as a failed
 *    send for a transaction that was already on-chain. Every mutation here
 *    returns a {@link HistoryResult} instead.
 * 2. **Memory must stay bounded.** The cap is enforced on read as well as on
 *    write, because `localStorage` is writable by any script on the origin and a
 *    legacy or hostile value can hold far more than the cap. A byte budget sits
 *    on top of the item cap so a payload of maximum-length records still fits.
 * 3. **Records must be validated individually.** An `Array.isArray` check let a
 *    malformed record through to the UI, where a bogus `hash` reached an
 *    explorer `href`. Every record is re-validated through `lib/schema` and
 *    rebuilt field by field, which also strips unexpected keys.
 */

import { logger } from "./logger"
import { filterValid, isRecord, isStoredTransaction, type StoredTransaction } from "./schema"
import { STORAGE_KEYS, readJson, removeKey, writeJson } from "./storage"
import type { Network } from "./ethers"
import { APP_EVENTS, emitAppEvent } from "./appEvents"

// ===== Types =====

/**
 * Terminal and non-terminal states a record can hold.
 *
 * Derived from the schema so the two can never drift. `"unknown"` exists for the
 * real case where a transaction was broadcast but no receipt could be obtained:
 * reporting that as `"success"` claims more than the app knows.
 */
export type TransactionStatus = StoredTransaction["status"]

/** A recorded transaction. */
export interface Transaction {
  /**
   * Stable per-record identifier.
   *
   * Duplicate hashes are possible (a resubmitted transaction, an imported
   * backup, a pre-broadcast failure), so a hash is not a key. Deletion is
   * id-based; {@link deleteTransactionByHash} is kept only for compatibility.
   */
  id: string
  /** Transaction hash. */
  hash: string
  /** Network key the transaction was sent on. */
  network: Network
  /** Sender address. */
  from: string
  /** Recipient address. */
  to: string
  /** Amount sent, as a decimal display string. */
  amount: string
  /** Currency symbol, for example ETH or USDC. */
  currency: string
  /** Unix timestamp in milliseconds. */
  timestamp: number
  /** Current known status. */
  status: TransactionStatus
}

/** Fields a caller supplies when recording a transaction. */
export type NewTransaction = Omit<Transaction, "id" | "timestamp"> & {
  /** Caller-supplied id. One is generated when omitted. */
  id?: string
  /** Explicit timestamp. Defaults to now. */
  timestamp?: number
}

/**
 * Outcome of a mutation.
 *
 * Mirrors `WriteResult` from `lib/storage` and adds the two failures this module
 * can detect before it reaches the storage layer, so a caller can tell "storage
 * is full" apart from "that record was never valid".
 */
export type HistoryResult =
  | { ok: true }
  | {
      ok: false
      error: string
      reason:
        | "quota-exceeded"
        | "unavailable"
        | "serialize-failed"
        | "invalid-record"
        | "not-found"
    }

/** A page of history plus the totals needed to render pagination. */
export interface TransactionPage {
  /** Records for the requested page only. Never the whole list. */
  data: Transaction[]
  /** Total records matching the filter, across all pages. */
  totalItems: number
  /** Total pages, at least 1. */
  totalPages: number
  /** The page actually returned, clamped into range. */
  page: number
}

// ===== Bounds =====

/**
 * Maximum records retained.
 *
 * Enforced on read too: a value already sitting in `localStorage` from an older
 * build, or written by another script, can exceed it, and rendering 50,000
 * records would stall the main thread regardless of who wrote them.
 */
const MAX_HISTORY_ITEMS = 500

/**
 * Byte budget for the serialised payload.
 *
 * `localStorage` quotas are typically 5 MB per origin and shared with the
 * encrypted vault, custom networks, and bookmarks. Staying near 1.5 MB leaves
 * room for the vault, which the user cannot afford to lose. Exceeding the budget
 * drops the oldest records rather than failing the write, because a dropped
 * history row is recoverable and a lost transaction record is not.
 */
const MAX_HISTORY_BYTES = 1_500_000

/** Fraction of the list retained when a quota-exceeded write is retried once. */
const QUOTA_RETRY_KEEP_FRACTION = 0.5

/** Default page size for {@link getTransactionHistory}. */
const DEFAULT_PAGE_SIZE = 10

// ===== Internal helpers =====

/** Array shape guard for the raw stored value. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/**
 * Whether a stored value is a transaction record, with or without an id.
 *
 * Records written before ids existed are still valid; {@link toTransaction}
 * derives a deterministic id for them.
 *
 * @param value - Candidate parsed from storage or a backup.
 */
function isHistoryRecord(value: unknown): value is StoredTransaction & { id?: unknown } {
  if (!isRecord(value)) return false
  if (!isStoredTransaction(value)) return false
  const { id } = value
  return id === undefined || (typeof id === "string" && id.length > 0 && id.length <= 128)
}

/**
 * Derive a stable id for a record that predates ids.
 *
 * Deterministic on purpose: generating a fresh id per read would break id-based
 * deletion, because the id the UI rendered would not exist on the next read.
 *
 * @param hash - Transaction hash.
 * @param timestamp - Record timestamp in milliseconds.
 */
function legacyId(hash: string, timestamp: number): string {
  return `legacy-${hash}-${timestamp}`
}

/** Generate an id, preferring the platform UUID when it is available. */
function createId(): string {
  const platformCrypto = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto
  if (platformCrypto !== undefined && typeof platformCrypto.randomUUID === "function") {
    return platformCrypto.randomUUID()
  }
  return `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Rebuild a validated record field by field.
 *
 * The explicit copy is deliberate: it drops any extra key a hostile payload
 * carried, so nothing unexpected survives into React state or a later re-write.
 *
 * @param record - Record that already passed {@link isHistoryRecord}.
 */
function toTransaction(record: StoredTransaction & { id?: unknown }): Transaction {
  const { id } = record
  return {
    id: typeof id === "string" && id.length > 0 ? id : legacyId(record.hash, record.timestamp),
    hash: record.hash,
    network: record.network,
    from: record.from,
    to: record.to,
    amount: record.amount,
    currency: record.currency,
    timestamp: record.timestamp,
    status: record.status,
  }
}

/**
 * Build a storable record from caller-supplied fields.
 *
 * Validation happens before anything is written, because a record the schema
 * rejects would be dropped on the very next read: writing it would report
 * success for data that is already lost.
 *
 * @param tx - Caller-supplied fields.
 * @returns The record, or null when it would not survive a round trip.
 */
function buildRecord(tx: NewTransaction): Transaction | null {
  const candidate = {
    id: tx.id !== undefined && tx.id.length > 0 ? tx.id : createId(),
    hash: tx.hash,
    network: tx.network,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    currency: tx.currency,
    timestamp: tx.timestamp ?? Date.now(),
    status: tx.status,
  }
  return isHistoryRecord(candidate) ? toTransaction(candidate) : null
}

/**
 * Approximate the stored size of a payload.
 *
 * Browser quotas are counted in UTF-16 code units, which is exactly what
 * `String.length` reports, so the serialised length is the right unit.
 *
 * @param list - Records about to be written.
 */
function serializedLength(list: readonly Transaction[]): number {
  try {
    return JSON.stringify(list).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Drop the oldest records until the payload fits the byte budget.
 *
 * Removes a proportion per pass rather than one record at a time so an oversized
 * legacy payload converges in a handful of serialisations instead of hundreds.
 *
 * @param list - Records, newest first.
 */
function fitToByteBudget(list: Transaction[]): Transaction[] {
  let current = list
  let dropped = 0

  while (current.length > 1 && serializedLength(current) > MAX_HISTORY_BYTES) {
    const remove = Math.max(1, Math.floor(current.length / 10))
    current = current.slice(0, current.length - remove)
    dropped += remove
  }

  if (dropped > 0) {
    logger.warn("Trimmed transaction history to fit the storage byte budget", {
      dropped,
      retained: current.length,
      budgetBytes: MAX_HISTORY_BYTES,
    })
  }
  return current
}

/**
 * Apply the item cap, keeping the newest records.
 * @param list - Records, newest first.
 */
function capItems(list: Transaction[]): Transaction[] {
  if (list.length <= MAX_HISTORY_ITEMS) return list
  logger.warn("Trimmed transaction history to the retention cap", {
    dropped: list.length - MAX_HISTORY_ITEMS,
    cap: MAX_HISTORY_ITEMS,
  })
  return list.slice(0, MAX_HISTORY_ITEMS)
}

/**
 * Persist a list, recovering once from a full quota.
 *
 * Never throws. On `quota-exceeded` the oldest half is dropped and the write is
 * retried exactly once; a second failure is returned so the caller can show a
 * real message.
 *
 * @param list - Records, newest first.
 */
function persist(list: Transaction[]): HistoryResult {
  const bounded = fitToByteBudget(capItems(list))

  const first = writeJson(STORAGE_KEYS.TRANSACTION_HISTORY, bounded)
  if (first.ok) return { ok: true }
  if (first.reason !== "quota-exceeded" || bounded.length <= 1) return first

  const keep = Math.max(1, Math.floor(bounded.length * QUOTA_RETRY_KEEP_FRACTION))
  logger.warn("Storage quota reached; retrying the history write with older records dropped", {
    before: bounded.length,
    after: keep,
  })

  const retry = writeJson(STORAGE_KEYS.TRANSACTION_HISTORY, bounded.slice(0, keep))
  return retry.ok ? { ok: true } : retry
}

// ===== Public API =====

/**
 * Notify other components that history changed.
 *
 * Kept as a DOM event so sibling components refresh without polling storage.
 */
export function triggerHistoryUpdate(): void {
  if (typeof window !== "undefined") {
    emitAppEvent(APP_EVENTS.TRANSACTIONS_CHANGED)
  }
}

/**
 * Read the full history, validated and capped.
 *
 * Invalid records are dropped rather than failing the whole read: one corrupt
 * row must not hide the other four hundred.
 */
export function getTransactionHistoryData(): Transaction[] {
  const raw = readJson<unknown[]>(STORAGE_KEYS.TRANSACTION_HISTORY, isUnknownArray, [])
  return filterValid(raw, isHistoryRecord, MAX_HISTORY_ITEMS).map(toTransaction)
}

/**
 * Read one page of history.
 *
 * The network filter is applied **before** slicing. Filtering a slice instead
 * produced a header reading "5 transactions" above an empty list, because the
 * totals came from the filtered set while the rows came from an unfiltered page.
 *
 * @param page - 1-indexed page number. Clamped into range.
 * @param limit - Records per page.
 * @param network - Optional network key to filter by.
 */
export function getTransactionHistory(
  page: number = 1,
  limit: number = DEFAULT_PAGE_SIZE,
  network?: Network
): TransactionPage {
  const safeLimit = Math.min(
    Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_PAGE_SIZE),
    MAX_HISTORY_ITEMS
  )

  const all = getTransactionHistoryData()
  const matching =
    network === undefined ? all : all.filter((tx) => tx.network === network)

  const totalItems = matching.length
  const totalPages = Math.max(1, Math.ceil(totalItems / safeLimit))
  const safePage = Math.min(
    Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1),
    totalPages
  )

  const startIndex = (safePage - 1) * safeLimit
  return {
    data: matching.slice(startIndex, startIndex + safeLimit),
    totalItems,
    totalPages,
    page: safePage,
  }
}

/**
 * Record a transaction.
 *
 * Called immediately after a broadcast, so it must never throw. The record is
 * validated first: a value the schema would reject cannot survive a reload
 * anyway, and returning `invalid-record` tells the caller that instead of
 * silently writing a row that disappears.
 *
 * @param tx - Transaction fields. `id` and `timestamp` default sensibly.
 */
export function saveTransaction(tx: NewTransaction): HistoryResult {
  const record = buildRecord(tx)
  if (record === null) {
    logger.warn("Refused to record a transaction that failed validation", {
      network: tx.network,
      status: tx.status,
    })
    return {
      ok: false,
      reason: "invalid-record",
      error: "Could not record this transaction: its details are not in a storable form.",
    }
  }

  const result = persist([record, ...getTransactionHistoryData()])
  if (result.ok) triggerHistoryUpdate()
  return result
}

/** Delete every record. */
export function clearTransactionHistory(): HistoryResult {
  removeKey(STORAGE_KEYS.TRANSACTION_HISTORY)
  triggerHistoryUpdate()
  return { ok: true }
}

/**
 * Delete a single record by id.
 *
 * Prefer this over {@link deleteTransactionByHash}: it removes exactly the row
 * the user acted on, even when another record shares the same hash.
 *
 * @param id - Record id from {@link Transaction.id}.
 */
export function deleteTransactionById(id: string): HistoryResult {
  const history = getTransactionHistoryData()
  const remaining = history.filter((tx) => tx.id !== id)
  if (remaining.length === history.length) {
    return {
      ok: false,
      reason: "not-found",
      error: "That transaction record no longer exists.",
    }
  }

  const result = persist(remaining)
  if (result.ok) triggerHistoryUpdate()
  return result
}

/**
 * Delete every record sharing a hash.
 *
 * Retained for compatibility with callers that only hold a hash. It is
 * deliberately broader than {@link deleteTransactionById}, which is what the UI
 * uses, because duplicate hashes are possible.
 *
 * @param hash - Transaction hash.
 */
export function deleteTransactionByHash(hash: string): HistoryResult {
  const history = getTransactionHistoryData()
  const remaining = history.filter((tx) => tx.hash !== hash)
  if (remaining.length === history.length) {
    return {
      ok: false,
      reason: "not-found",
      error: "That transaction record no longer exists.",
    }
  }

  const result = persist(remaining)
  if (result.ok) triggerHistoryUpdate()
  return result
}

/**
 * Update the status of every record sharing a hash.
 *
 * @param hash - Transaction hash.
 * @param status - New status. Use `"unknown"` when no receipt could be obtained,
 *   rather than claiming success.
 */
export function updateTransactionStatus(
  hash: string,
  status: TransactionStatus
): HistoryResult {
  const history = getTransactionHistoryData()
  let found = false

  const updated = history.map((tx) => {
    if (tx.hash !== hash) return tx
    found = true
    return { ...tx, status }
  })

  if (!found) {
    return {
      ok: false,
      reason: "not-found",
      error: "That transaction record no longer exists.",
    }
  }

  const result = persist(updated)
  if (result.ok) triggerHistoryUpdate()
  return result
}

/**
 * Count records, optionally for one network.
 * @param network - Network key, or omitted for all networks.
 */
export function getTransactionCount(network?: Network): number {
  const all = getTransactionHistoryData()
  if (network === undefined) return all.length
  return all.filter((tx) => tx.network === network).length
}
