"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import {
  getTransactionHistory,
  deleteTransactionById,
  type Transaction,
  type TransactionStatus,
} from "@/lib/transactionHistory"
import { getRoutescanUrl } from "@/lib/ethers"
import { APP_EVENTS, onAppEvent } from "@/lib/appEvents"
import { STORAGE_KEYS } from "@/lib/storage"
import { formatTimestamp, truncateHex } from "@/lib/format"
import { ChevronLeft, ChevronRight, Trash2, ExternalLink, Receipt } from "lucide-react"
import Card, { CardHeader, CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Badge, { type BadgeTone } from "./ui/Badge"
import { EmptyState } from "./ui/Feedback"
import { SkeletonList } from "./ui/Skeleton"
import { confirmAction, notify } from "./ui/Toast"
import { cn } from "@/lib/utils"

interface TransactionHistoryProps {
  /** Optional filter by network */
  network?: string
}

/** Records rendered per page. Only this many rows ever reach the DOM. */
const PAGE_SIZE = 10

/**
 * Status tone lookup.
 *
 * A status was previously conveyed by a hardcoded colour pair, so it inverted
 * badly in a light theme and read as nothing at all to a colourblind user. The
 * badge pairs the tone with the status text.
 *
 * `"unknown"` is a real state, not a fallback: it means the transaction was
 * broadcast but no receipt could be obtained. Rendering it as success would
 * claim more than the app knows, so it gets its own neutral tone.
 */
const STATUS_TONE: Record<TransactionStatus, BadgeTone> = {
  success: "success",
  pending: "warning",
  failed: "danger",
  unknown: "neutral",
}

export default function TransactionHistory({ network }: TransactionHistoryProps = {}) {
  const [currentPage, setCurrentPage] = useState(1)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [totalPages, setTotalPages] = useState(1)
  const [totalItems, setTotalItems] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  /**
   * Load one page.
   *
   * The network filter is applied inside `getTransactionHistory`, before the
   * slice. Filtering the slice afterwards — as this component used to — made the
   * header read "5 transactions" above an empty list, because the totals came
   * from the filtered set while the rows came from an unfiltered page.
   */
  const loadTransactions = useCallback(() => {
    setIsLoading(true)
    const page = getTransactionHistory(currentPage, PAGE_SIZE, network)
    setTransactions(page.data)
    setTotalPages(page.totalPages)
    setTotalItems(page.totalItems)
    // The library clamps the requested page into range. Adopting the clamped
    // value is what stops a deletion that shrinks the list from leaving the user
    // on a blank page with a disabled Next button.
    if (page.page !== currentPage) setCurrentPage(page.page)
    setIsLoading(false)
  }, [currentPage, network])

  // Initial load
  useEffect(() => {
    loadTransactions()
  }, [loadTransactions])

  // Reload when history changes in this tab, when a backup is restored, or when
  // another tab writes to storage.
  useEffect(() => {
    const handleUpdate = (): void => {
      loadTransactions()
    }

    const unsubscribeHistory = onAppEvent(APP_EVENTS.TRANSACTIONS_CHANGED, handleUpdate)
    const unsubscribeRestore = onAppEvent(APP_EVENTS.DATA_RESTORED, handleUpdate)

    // `storage` fires only in other tabs, so this is the cross-tab path.
    const handleStorage = (event: StorageEvent): void => {
      // Ignore writes to unrelated keys; the handler otherwise runs on every
      // storage mutation the origin makes.
      if (event.key === null || event.key === STORAGE_KEYS.TRANSACTION_HISTORY) {
        loadTransactions()
      }
    }
    window.addEventListener("storage", handleStorage)

    return () => {
      unsubscribeHistory()
      unsubscribeRestore()
      window.removeEventListener("storage", handleStorage)
    }
  }, [loadTransactions])

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page < 1 || page > totalPages) return
    setCurrentPage(page)
  }

  /**
   * Delete one record.
   *
   * Keyed by id, not hash: duplicate hashes are possible, and the hash-based
   * delete removed every record that shared one.
   */
  const handleDelete = async (id: string) => {
    const confirmed = await confirmAction({
      message: "Are you sure you want to delete this transaction record?",
      confirmLabel: "Delete",
    })
    if (!confirmed) return

    const result = deleteTransactionById(id)
    if (!result.ok) {
      // Storage can refuse a write when the quota is full, so a delete is not
      // guaranteed to land. Saying so beats a row that silently reappears.
      notify.error("Could not delete that record", result.error)
    }
    // The library dispatches an update event on success, but reload regardless so
    // a failed delete still re-syncs the list with what is actually stored.
    loadTransactions()
  }

  // Generate page numbers for pagination (with ellipsis for large sets)
  const pageNumbers = useMemo(() => {
    const pages: (number | string)[] = []
    const total = totalPages
    if (total <= 7) {
      for (let i = 1; i <= total; i++) {
        pages.push(i)
      }
    } else {
      pages.push(1)
      if (currentPage > 3) {
        pages.push("...")
      }
      const start = Math.max(2, currentPage - 1)
      const end = Math.min(total - 1, currentPage + 1)
      for (let i = start; i <= end; i++) {
        pages.push(i)
      }
      if (currentPage < total - 2) {
        pages.push("...")
      }
      pages.push(total)
    }
    return pages
  }, [currentPage, totalPages])

  return (
    <Card className="mx-auto mt-6 w-full max-w-4xl">
      <CardHeader className="items-center">
        <CardTitle as="h3">Transaction History</CardTitle>
        <span className="shrink-0 text-sm text-muted-foreground">
          {totalItems} transaction{totalItems !== 1 ? "s" : ""}
        </span>
      </CardHeader>

      {isLoading ? (
        <SkeletonList rows={4} label="Loading transaction history" />
      ) : transactions.length === 0 ? (
        <EmptyState
          title="No transactions found"
          description="Send some funds to start tracking history."
          icon={<Receipt size={20} aria-hidden="true" />}
        />
      ) : (
        <>
          {/* One page of records, never the whole retained history. */}
          <ul className="mb-4 max-h-96 space-y-2 overflow-y-auto">
            {transactions.map((tx) => {
              // Can be "" when the network has no configured explorer, and an
              // <a href=""> reloads the current page instead of navigating.
              const explorerUrl = getRoutescanUrl(tx.hash, tx.network)

              return (
                // Keyed by id, not hash: two records can share a hash, and
                // duplicate React keys drop rows from the rendered list.
                <li
                  key={tx.id}
                  className="flex flex-col justify-between gap-2 rounded-lg bg-muted/40 p-3 transition-colors hover:bg-muted/60 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-sm text-foreground">
                        {truncateHex(tx.hash, 10, 8)}
                      </span>
                      <Badge tone={STATUS_TONE[tx.status]} dot pulse={tx.status === "pending"}>
                        {tx.status}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 text-xs text-muted-foreground">
                      <span>{truncateHex(tx.from)}</span>
                      <span aria-hidden="true">→</span>
                      <span>{truncateHex(tx.to)}</span>
                      <span>
                        {tx.amount} {tx.currency}
                      </span>
                      <span>on {tx.network}</span>
                      <span>{formatTimestamp(tx.timestamp)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
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
                        <span className="sr-only">View transaction on explorer</span>
                      </a>
                    ) : (
                      <span
                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground/40"
                        title="No explorer is configured for this network"
                      >
                        <ExternalLink size={16} aria-hidden="true" />
                        <span className="sr-only">
                          Explorer unavailable for {tx.network}
                        </span>
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 hover:text-destructive"
                      onClick={() => handleDelete(tx.id)}
                      title="Delete record"
                      aria-label={`Delete record for transaction ${tx.hash}`}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>

          {/* Pagination */}
          {totalPages > 1 && (
            <nav
              aria-label="Transaction history pages"
              className="flex flex-wrap items-center justify-center gap-1"
            >
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 1}
                aria-label="Previous page"
              >
                <ChevronLeft size={18} aria-hidden="true" />
              </Button>

              {pageNumbers.map((page, index) =>
                typeof page === "number" ? (
                  <Button
                    key={index}
                    variant={currentPage === page ? "primary" : "ghost"}
                    size="icon"
                    className="h-11 w-11"
                    onClick={() => handlePageChange(page)}
                    aria-label={`Page ${page}`}
                    aria-current={currentPage === page ? "page" : undefined}
                  >
                    {page}
                  </Button>
                ) : (
                  <span
                    key={index}
                    aria-hidden="true"
                    className="flex h-11 w-11 items-center justify-center text-muted-foreground"
                  >
                    …
                  </span>
                )
              )}

              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage === totalPages}
                aria-label="Next page"
              >
                <ChevronRight size={18} aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      )}
    </Card>
  )
}
