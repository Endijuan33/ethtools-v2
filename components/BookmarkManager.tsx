"use client"

import { useState, useEffect, useCallback } from "react"
import {
  Plus,
  Trash2,
  Bookmark as BookmarkIcon,
  Check,
  ExternalLink,
} from "lucide-react"
import {
  getBookmarks,
  saveBookmark,
  deleteBookmark,
  getBookmarksByNetwork,
  type Bookmark,
} from "@/lib/bookmarks"
import { getRoutescanUrl } from "@/lib/ethers"
import { APP_EVENTS, onAppEvent } from "@/lib/appEvents"
import ResponsiveDialog from "./ui/ResponsiveDialog"
import Card from "./ui/Card"
import Button from "./ui/Button"
import Field, { inputClassName, monoInputClassName } from "./ui/Field"
import Badge from "./ui/Badge"
import CopyButton from "./ui/CopyButton"
import { EmptyState } from "./ui/Feedback"
import { confirmAction, notify } from "./ui/Toast"
import { cn } from "@/lib/utils"

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
  const [addressError, setAddressError] = useState("")
  const [labelError, setLabelError] = useState("")
  const [searchTerm, setSearchTerm] = useState("")

  // Load bookmarks
  const loadBookmarks = useCallback(() => {
    const filtered = network ? getBookmarksByNetwork(network) : getBookmarks()
    // Sort by createdAt descending (newest first). Copied first, because the
    // library returns a fresh array but sorting a source array in place is a trap
    // waiting for the day it starts returning a cached one.
    setBookmarks([...filtered].sort((a, b) => b.createdAt - a.createdAt))
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
    const unsubscribeBookmarks = onAppEvent(APP_EVENTS.BOOKMARKS_CHANGED, handleUpdate)
    const unsubscribeRestore = onAppEvent(APP_EVENTS.DATA_RESTORED, handleUpdate)
    return () => {
      unsubscribeBookmarks()
      unsubscribeRestore()
    }
  }, [loadBookmarks])

  /**
   * Add a bookmark.
   *
   * Validation and deduplication live in `lib/bookmarks`, not here: the loaded
   * list is filtered by network, so a local duplicate check would miss an address
   * already bookmarked on another network and then persist a second copy.
   */
  const handleAddBookmark = () => {
    setAddressError("")
    setLabelError("")

    const result = saveBookmark(newAddress, newLabel, network)
    if (result.ok) {
      setNewAddress("")
      setNewLabel("")
      loadBookmarks()
      return
    }

    switch (result.reason) {
      case "invalid-address":
      case "duplicate":
        setAddressError(result.error)
        break
      case "invalid-label":
        setLabelError(result.error)
        break
      default:
        // Storage refusals (a full quota, blocked storage) and the bookmark cap
        // are not field problems, so they get a toast rather than an inline error.
        notify.error("Could not save that bookmark", result.error)
        break
    }
  }

  // Handle deleting a bookmark
  const handleDelete = async (id: string) => {
    const confirmed = await confirmAction({
      message: "Remove this bookmark?",
      confirmLabel: "Remove",
    })
    if (!confirmed) return

    const result = deleteBookmark(id)
    if (!result.ok) {
      // A delete is a write, so it can fail when storage is full or blocked.
      notify.error("Could not remove that bookmark", result.error)
    }
    loadBookmarks()
  }

  // Handle selecting a bookmark (fills the address)
  const handleSelect = (address: string) => {
    if (onSelect) {
      onSelect(address)
      onClose()
    }
  }

  // Filter bookmarks by search term
  const filteredBookmarks = bookmarks.filter(
    (b) =>
      b.address.toLowerCase().includes(searchTerm.toLowerCase()) ||
      b.label.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <ResponsiveDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Manage Bookmarks"
      description={network ? `Network: ${network}` : undefined}
      size="lg"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {bookmarks.length} bookmark{bookmarks.length !== 1 ? "s" : ""}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {/* Add New Bookmark */}
      <Card variant="inset" padding="sm" className="space-y-3">
        <Field label="Address" required error={addressError || undefined}>
          {(props) => (
            <input
              {...props}
              type="text"
              value={newAddress}
              onChange={(e) => {
                setNewAddress(e.target.value)
                setAddressError("")
              }}
              placeholder="0x..."
              autoComplete="off"
              spellCheck={false}
              className={monoInputClassName}
            />
          )}
        </Field>

        <Field label="Label" hint="Optional." error={labelError || undefined}>
          {(props) => (
            <input
              {...props}
              type="text"
              value={newLabel}
              onChange={(e) => {
                setNewLabel(e.target.value)
                setLabelError("")
              }}
              placeholder="e.g., My Exchange Wallet"
              className={inputClassName}
            />
          )}
        </Field>

        <Button
          onClick={handleAddBookmark}
          disabled={newAddress.trim() === ""}
          fullWidth
          icon={<Plus size={18} aria-hidden="true" />}
        >
          Add Bookmark
        </Button>
      </Card>

      {/* Search */}
      <Field label="Search bookmarks" hideLabel>
        {(props) => (
          <input
            {...props}
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search bookmarks..."
            className={inputClassName}
          />
        )}
      </Field>

      {/* Bookmark List */}
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {filteredBookmarks.length === 0 ? (
          <EmptyState
            title={searchTerm ? "No matching bookmarks found." : "No bookmarks yet"}
            description={searchTerm ? undefined : "Add one above!"}
            icon={<BookmarkIcon size={20} aria-hidden="true" />}
          />
        ) : (
          filteredBookmarks.map((b) => {
            // Can be "" when the network has no configured explorer, and an
            // <a href=""> reloads the current page instead of navigating.
            const explorerUrl = getRoutescanUrl(b.address, b.network || "mainnet")

            return (
              <div
                key={b.id}
                className="flex flex-col justify-between gap-2 rounded-lg bg-muted/40 p-3 transition-colors hover:bg-muted/60 sm:flex-row sm:items-center"
              >
                <button
                  type="button"
                  onClick={() => handleSelect(b.address)}
                  aria-label={`Use ${b.label}, ${b.address}`}
                  className={cn(
                    "min-w-0 flex-1 rounded-lg text-left",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  )}
                >
                  {/* Spans rather than <p>: a button may only contain phrasing content. */}
                  <span className="block truncate font-semibold text-foreground">{b.label}</span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {b.address}
                  </span>
                  {b.network && (
                    <Badge tone="primary" className="mt-1">
                      {b.network}
                    </Badge>
                  )}
                </button>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 hover:text-success"
                    onClick={() => handleSelect(b.address)}
                    title="Use this address"
                    aria-label={`Use address ${b.address}`}
                  >
                    <Check size={16} aria-hidden="true" />
                  </Button>

                  {explorerUrl ? (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        "inline-flex h-11 w-11 items-center justify-center rounded-lg",
                        "text-info transition-colors hover:bg-secondary",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      )}
                      title="View on explorer"
                    >
                      <ExternalLink size={16} aria-hidden="true" />
                      <span className="sr-only">View {b.label} on explorer</span>
                    </a>
                  ) : (
                    <span
                      className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground/40"
                      title="No explorer is configured for this network"
                    >
                      <ExternalLink size={16} aria-hidden="true" />
                      <span className="sr-only">Explorer unavailable</span>
                    </span>
                  )}

                  <CopyButton value={b.address} label="address" className="h-11 w-11 justify-center" />

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 hover:text-destructive"
                    onClick={() => handleDelete(b.id)}
                    title="Delete bookmark"
                    aria-label={`Delete bookmark ${b.label}`}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </ResponsiveDialog>
  )
}
