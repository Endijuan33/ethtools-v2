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
import { filterValid, isStoredBookmark } from "./schema"
import { STORAGE_KEYS, writeJson, readJson } from "./storage"
import type { Network } from "./ethers"
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
