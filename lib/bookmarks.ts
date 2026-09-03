/**
 * Bounded, validated, quota-safe address bookmarks.
 *
 * A bookmark's address is rendered into an explorer `href` and pre-filled into
 * the send form's recipient field, so an unvalidated one is not merely untidy —
 * it is a way to make the UI point somewhere the user did not choose.
 * `saveBookmark` previously accepted any string, wrote it with a bare
 * `localStorage.setItem` (which throws when the quota is full), and never
 * checked for an existing entry even though `isAddressBookmarked` was right
 * there. All persistence now goes through `lib/storage`, every record is
 * re-validated through `lib/schema` on read, and every mutation returns a result
 * instead of throwing.
 */

import { getAddress, isAddress } from "ethers"
import { truncateHex } from "./format"
import { logger } from "./logger"
import {
  filterValid,
  isIntegerInRange,
  isRecord,
  isStoredBookmark,
  isStoredCustomNetwork,
  WALLET_DATA_EXPORT_VERSION,
  type WalletDataExport,
} from "./schema"
import { STORAGE_KEYS, writeJson, writeJsonAtomic, readJson } from "./storage"
import { getCustomNetworks, NETWORKS, type Network } from "./ethers"
import { APP_EVENTS, emitAppEvent } from "./appEvents"

// ===== Types =====

/** A saved address label. */
export interface Bookmark {
  /** Stable identifier, used for updates and deletion. */
  id: string
  /** Checksummed Ethereum address. */
  address: string
  /** Human-readable label. */
  label: string
  /** Network key this bookmark is scoped to. Absent means all networks. */
  network?: Network
  /** Unix timestamp in milliseconds. */
  createdAt: number
}

/**
 * Why a bookmark mutation failed.
 *
 * The storage reasons mirror `WriteResult` from `lib/storage`; the rest are
 * detected here, before anything is persisted.
 */
export type BookmarkFailure =
  | "invalid-address"
  | "invalid-label"
  | "invalid-network"
  | "duplicate"
  | "limit-reached"
  | "not-found"
  | "quota-exceeded"
  | "unavailable"
  | "serialize-failed"

/** Outcome of a create, carrying the stored record on success. */
export type SaveBookmarkResult =
  | { ok: true; bookmark: Bookmark }
  | { ok: false; error: string; reason: BookmarkFailure }

/** Outcome of an update or delete. */
export type BookmarkResult =
  | { ok: true }
  | { ok: false; error: string; reason: BookmarkFailure }

// ===== Bounds =====

/**
 * Maximum bookmarks retained.
 *
 * Enforced on read as well as write: the stored value is writable by any script
 * on the origin, so the cap cannot rely on having been applied at write time.
 */
const MAX_BOOKMARKS = 500

/**
 * Maximum label length.
 *
 * The schema drops any record whose label exceeds 128 characters, so a longer
 * label would be silently lost on the next read. Rejecting it up front with a
 * clear message is honest; truncating would quietly discard what the user typed.
 */
const MAX_LABEL_LENGTH = 64

/** Maximum network-key length, matching the schema's own bound. */
const MAX_NETWORK_KEY_LENGTH = 64

// ===== Internal helpers =====

/** Array shape guard for the raw stored value. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** Generate an id, preferring the platform UUID when it is available. */
function createId(): string {
  const platformCrypto = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto
  if (platformCrypto !== undefined && typeof platformCrypto.randomUUID === "function") {
    return platformCrypto.randomUUID()
  }
  return `bookmark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Normalise an address to its checksummed form.
 *
 * Storing one canonical casing makes deduplication and display consistent, and
 * `getAddress` rejects a mixed-case address whose checksum does not verify,
 * which catches a single mistyped character that `isAddress` alone would let
 * through only for all-lowercase input.
 *
 * @param value - Candidate address.
 * @returns The checksummed address, or null when the input is not an address.
 */
function normalizeAddress(value: string): string | null {
  const trimmed = value.trim()
  if (!isAddress(trimmed)) return null
  try {
    return getAddress(trimmed)
  } catch {
    return null
  }
}

/**
 * Persist a list of bookmarks.
 *
 * Never throws; a full quota comes back as a result the caller can surface.
 *
 * @param list - Records to store.
 */
function persist(list: Bookmark[]): BookmarkResult {
  const bounded = list.length > MAX_BOOKMARKS ? list.slice(0, MAX_BOOKMARKS) : list
  if (bounded.length !== list.length) {
    logger.warn("Trimmed bookmarks to the retention cap", {
      dropped: list.length - bounded.length,
      cap: MAX_BOOKMARKS,
    })
  }

  const result = writeJson(STORAGE_KEYS.BOOKMARKS, bounded)
  return result.ok ? { ok: true } : result
}

// ===== Public API =====

/**
 * Notify other components that bookmarks changed.
 *
 * A DOM event rather than polling, so an open manager and the send form stay in
 * step without either of them re-reading storage on a timer.
 */
export function triggerBookmarkUpdate(): void {
  if (typeof window !== "undefined") {
    emitAppEvent(APP_EVENTS.BOOKMARKS_CHANGED)
  }
}

/**
 * Read every bookmark, validated and capped.
 *
 * Server-safe: the storage layer falls back to an in-memory backend when
 * `window` is absent, so no caller needs its own `typeof window` guard.
 */
export function getBookmarks(): Bookmark[] {
  const raw = readJson<unknown[]>(STORAGE_KEYS.BOOKMARKS, isUnknownArray, [])
  // Rebuilt field by field so an unexpected key from a hostile payload cannot
  // ride along into React state or back into storage on the next write.
  return filterValid(raw, isStoredBookmark, MAX_BOOKMARKS).map((record) => ({
    id: record.id,
    address: record.address,
    label: record.label,
    network: record.network,
    createdAt: record.createdAt,
  }))
}

/**
 * Whether an address already has a bookmark.
 *
 * Compared case-insensitively, because stored records may predate checksum
 * normalisation.
 *
 * @param address - Address to look for.
 */
export function isAddressBookmarked(address: string): boolean {
  const normalized = address.trim().toLowerCase()
  if (normalized === "") return false
  return getBookmarks().some((b) => b.address.toLowerCase() === normalized)
}

/**
 * Create a bookmark.
 *
 * Rejects an invalid address rather than persisting it: a bad value here later
 * lands in an explorer link and in the send form's recipient field.
 *
 * @param address - Ethereum address. Stored checksummed.
 * @param label - Display label. Falls back to a truncated address when empty.
 * @param network - Optional network key to scope the bookmark to.
 */
export function saveBookmark(
  address: string,
  label: string,
  network?: Network
): SaveBookmarkResult {
  const normalizedAddress = normalizeAddress(address)
  if (normalizedAddress === null) {
    return {
      ok: false,
      reason: "invalid-address",
      error: "Enter a valid Ethereum address.",
    }
  }

  const trimmedLabel = label.trim()
  if (trimmedLabel.length > MAX_LABEL_LENGTH) {
    return {
      ok: false,
      reason: "invalid-label",
      error: `Use a label of ${MAX_LABEL_LENGTH} characters or fewer.`,
    }
  }

  if (network !== undefined && (network === "" || network.length > MAX_NETWORK_KEY_LENGTH)) {
    return {
      ok: false,
      reason: "invalid-network",
      error: "That network cannot be used for a bookmark.",
    }
  }

  const existing = getBookmarks()
  if (existing.some((b) => b.address.toLowerCase() === normalizedAddress.toLowerCase())) {
    return {
      ok: false,
      reason: "duplicate",
      error: "That address is already bookmarked.",
    }
  }

  if (existing.length >= MAX_BOOKMARKS) {
    return {
      ok: false,
      reason: "limit-reached",
      error: `You can keep up to ${MAX_BOOKMARKS} bookmarks. Remove one and try again.`,
    }
  }

  const bookmark: Bookmark = {
    id: createId(),
    address: normalizedAddress,
    label: trimmedLabel === "" ? truncateHex(normalizedAddress) : trimmedLabel,
    network,
    createdAt: Date.now(),
  }

  const result = persist([...existing, bookmark])
  if (!result.ok) return result

  triggerBookmarkUpdate()
  return { ok: true, bookmark }
}

/**
 * Update a bookmark in place.
 *
 * Any supplied address or label is validated exactly as it is on create, so an
 * edit cannot smuggle in a value that a create would have rejected.
 *
 * @param id - Bookmark id.
 * @param data - Fields to change.
 */
export function updateBookmark(
  id: string,
  data: Partial<Omit<Bookmark, "id" | "createdAt">>
): BookmarkResult {
  const bookmarks = getBookmarks()
  const target = bookmarks.find((b) => b.id === id)
  if (target === undefined) {
    return { ok: false, reason: "not-found", error: "That bookmark no longer exists." }
  }

  let nextAddress = target.address
  if (data.address !== undefined) {
    const normalized = normalizeAddress(data.address)
    if (normalized === null) {
      return { ok: false, reason: "invalid-address", error: "Enter a valid Ethereum address." }
    }
    const clash = bookmarks.some(
      (b) => b.id !== id && b.address.toLowerCase() === normalized.toLowerCase()
    )
    if (clash) {
      return { ok: false, reason: "duplicate", error: "That address is already bookmarked." }
    }
    nextAddress = normalized
  }

  let nextLabel = target.label
  if (data.label !== undefined) {
    const trimmed = data.label.trim()
    if (trimmed === "") {
      return { ok: false, reason: "invalid-label", error: "Enter a label." }
    }
    if (trimmed.length > MAX_LABEL_LENGTH) {
      return {
        ok: false,
        reason: "invalid-label",
        error: `Use a label of ${MAX_LABEL_LENGTH} characters or fewer.`,
      }
    }
    nextLabel = trimmed
  }

  let nextNetwork = target.network
  if (data.network !== undefined) {
    if (data.network === "" || data.network.length > MAX_NETWORK_KEY_LENGTH) {
      return {
        ok: false,
        reason: "invalid-network",
        error: "That network cannot be used for a bookmark.",
      }
    }
    nextNetwork = data.network
  }

  const updated = bookmarks.map((b) =>
    b.id === id ? { ...b, address: nextAddress, label: nextLabel, network: nextNetwork } : b
  )

  const result = persist(updated)
  if (!result.ok) return result

  triggerBookmarkUpdate()
  return { ok: true }
}

/**
 * Delete a bookmark.
 * @param id - Bookmark id.
 */
export function deleteBookmark(id: string): BookmarkResult {
  const bookmarks = getBookmarks()
  const remaining = bookmarks.filter((b) => b.id !== id)
  if (remaining.length === bookmarks.length) {
    return { ok: false, reason: "not-found", error: "That bookmark no longer exists." }
  }

  const result = persist(remaining)
  if (!result.ok) return result

  triggerBookmarkUpdate()
  return { ok: true }
}

/**
 * Read bookmarks visible on a network.
 *
 * Unscoped bookmarks are included, since they apply everywhere.
 *
 * @param network - Network key, or omitted for all bookmarks.
 */
export function getBookmarksByNetwork(network?: Network): Bookmark[] {
  const bookmarks = getBookmarks()
  if (network === undefined) return bookmarks
  return bookmarks.filter((b) => b.network === network || b.network === undefined)
}

// ===== Export / import =====

/**
 * Upper bound on an import file's text length.
 *
 * Matches the backup module's byte cap: far above anything the export of a
 * capped bookmark store plus a sane network set can produce, but small enough
 * that a hostile "bookmarks" file cannot make `JSON.parse` chew the main thread.
 */
const MAX_IMPORT_TEXT_LENGTH = 5 * 1024 * 1024

/** Counts an import reports, so the toast can say exactly what happened. */
export interface ImportWalletDataCounts {
  bookmarksAdded: number
  /** Duplicates — already stored, or repeated inside the file itself. */
  bookmarksSkipped: number
  networksAdded: number
  /** Keys already present as custom networks, or shadowing a built-in. */
  networksSkipped: number
}

/** Outcome of an import. Failure carries a complete, user-presentable sentence. */
export type ImportWalletDataResult =
  | { ok: true; counts: ImportWalletDataCounts }
  | { ok: false; error: string }

/**
 * Walk an export-shaped value and return the first precise problem found.
 *
 * This validates exactly what `isWalletDataExport` in `lib/schema` accepts —
 * same version rule, same per-entry guards — but stops at the first defect and
 * names it, because "invalid file" tells the user nothing about *which* entry
 * their edit or transfer corrupted. The two must be changed together.
 *
 * @param value - Parsed file contents. Hostile input.
 * @returns The problem sentence, or null when the shape is a valid export.
 */
function describeWalletDataProblem(value: unknown): string | null {
  if (!isRecord(value)) {
    return "That file does not contain a wallet-data export."
  }
  if (value.version !== WALLET_DATA_EXPORT_VERSION) {
    return `Unsupported export version. This app reads version ${WALLET_DATA_EXPORT_VERSION} files only.`
  }
  if (!isIntegerInRange(value.exportedAt, 0, Number.MAX_SAFE_INTEGER)) {
    return 'The "exportedAt" field is missing or invalid.'
  }
  if (!Array.isArray(value.bookmarks)) {
    return 'The "bookmarks" field is missing or is not a list.'
  }
  for (let index = 0; index < value.bookmarks.length; index++) {
    if (!isStoredBookmark(value.bookmarks[index])) {
      return `Bookmark ${index + 1} is invalid, so the whole file was rejected.`
    }
  }
  if (!isRecord(value.customNetworks)) {
    return 'The "customNetworks" field is missing or is not an object.'
  }
  for (const [key, config] of Object.entries(value.customNetworks)) {
    if (!/^[a-z0-9-]{1,64}$/.test(key)) {
      return `Network key "${key}" is invalid, so the whole file was rejected.`
    }
    if (!isStoredCustomNetwork(config)) {
      return `Custom network "${key}" is invalid, so the whole file was rejected.`
    }
  }
  return null
}

/**
 * Export bookmarks and custom networks as a JSON string.
 *
 * Non-secret by construction: every bookmark is rebuilt field by field from the
 * validated {@link Bookmark} shape (id, address, label, network, createdAt) and
 * every network comes from `getCustomNetworks`, whose shape has no secret
 * member — so no vault, key, or phrase can end up in the file even if one sits
 * in the same store. Validation happens on read (`getBookmarks`,
 * `getCustomNetworks`), so what is serialized is already exactly what the
 * schema will accept on import.
 *
 * Never throws: JSON.stringify over these plain shapes cannot fail, and the
 * read paths degrade to empty stores when storage is unavailable.
 */
export function exportWalletData(): string {
  // Rebuilt explicitly rather than spreading the stored records, so an
  // unexpected key cannot ride along into the export.
  const bookmarks = getBookmarks().map((b) => ({
    id: b.id,
    address: b.address,
    label: b.label,
    network: b.network,
    createdAt: b.createdAt,
  }))
  const customNetworks = getCustomNetworks()
  const file: WalletDataExport = {
    version: WALLET_DATA_EXPORT_VERSION,
    exportedAt: Date.now(),
    bookmarks,
    customNetworks,
  }
  return JSON.stringify(file, null, 2)
}

/**
 * Import a bookmarks + custom-networks export.
 *
 * All-or-nothing after validation, merge-with-dedupe on insert:
 * - The whole file is schema-validated first (`describeWalletDataProblem`); a
 *   single invalid entry rejects it and nothing is written. A half-imported
 *   file would silently disagree with what the user thought they restored.
 * - Once validated, insertion merges: bookmarks whose address is already
 *   stored (case-insensitively, matching `saveBookmark`) and networks whose
 *   key already exists — or would shadow a built-in network, which no code
 *   path may ever do — are skipped and counted, never overwritten.
 * - Both stores are written through `writeJsonAtomic`, so a full quota rolls
 *   the bookmark write back rather than leaving the two stores inconsistent.
 *
 * @param text - Raw file contents. Hostile input.
 * @returns Per-store counts on success, or a precise error sentence.
 */
export function importWalletData(text: string): ImportWalletDataResult {
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, error: "That file is empty." }
  }
  if (text.length > MAX_IMPORT_TEXT_LENGTH) {
    return { ok: false, error: "That file is too large to be a valid export." }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: "That file is not valid JSON." }
  }

  const problem = describeWalletDataProblem(parsed)
  if (problem !== null) {
    return { ok: false, error: problem }
  }
  const file = parsed as WalletDataExport

  const existingBookmarks = getBookmarks()
  const existingNetworks = getCustomNetworks()

  // Deduplicate against the store AND within the file: two entries for the
  // same address are one bookmark, and importing a file twice is a no-op.
  const seenAddresses = new Set(existingBookmarks.map((b) => b.address.toLowerCase()))
  const bookmarksToAdd: Bookmark[] = []
  let bookmarksSkipped = 0
  for (const record of file.bookmarks) {
    const key = record.address.toLowerCase()
    if (seenAddresses.has(key)) {
      bookmarksSkipped += 1
      continue
    }
    seenAddresses.add(key)
    bookmarksToAdd.push({
      id: record.id,
      address: record.address,
      label: record.label,
      network: record.network,
      createdAt: record.createdAt,
    })
  }

  if (existingBookmarks.length + bookmarksToAdd.length > MAX_BOOKMARKS) {
    return {
      ok: false,
      error: `You can keep up to ${MAX_BOOKMARKS} bookmarks; this import would add ${bookmarksToAdd.length} to your existing ${existingBookmarks.length}. Remove some and try again.`,
    }
  }

  const networksToAdd: Record<string, typeof existingNetworks[string]> = {}
  let networksSkipped = 0
  for (const [key, config] of Object.entries(file.customNetworks)) {
    // A stored entry may never shadow a built-in key — an override of
    // "mainnet" would silently repoint Ethereum Mainnet — and an existing
    // custom network is the user's own, so import skips rather than overwrites.
    if (key in NETWORKS || key in existingNetworks) {
      networksSkipped += 1
      continue
    }
    networksToAdd[key] = { ...config, isCustom: true }
  }

  if (bookmarksToAdd.length > 0 || Object.keys(networksToAdd).length > 0) {
    const write = writeJsonAtomic([
      { key: STORAGE_KEYS.BOOKMARKS, value: [...existingBookmarks, ...bookmarksToAdd] },
      {
        key: STORAGE_KEYS.CUSTOM_NETWORKS,
        value: { ...existingNetworks, ...networksToAdd },
      },
    ])
    if (!write.ok) return write

    triggerBookmarkUpdate()
    // Custom networks are only re-read by their consumers on this event, so
    // an imported network would stay invisible until a reload without it.
    emitAppEvent(APP_EVENTS.DATA_RESTORED)
  }

  return {
    ok: true,
    counts: {
      bookmarksAdded: bookmarksToAdd.length,
      bookmarksSkipped,
      networksAdded: Object.keys(networksToAdd).length,
      networksSkipped,
    },
  }
}
