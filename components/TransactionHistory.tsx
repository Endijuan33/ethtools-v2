"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import {
  getTransactionHistory,
  getTransactionHistoryData,
  deleteTransactionByHash,
  type Transaction,
} from "@/lib/transactionHistory"
import { getRoutescanUrl } from "@/lib/ethers"
import { ChevronLeft, ChevronRight, Trash2, ExternalLink } from "lucide-react"

interface TransactionHistoryProps {
  /** Optional filter by network */
  network?: string
}

export default function TransactionHistory({ network }: TransactionHistoryProps = {}) {
  const [currentPage, setCurrentPage] = useState(1)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [totalPages, setTotalPages] = useState(1)
  const [totalItems, setTotalItems] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [limit] = useState(10) // Items per page

  // Load transactions function
  const loadTransactions = useCallback(() => {
    setIsLoading(true)
    const { data, totalItems, totalPages } = getTransactionHistory(currentPage, limit)
    // If network filter is provided, filter the data client-side
    const filteredData = network
      ? data.filter((tx) => tx.network === network)
      : data
    setTransactions(filteredData)
    // If filtering, we need to recalc total pages from all data
    if (network) {
      const all = getTransactionHistoryData()
      const filteredAll = all.filter((tx) => tx.network === network)
      const filteredTotalPages = Math.ceil(filteredAll.length / limit) || 1
      setTotalPages(filteredTotalPages)
      setTotalItems(filteredAll.length)
    } else {
      setTotalPages(totalPages)
      setTotalItems(totalItems)
    }
    setIsLoading(false)
  }, [currentPage, limit, network])

  // Initial load
  useEffect(() => {
    loadTransactions()
  }, [loadTransactions])

  // Listen for custom event when transaction history is updated
  useEffect(() => {
    const handleUpdate = () => {
      loadTransactions()
    }
    // Listen for custom event
    window.addEventListener("transactionHistoryUpdated", handleUpdate)
    // Also listen for storage events from other tabs
    window.addEventListener("storage", handleUpdate)

    return () => {
      window.removeEventListener("transactionHistoryUpdated", handleUpdate)
      window.removeEventListener("storage", handleUpdate)
    }
  }, [loadTransactions])

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page < 1 || page > totalPages) return
    setCurrentPage(page)
  }

  // Handle delete transaction
  const handleDelete = (hash: string) => {
    if (confirm("Are you sure you want to delete this transaction record?")) {
      deleteTransactionByHash(hash)
      // The event will trigger reload, but we also call load to update immediately
      loadTransactions()
    }
  }

  // Format timestamp
  const formatTimestamp = (ts: number) => {
    const date = new Date(ts)
    return date.toLocaleString()
  }

  // Get status badge class
  const getStatusBadgeClass = (status: Transaction["status"]) => {
    switch (status) {
      case "success":
        return "bg-green-500/20 text-green-400"
      case "pending":
        return "bg-yellow-500/20 text-yellow-400"
      case "failed":
        return "bg-red-500/20 text-red-400"
      default:
        return "bg-gray-500/20 text-gray-400"
    }
  }

  // Generate page numbers for pagination (with ellipsis for large sets)
  const pageNumbers = useMemo(() => {
    const pages = []
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
    <div className="w-full max-w-4xl mx-auto mt-6 p-4 bg-white/5 backdrop-blur-sm rounded-xl border border-white/10">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-bold text-white">Transaction History</h3>
        <span className="text-sm text-gray-400">
          {totalItems} transaction{totalItems !== 1 ? "s" : ""}
        </span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-400"></div>
        </div>
      ) : transactions.length === 0 ? (
        <div className="text-center py-8 text-gray-400">
          No transactions found. Send some funds to start tracking history.
        </div>
      ) : (
        <>
          {/* Transaction List */}
          <div className="space-y-2 mb-4 max-h-96 overflow-y-auto">
            {transactions.map((tx) => (
              <div
                key={tx.hash}
                className="flex flex-col sm:flex-row sm:items-center justify-between p-3 bg-black/20 rounded-lg hover:bg-black/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-gray-300 truncate">
                      {tx.hash.slice(0, 10)}...{tx.hash.slice(-8)}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${getStatusBadgeClass(
                        tx.status
                      )}`}
                    >
                      {tx.status}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 text-xs text-gray-400 mt-1">
                    <span>
                      {tx.from.slice(0, 6)}...{tx.from.slice(-4)}
                    </span>
                    <span>→</span>
                    <span>
                      {tx.to.slice(0, 6)}...{tx.to.slice(-4)}
                    </span>
                    <span>
                      {tx.amount} {tx.currency}
                    </span>
                    <span>on {tx.network}</span>
                    <span>{formatTimestamp(tx.timestamp)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2 sm:mt-0">
                  <a
                    href={getRoutescanUrl(tx.hash, tx.network)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 p-1"
                    title="View on explorer"
                  >
                    <ExternalLink size={16} />
                  </a>
                  <button
                    onClick={() => handleDelete(tx.hash)}
                    className="text-red-400 hover:text-red-300 p-1"
                    title="Delete record"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1 flex-wrap">
              <button
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 1}
                className="p-2 rounded-lg bg-black/20 text-gray-300 hover:bg-black/40 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={18} />
              </button>

              {pageNumbers.map((page, index) =>
                typeof page === "number" ? (
                  <button
                    key={index}
                    onClick={() => handlePageChange(page)}
                    className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                      currentPage === page
                        ? "bg-purple-600 text-white"
                        : "bg-black/20 text-gray-300 hover:bg-black/40"
                    }`}
                  >
                    {page}
                  </button>
                ) : (
                  <span key={index} className="w-9 h-9 flex items-center justify-center text-gray-500">
                    …
                  </span>
                )
              )}

              <button
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="p-2 rounded-lg bg-black/20 text-gray-300 hover:bg-black/40 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
