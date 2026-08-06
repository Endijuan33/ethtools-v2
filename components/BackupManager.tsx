"use client"

import { useState, useRef, useCallback } from "react"
import {
  X,
  Download,
  Upload,
  Trash2,
  AlertTriangle,
  Check,
  Loader2,
  FileJson,
} from "lucide-react"
import { downloadBackup, importBackupData, clearAllData, type BackupData } from "@/lib/backup"

interface BackupManagerProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Callback when the modal is closed */
  onClose: () => void
}

export default function BackupManager({ isOpen, onClose }: BackupManagerProps) {
  const [isExporting, setIsExporting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [importStatus, setImportStatus] = useState<{
    success: boolean
    message: string
    counts?: { wallets: number; transactions: number; bookmarks: number; customNetworks: number }
  } | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /**
   * Handle export backup download.
   */
  const handleExport = useCallback(async () => {
    setIsExporting(true)
    try {
      await downloadBackup()
      setImportStatus({
        success: true,
        message: "Backup downloaded successfully!",
      })
      setTimeout(() => setImportStatus(null), 3000)
    } catch (error) {
      setImportStatus({
        success: false,
        message: error instanceof Error ? error.message : "Failed to export backup",
      })
    } finally {
      setIsExporting(false)
    }
  }, [])

  /**
   * Handle file selection for import.
   */
  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      setSelectedFile(file)
      setImportStatus(null)
    }
  }, [])

  /**
   * Handle import backup from selected file.
   */
  const handleImport = useCallback(async () => {
    if (!selectedFile) {
      setImportStatus({
        success: false,
        message: "Please select a backup file first.",
      })
      return
    }

    setIsImporting(true)
    setImportStatus(null)

    try {
      const text = await selectedFile.text()
      const data = JSON.parse(text) as BackupData

      const result = importBackupData(data)
      setImportStatus({
        success: result.success,
        message: result.message,
        counts: result.restoredCounts,
      })

      if (result.success) {
        setSelectedFile(null)
        if (fileInputRef.current) {
          fileInputRef.current.value = ""
        }
        // Close modal after successful import with a delay
        setTimeout(() => {
          onClose()
        }, 3000)
      }
    } catch (error) {
      setImportStatus({
        success: false,
        message: error instanceof Error ? error.message : "Failed to import backup",
      })
    } finally {
      setIsImporting(false)
    }
  }, [selectedFile, onClose])

  /**
   * Handle clearing all data.
   */
  const handleClearData = useCallback(() => {
    setIsClearing(true)
    const success = clearAllData(
      "⚠️ WARNING: This will permanently delete ALL wallet data, transaction history, and bookmarks from this device. This action cannot be undone. Are you sure?"
    )
    setImportStatus({
      success: success,
      message: success
        ? "All data has been cleared. Page will refresh shortly."
        : "Clear operation cancelled or failed.",
    })
    setIsClearing(false)

    if (success) {
      setTimeout(() => {
        window.location.reload()
      }, 1500)
    }
  }, [])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-gray-800 p-6 rounded-2xl shadow-lg w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <FileJson size={20} />
            Backup & Restore
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>

        {/* Description */}
        <p className="text-sm text-gray-400 mb-4">
          Export all your data (wallets, transactions, bookmarks) as a backup file, or import
          a previously exported backup to restore your data.
        </p>

        {/* Export Section */}
        <div className="bg-black/20 p-4 rounded-lg mb-3">
          <h4 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
            <Download size={16} className="text-blue-400" />
            Export Backup
          </h4>
          <p className="text-xs text-gray-400 mb-3">
            Download a JSON file containing all your data.
          </p>
          <button
            onClick={handleExport}
            disabled={isExporting}
            className="w-full bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isExporting ? (
              <Loader2 className="animate-spin" size={18} />
            ) : (
              <Download size={18} />
            )}
            Download Backup
          </button>
        </div>

        {/* Import Section */}
        <div className="bg-black/20 p-4 rounded-lg mb-3">
          <h4 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
            <Upload size={16} className="text-green-400" />
            Import Backup
          </h4>
          <p className="text-xs text-gray-400 mb-3">
            Select a previously exported backup JSON file to restore your data.
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileSelect}
              className="hidden"
              id="backup-file-input"
            />
            <label
              htmlFor="backup-file-input"
              className="flex-1 px-3 py-2 bg-black/30 rounded-lg text-sm text-gray-300 cursor-pointer hover:bg-black/40 transition-colors border border-gray-600 text-center truncate"
            >
              {selectedFile ? selectedFile.name : "Choose backup file..."}
            </label>
            <button
              onClick={handleImport}
              disabled={!selectedFile || isImporting}
              className="bg-green-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isImporting ? (
                <Loader2 className="animate-spin" size={18} />
              ) : (
                <Upload size={18} />
              )}
              Restore
            </button>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="bg-red-500/10 border border-red-500/30 p-4 rounded-lg">
          <h4 className="text-sm font-semibold text-red-400 mb-2 flex items-center gap-2">
            <AlertTriangle size={16} />
            Danger Zone
          </h4>
          <p className="text-xs text-gray-400 mb-3">
            Permanently delete ALL data from this device. This cannot be undone.
          </p>
          <button
            onClick={handleClearData}
            disabled={isClearing}
            className="w-full bg-red-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isClearing ? (
              <Loader2 className="animate-spin" size={18} />
            ) : (
              <Trash2 size={18} />
            )}
            Clear All Data
          </button>
        </div>

        {/* Status Message */}
        {importStatus && (
          <div
            className={`mt-3 p-3 rounded-lg text-sm ${
              importStatus.success
                ? "bg-green-500/20 text-green-400 border border-green-500/30"
                : "bg-red-500/20 text-red-400 border border-red-500/30"
            }`}
          >
            <div className="flex items-start gap-2">
              {importStatus.success ? (
                <Check size={18} className="mt-0.5 flex-shrink-0" />
              ) : (
                <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
              )}
              <div>
                <p>{importStatus.message}</p>
                {importStatus.success && importStatus.counts && (
                  <p className="text-xs mt-1 opacity-75">
                    Restored: {importStatus.counts.wallets} wallets,{" "}
                    {importStatus.counts.transactions} transactions,{" "}
                    {importStatus.counts.bookmarks} bookmarks,{" "}
                    {importStatus.counts.customNetworks} custom networks
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-4 pt-3 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
