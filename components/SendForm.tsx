"use client"

import { useState } from "react"
import { X, Send, Loader2, Bookmark, ChevronDown } from "lucide-react"
import { Wallet, isAddress, parseEther, formatEther } from "ethers"
import { getProvider, getAllNetworks, type Network } from "@/lib/ethers"
import { saveTransaction, updateTransactionStatus } from "@/lib/transactionHistory"
import { getBookmarksByNetwork, isAddressBookmarked } from "@/lib/bookmarks"
import BookmarkManager from "./BookmarkManager"

interface SendFormProps {
  network: Network
  wallet: { address: string; privateKey: string }
  onClose: () => void
  onSuccess: (txHash: string) => void
}

export default function SendForm({ network, wallet, onClose, onSuccess }: SendFormProps) {
  const [recipient, setRecipient] = useState("")
  const [amount, setAmount] = useState("")
  const [error, setError] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [isCalculatingMax, setIsCalculatingMax] = useState(false)
  const [showBookmarkManager, setShowBookmarkManager] = useState(false)
  const [isBookmarkDropdownOpen, setIsBookmarkDropdownOpen] = useState(false)

  const networkInfo = getAllNetworks()[network]
  const currencySymbol = networkInfo?.currency || "ETH"

  // Get bookmarks for this network
  const bookmarks = getBookmarksByNetwork(network as string)

  // Check if current recipient is bookmarked
  const isBookmarked = recipient && isAddress(recipient) && isAddressBookmarked(recipient)

  // Auto-fill recipient from bookmark
  const handleSelectBookmark = (address: string) => {
    setRecipient(address)
    setIsBookmarkDropdownOpen(false)
  }

  const handleSetMaxAmount = async () => {
    setIsCalculatingMax(true)
    setError("")
    try {
      const provider = await getProvider(network)
      const feeData = await provider.getFeeData()

      const gasPrice = feeData.maxFeePerGas || feeData.gasPrice
      if (!gasPrice) {
        throw new Error("Could not fetch gas price.")
      }

      // Get current balance
      const balance = await provider.getBalance(wallet.address)

      // Estimate gas limit with 20% buffer
      let gasLimit = BigInt(21000) // Default for ETH transfer
      try {
        const estimatedGas = await provider.estimateGas({
          to: recipient || wallet.address,
          value: parseEther("0.001"),
        })
        gasLimit = (estimatedGas * BigInt(120)) / BigInt(100)
      } catch {
        gasLimit = BigInt(21000)
      }

      const gasCost = gasLimit * gasPrice

      if (balance <= gasCost) {
        setAmount("0")
        throw new Error("Balance is not sufficient to cover gas fees.")
      }

      const maxAmount = balance - gasCost
      setAmount(formatEther(maxAmount))
    } catch (e) {
      console.error(e)
      if (e instanceof Error) {
        setError(e.message)
      } else {
        setError("Failed to calculate max amount.")
      }
    } finally {
      setIsCalculatingMax(false)
    }
  }

  const handleSend = async () => {
    setError("")
    if (!isAddress(recipient)) {
      setError("Invalid recipient address.")
      return
    }
    if (Number.parseFloat(amount) <= 0) {
      setError("Amount must be greater than zero.")
      return
    }

    setIsSending(true)
    let txHash = ""

    try {
      const provider = await getProvider(network)
      if (!provider) {
        throw new Error("Could not connect to provider.")
      }

      const tx = {
        to: recipient,
        value: parseEther(amount),
      }

      try {
        const estimatedGas = await provider.estimateGas(tx)
        ;(tx as any).gasLimit = (estimatedGas * BigInt(120)) / BigInt(100)
      } catch (e) {
        console.warn("Gas estimation failed, using default:", e)
      }

      const walletInstance = new Wallet(wallet.privateKey, provider)
      const txResponse = await walletInstance.sendTransaction(tx)
      txHash = txResponse.hash

      saveTransaction({
        hash: txHash,
        network,
        from: wallet.address,
        to: recipient,
        amount,
        currency: currencySymbol,
        status: "pending",
      })

      onSuccess(txHash)

      // Update status after confirmation
      try {
        const receipt = await txResponse.wait(1)
        if (receipt) {
          if (receipt.status === 1) {
            updateTransactionStatus(txHash, "success")
          } else {
            updateTransactionStatus(txHash, "failed")
          }
        } else {
          // If receipt is null, still mark as success (network issue)
          updateTransactionStatus(txHash, "success")
        }
      } catch (confirmError) {
        console.warn("Transaction confirmation failed, marking as success anyway:", confirmError)
        // If we can't confirm, still mark as success assuming it went through
        updateTransactionStatus(txHash, "success")
      }

    } catch (e) {
      console.error(e)
      const errorMessage = e instanceof Error ? e.message : "Transaction failed."
      setError(errorMessage)

      const failedHash = txHash || `failed-${Date.now()}`
      saveTransaction({
        hash: failedHash,
        network,
        from: wallet.address,
        to: recipient,
        amount,
        currency: currencySymbol,
        status: "failed",
      })
    } finally {
      setIsSending(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
        <div className="bg-gray-800 p-6 rounded-2xl shadow-lg w-full max-w-md mx-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-bold">
              Send {currencySymbol}
              {networkInfo && <span className="text-sm font-normal text-gray-400 ml-2">on {networkInfo.name}</span>}
            </h3>
            <button onClick={onClose}>
              <X size={24} />
            </button>
          </div>
          <div className="space-y-4">
            {/* Recipient Address with Bookmark Support */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-bold text-gray-300">Recipient Address</label>
                <button
                  onClick={() => setShowBookmarkManager(true)}
                  className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1"
                >
                  <Bookmark size={14} />
                  {bookmarks.length > 0 ? `(${bookmarks.length})` : "Add"}
                </button>
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  className="w-full p-2 bg-black/20 rounded-lg mt-1 pr-24"
                  placeholder="0x..."
                />
                {/* Bookmark Dropdown Button */}
                {bookmarks.length > 0 && (
                  <button
                    onClick={() => setIsBookmarkDropdownOpen(!isBookmarkDropdownOpen)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 bg-purple-600 hover:bg-purple-700 rounded-lg px-2 py-1 text-xs flex items-center gap-1 h-5/6"
                  >
                    <Bookmark size={14} />
                    <ChevronDown size={14} className={isBookmarkDropdownOpen ? "rotate-180" : ""} />
                  </button>
                )}
                {/* Bookmark Dropdown List */}
                {isBookmarkDropdownOpen && bookmarks.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-gray-700 rounded-lg shadow-lg border border-white/10 z-50 max-h-48 overflow-y-auto">
                    {bookmarks.map((b) => (
                      <button
                        key={b.id}
                        onClick={() => handleSelectBookmark(b.address)}
                        className="w-full text-left px-3 py-2 hover:bg-black/30 transition-colors text-sm flex flex-col"
                      >
                        <span className="font-semibold text-white">{b.label}</span>
                        <span className="text-xs text-gray-400 font-mono truncate">
                          {b.address}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {isBookmarked && (
                <p className="text-xs text-green-400 mt-1">✓ Bookmarked address</p>
              )}
            </div>

            {/* Amount */}
            <div>
              <label className="text-sm font-bold text-gray-300">Amount ({currencySymbol})</label>
              <div className="relative flex items-center">
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full p-2 bg-black/20 rounded-lg mt-1 pr-16"
                  placeholder="0.1"
                  step="any"
                />
                <button
                  onClick={handleSetMaxAmount}
                  disabled={isCalculatingMax}
                  className="absolute right-1 top-1/2 -translate-y-1/2 bg-purple-600 px-3 py-1 text-xs rounded-md hover:bg-purple-700 disabled:bg-gray-500 h-5/6 flex items-center"
                >
                  {isCalculatingMax ? <Loader2 className="animate-spin" size={16} /> : "Max"}
                </button>
              </div>
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              onClick={handleSend}
              disabled={isSending || !recipient || !amount}
              className="w-full bg-green-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-green-700 transition-colors disabled:bg-gray-500"
            >
              {isSending ? (
                <Loader2 className="animate-spin mx-auto" />
              ) : (
                <div className="flex items-center justify-center">
                  <Send size={20} className="mr-2" /> Send
                </div>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Bookmark Manager Modal */}
      <BookmarkManager
        isOpen={showBookmarkManager}
        onClose={() => setShowBookmarkManager(false)}
        network={network}
        onSelect={handleSelectBookmark}
      />
    </>
  )
}
