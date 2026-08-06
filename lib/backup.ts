import { getTransactionHistoryData } from "./transactionHistory"
import { getBookmarks } from "./bookmarks"
import { getCustomNetworks } from "./ethers"

/** Storage keys used in the application */
const STORAGE_KEYS = {
  WALLETS: "ethtools_wallets",
  ACTIVE_WALLET: "ethtools_active_wallet",
  CUSTOM_NETWORKS: "ethtools_custom_networks",
  TRANSACTION_HISTORY: "ethtools_transaction_history",
  BOOKMARKS: "ethtools_bookmarks",
} as const

/** Version of the backup format for future compatibility */
const BACKUP_VERSION = "1.0.0"

/**
 * Represents the complete backup data structure.
 */
export interface BackupData {
  /** Backup format version */
  version: string
  /** Timestamp when the backup was created */
  timestamp: number
  /** All imported wallets */
  wallets: any[]
  /** ID of the currently active wallet */
  activeWalletId: string | null
  /** Custom networks configuration */
  customNetworks: Record<string, any>
  /** Transaction history */
  transactionHistory: any[]
  /** Address bookmarks */
  bookmarks: any[]
}

/**
 * Export all application data to a backup object.
 * @returns BackupData object containing all user data
 */
export function exportBackupData(): BackupData {
  if (typeof window === "undefined") {
    throw new Error("Backup can only be performed in browser environment")
  }

  let wallets: any[] = []
  let activeWalletId: string | null = null
  let customNetworks: Record<string, any> = {}
  let transactionHistory: any[] = []
  let bookmarks: any[] = []

  try {
    // Get wallets
    const walletsRaw = localStorage.getItem(STORAGE_KEYS.WALLETS)
    if (walletsRaw) {
      wallets = JSON.parse(walletsRaw)
    }
  } catch {
    // Ignore parse errors
  }

  try {
    // Get active wallet
    activeWalletId = localStorage.getItem(STORAGE_KEYS.ACTIVE_WALLET)
  } catch {
    // Ignore
  }

  try {
    // Get custom networks
    customNetworks = getCustomNetworks()
  } catch {
    // Ignore
  }

  try {
    // Get transaction history
    transactionHistory = getTransactionHistoryData()
  } catch {
    // Ignore
  }

  try {
    // Get bookmarks
    bookmarks = getBookmarks()
  } catch {
    // Ignore
  }

  return {
    version: BACKUP_VERSION,
    timestamp: Date.now(),
    wallets,
    activeWalletId,
    customNetworks,
    transactionHistory,
    bookmarks,
  }
}

/**
 * Download backup data as a JSON file.
 */
export function downloadBackup(): void {
  if (typeof window === "undefined") return

  try {
    const data = exportBackupData()
    const json = JSON.stringify(data, null, 2)
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)

    const link = document.createElement("a")
    link.href = url
    link.download = `ethtools-backup-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  } catch (error) {
    console.error("Failed to download backup:", error)
    throw new Error("Failed to create backup file")
  }
}

/**
 * Validate backup data structure.
 * @param data - The parsed backup data
 * @returns boolean indicating if the data is valid
 */
export function validateBackupData(data: any): data is BackupData {
  if (!data || typeof data !== "object") return false
  if (typeof data.version !== "string") return false
  if (typeof data.timestamp !== "number") return false
  if (!Array.isArray(data.wallets)) return false
  if (!Array.isArray(data.transactionHistory)) return false
  if (!Array.isArray(data.bookmarks)) return false
  if (typeof data.customNetworks !== "object") return false
  // activeWalletId can be null or string
  if (data.activeWalletId !== null && typeof data.activeWalletId !== "string") return false

  return true
}

/**
 * Import backup data and restore all application state.
 * @param data - The backup data to import
 * @returns Object with success status and message
 */
export function importBackupData(data: BackupData): {
  success: boolean
  message: string
  restoredCounts?: {
    wallets: number
    transactions: number
    bookmarks: number
    customNetworks: number
  }
} {
  if (typeof window === "undefined") {
    return { success: false, message: "Import can only be performed in browser environment" }
  }

  // Validate backup data
  if (!validateBackupData(data)) {
    return { success: false, message: "Invalid backup file format" }
  }

  try {
    // Restore wallets
    if (data.wallets && Array.isArray(data.wallets)) {
      localStorage.setItem(STORAGE_KEYS.WALLETS, JSON.stringify(data.wallets))
    }

    // Restore active wallet
    if (data.activeWalletId !== undefined) {
      if (data.activeWalletId) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_WALLET, data.activeWalletId)
      } else {
        localStorage.removeItem(STORAGE_KEYS.ACTIVE_WALLET)
      }
    }

    // Restore custom networks
    if (data.customNetworks && typeof data.customNetworks === "object") {
      localStorage.setItem(STORAGE_KEYS.CUSTOM_NETWORKS, JSON.stringify(data.customNetworks))
    }

    // Restore transaction history
    if (data.transactionHistory && Array.isArray(data.transactionHistory)) {
      localStorage.setItem(STORAGE_KEYS.TRANSACTION_HISTORY, JSON.stringify(data.transactionHistory))
    }

    // Restore bookmarks
    if (data.bookmarks && Array.isArray(data.bookmarks)) {
      localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(data.bookmarks))
    }

    // Trigger UI updates via custom events
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("transactionHistoryUpdated"))
      window.dispatchEvent(new Event("bookmarksUpdated"))
      // Custom event for wallet updates - will be handled by components
      window.dispatchEvent(new Event("walletDataUpdated"))
    }

    return {
      success: true,
      message: "Backup imported successfully! Please refresh the page to see all changes.",
      restoredCounts: {
        wallets: data.wallets?.length || 0,
        transactions: data.transactionHistory?.length || 0,
        bookmarks: data.bookmarks?.length || 0,
        customNetworks: Object.keys(data.customNetworks || {}).length,
      },
    }
  } catch (error) {
    console.error("Failed to import backup:", error)
    return {
      success: false,
      message: error instanceof Error ? error.message : "Failed to import backup",
    }
  }
}

/**
 * Clear all application data from localStorage (destructive).
 * @param confirmMessage - Optional custom confirmation message
 * @returns boolean indicating if the operation was performed
 */
export function clearAllData(confirmMessage?: string): boolean {
  if (typeof window === "undefined") return false

  const message = confirmMessage || "Are you sure you want to delete ALL data? This action cannot be undone."
  if (!window.confirm(message)) {
    return false
  }

  try {
    // Remove all known keys
    Object.values(STORAGE_KEYS).forEach((key) => {
      localStorage.removeItem(key)
    })

    // Dispatch events to update UI
    window.dispatchEvent(new Event("transactionHistoryUpdated"))
    window.dispatchEvent(new Event("bookmarksUpdated"))
    window.dispatchEvent(new Event("walletDataUpdated"))

    return true
  } catch (error) {
    console.error("Failed to clear data:", error)
    return false
  }
}
