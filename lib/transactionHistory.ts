import { Network } from "./ethers"

/**
 * Represents a single transaction record.
 */
export interface Transaction {
  /** Transaction hash */
  hash: string
  /** Network where the transaction occurred */
  network: Network
  /** Sender address */
  from: string
  /** Recipient address */
  to: string
  /** Amount sent (formatted) */
  amount: string
  /** Currency symbol (e.g., ETH, USDC) */
  currency: string
  /** Unix timestamp in milliseconds */
  timestamp: number
  /** Transaction status */
  status: "pending" | "success" | "failed"
}

/** Storage key for localStorage */
const STORAGE_KEY = "ethtools_transaction_history"

/**
 * Dispatch a custom event to notify other components that transaction history has been updated.
 * This allows components to refresh without polling.
 */
export function triggerHistoryUpdate(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("transactionHistoryUpdated"))
  }
}

/**
 * Save a new transaction to history.
 * @param tx - Transaction data (without timestamp, which is auto-generated)
 * @returns void
 */
export function saveTransaction(tx: Omit<Transaction, "timestamp">): void {
  if (typeof window === "undefined") return

  const history = getTransactionHistoryData()
  const newTx: Transaction = {
    ...tx,
    timestamp: Date.now(),
  }
  history.unshift(newTx) // Add newest first
  // Keep last 500 transactions to prevent storage bloat
  if (history.length > 500) {
    history.length = 500
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  // Notify other components
  triggerHistoryUpdate()
}

/**
 * Get all transaction history data from localStorage.
 * @returns Array of transactions (empty array if none)
 */
export function getTransactionHistoryData(): Transaction[] {
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
 * Get paginated transaction history.
 * @param page - Page number (1-indexed)
 * @param limit - Number of items per page (default: 10)
 * @returns Object with data, totalItems, totalPages
 */
export function getTransactionHistory(
  page: number = 1,
  limit: number = 10
): {
  data: Transaction[]
  totalItems: number
  totalPages: number
} {
  const all = getTransactionHistoryData()
  const totalItems = all.length
  const totalPages = Math.ceil(totalItems / limit) || 1
  const startIndex = (page - 1) * limit
  const endIndex = Math.min(startIndex + limit, totalItems)
  const data = all.slice(startIndex, endIndex)
  return { data, totalItems, totalPages }
}

/**
 * Clear all transaction history.
 */
export function clearTransactionHistory(): void {
  if (typeof window === "undefined") return
  localStorage.removeItem(STORAGE_KEY)
  triggerHistoryUpdate()
}

/**
 * Delete a single transaction by hash.
 * @param hash - Transaction hash to delete
 * @returns boolean indicating success
 */
export function deleteTransactionByHash(hash: string): boolean {
  if (typeof window === "undefined") return false
  const history = getTransactionHistoryData()
  const initialLength = history.length
  const filtered = history.filter((tx) => tx.hash !== hash)
  if (filtered.length === initialLength) {
    return false // No transaction found
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
  triggerHistoryUpdate()
  return true
}

/**
 * Update the status of a transaction.
 * @param hash - Transaction hash
 * @param status - New status
 * @returns boolean indicating success
 */
export function updateTransactionStatus(
  hash: string,
  status: Transaction["status"]
): boolean {
  if (typeof window === "undefined") return false
  const history = getTransactionHistoryData()
  let found = false
  const updated = history.map((tx) => {
    if (tx.hash === hash) {
      found = true
      return { ...tx, status }
    }
    return tx
  })
  if (!found) return false
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
  triggerHistoryUpdate()
  return true
}

/**
 * Get transaction count for a specific network.
 * @param network - Network key (optional)
 * @returns number of transactions
 */
export function getTransactionCount(network?: Network): number {
  const all = getTransactionHistoryData()
  if (!network) return all.length
  return all.filter((tx) => tx.network === network).length
}
