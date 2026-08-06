"use client"

import { useState, useEffect, useCallback } from "react"
import {
  X,
  Plus,
  Trash2,
  Bookmark,
  Copy,
  Check,
  ExternalLink,
  Loader2,
} from "lucide-react"
import {
  getBookmarks,
  saveBookmark,
  deleteBookmark,
  getBookmarksByNetwork,
  type Bookmark,
} from "@/lib/bookmarks"
import { isAddress } from "ethers"
import { getRoutescanUrl } from "@/lib/ethers"

interface BookmarkManagerProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Callback when the modal is closed */
  onClose: () => void
  /** Optional network filter for bookmarks */
  network?: string
  /** Callback when a bookmark is selected (fills address) */
  onSelect?: (address: string) => void
}

export default function BookmarkManager({
  isOpen,
  onClose,
  network,
  onSelect,
}: BookmarkManagerProps) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [newAddress, setNewAddress] = useState("")
  const [newLabel, setNewLabel] = useState("")
  const [error, setError] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState("")

  // Load bookmarks
  const loadBookmarks = useCallback(() => {
    const filtered = network
      ? getBookmarksByNetwork(network)
      : getBookmarks()
    // Sort by createdAt descending (newest first)
    setBookmarks(filtered.sort((a, b) => b.createdAt - a.createdAt))
  }, [network])

  // Load on mount and when network changes
  useEffect(() => {
    if (isOpen) {
      loadBookmarks()
    }
  }, [isOpen, loadBookmarks])

  // Listen for bookmark updates from other components
  useEffect(() => {
    const handleUpdate = () => {
      loadBookmarks()
    }
    window.addEventListener("bookmarksUpdated", handleUpdate)
    return () => {
      window.removeEventListener("bookmarksUpdated", handleUpdate)
    }
  }, [loadBookmarks])

  // Handle adding a new bookmark
  const handleAddBookmark = async () => {
    setError("")
    const trimmedAddress = newAddress.trim()
    const trimmedLabel = newLabel.trim()

    if (!isAddress(trimmedAddress)) {
      setError("Invalid Ethereum address.")
      return
    }

    // Check if address already exists
    const existing = bookmarks.find(
      (b) => b.address.toLowerCase() === trimmedAddress.toLowerCase()
    )
    if (existing) {
      setError("This address is already bookmarked.")
      return
    }

    setIsAdding(true)
    try {
      saveBookmark(
        trimmedAddress,
        trimmedLabel || trimmedAddress.slice(0, 10) + "...",
        network as any
      )
      setNewAddress("")
      setNewLabel("")
      loadBookmarks()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add bookmark.")
    } finally {
      setIsAdding(false)
    }
  }

  // Handle deleting a bookmark
  const handleDelete = (id: string) => {
    if (confirm("Remove this bookmark?")) {
      deleteBookmark(id)
      loadBookmarks()
    }
  }

  // Handle selecting a bookmark (fills the address)
  const handleSelect = (address: string) => {
    if (onSelect) {
      onSelect(address)
      onClose()
    }
  }

  // Handle copying address to clipboard
  const handleCopy = (address: string, id: string) => {
    navigator.clipboard.writeText(address).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    })
  }

  // Filter bookmarks by search term
  const filteredBookmarks = bookmarks.filter(
    (b) =>
      b.address.toLowerCase().includes(searchTerm.toLowerCase()) ||
      b.label.toLowerCase().includes(searchTerm.toLowerCase())
  )

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-gray-800 p-6 rounded-2xl shadow-lg w-full max-w-lg mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Bookmark size={20} />
            Manage Bookmarks
            {network && (
              <span className="text-sm font-normal text-gray-400">
                ({network})
              </span>
            )}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>

        {/* Add New Bookmark */}
        <div className="bg-black/20 p-4 rounded-lg mb-4">
          <div className="space-y-3">
            <div>
              <label className="text-sm text-gray-300 block mb-1">Address *</label>
              <input
                type="text"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                placeholder="0x..."
                className="w-full p-2 bg-black/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
            <div>
              <label className="text-sm text-gray-300 block mb-1">Label (optional)</label>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g., My Exchange Wallet"
                className="w-full p-2 bg-black/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              onClick={handleAddBookmark}
              disabled={isAdding || !newAddress}
              className="w-full bg-purple-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isAdding ? (
                <Loader2 className="animate-spin" size={18} />
              ) : (
                <Plus size={18} />
              )}
              Add Bookmark
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="mb-3">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search bookmarks..."
            className="w-full p-2 bg-black/20 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
          />
        </div>

        {/* Bookmark List */}
        <div className="flex-1 overflow-y-auto space-y-2 min-h-[200px]">
          {filteredBookmarks.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">
              {searchTerm
                ? "No matching bookmarks found."
                : "No bookmarks yet. Add one above!"}
            </div>
          ) : (
            filteredBookmarks.map((b) => (
              <div
                key={b.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between p-3 bg-black/20 rounded-lg hover:bg-black/30 transition-colors gap-2"
              >
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => handleSelect(b.address)}
                >
                  <p className="font-semibold text-white truncate">{b.label}</p>
                  <p className="text-xs text-gray-400 font-mono truncate">
                    {b.address}
                  </p>
                  {b.network && (
                    <span className="text-xs text-purple-400">{b.network}</span>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleSelect(b.address)}
                    className="text-green-400 hover:text-green-300 p-1"
                    title="Use this address"
                  >
                    <Check size={16} />
                  </button>
                  <a
                    href={getRoutescanUrl(b.address, b.network || "mainnet")}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 p-1"
                    title="View on explorer"
                  >
                    <ExternalLink size={16} />
                  </a>
                  <button
                    onClick={() => handleCopy(b.address, b.id)}
                    className="text-gray-400 hover:text-white p-1"
                    title="Copy address"
                  >
                    {copiedId === b.id ? (
                      <Check size={16} className="text-green-400" />
                    ) : (
                      <Copy size={16} />
                    )}
                  </button>
                  <button
                    onClick={() => handleDelete(b.id)}
                    className="text-red-400 hover:text-red-300 p-1"
                    title="Delete bookmark"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 pt-3 border-t border-white/10 flex justify-between text-xs text-gray-500">
          <span>{bookmarks.length} bookmark{bookmarks.length !== 1 ? "s" : ""}</span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
