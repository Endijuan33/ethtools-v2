import { Network } from "./ethers"

/**
 * Represents a single address bookmark.
 */
export interface Bookmark {
  /** Unique identifier for the bookmark */
  id: string
  /** The Ethereum address */
  address: string
  /** Human-readable label for the address */
  label: string
  /** Optional network filter (if set, bookmark only shows for this network) */
  network?: Network
  /** Unix timestamp when the bookmark was created */
  createdAt: number
}

/** Storage key for localStorage */
const STORAGE_KEY = "ethtools_bookmarks"

/**
 * Get all bookmarks from localStorage.
 * @returns Array of bookmarks
 */
export function getBookmarks(): Bookmark[] {
  if (typeof window === "undefined") return []
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    if (Array.isArray(parsed)) {
      return parsed
    }
    return []
  } catch {
    return []
  }
}

/**
 * Save a new bookmark.
 * @param address - The Ethereum address
 * @param label - Human-readable label
 * @param network - Optional network filter
 * @returns The created bookmark
 */
export function saveBookmark(
  address: string,
  label: string,
  network?: Network
): Bookmark {
  const bookmarks = getBookmarks()
  const newBookmark: Bookmark = {
    id: crypto.randomUUID ? crypto.randomUUID() : `bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    address: address.trim(),
    label: label.trim() || address.slice(0, 10) + "...",
    network,
    createdAt: Date.now(),
  }
  bookmarks.push(newBookmark)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks))
  // Notify other components
  triggerBookmarkUpdate()
  return newBookmark
}

/**
 * Update an existing bookmark.
 * @param id - Bookmark ID
 * @param data - Partial bookmark data to update
 * @returns boolean indicating success
 */
export function updateBookmark(
  id: string,
  data: Partial<Omit<Bookmark, "id" | "createdAt">>
): boolean {
  const bookmarks = getBookmarks()
  let found = false
  const updated = bookmarks.map((b) => {
    if (b.id === id) {
      found = true
      return { ...b, ...data }
    }
    return b
  })
  if (!found) return false
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
  triggerBookmarkUpdate()
  return true
}

/**
 * Delete a bookmark by ID.
 * @param id - Bookmark ID
 * @returns boolean indicating success
 */
export function deleteBookmark(id: string): boolean {
  const bookmarks = getBookmarks()
  const initialLength = bookmarks.length
  const filtered = bookmarks.filter((b) => b.id !== id)
  if (filtered.length === initialLength) return false
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
  triggerBookmarkUpdate()
  return true
}

/**
 * Get bookmarks filtered by network.
 * @param network - Network to filter by (optional)
 * @returns Array of bookmarks
 */
export function getBookmarksByNetwork(network?: Network): Bookmark[] {
  const bookmarks = getBookmarks()
  if (!network) return bookmarks
  return bookmarks.filter((b) => b.network === network || b.network === undefined)
}

/**
 * Check if an address is already bookmarked.
 * @param address - The address to check
 * @returns boolean
 */
export function isAddressBookmarked(address: string): boolean {
  const bookmarks = getBookmarks()
  return bookmarks.some((b) => b.address.toLowerCase() === address.toLowerCase())
}

/**
 * Dispatch a custom event to notify other components that bookmarks have been updated.
 */
export function triggerBookmarkUpdate(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("bookmarksUpdated"))
  }
}
