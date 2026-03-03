"use client"

import { useState } from "react"
import { X, Send, Loader2 } from "lucide-react"
import { Wallet, isAddress, parseEther, formatEther } from "ethers"
import { getProvider, getAllNetworks, type Network } from "@/lib/ethers"

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

  const networkInfo = getAllNetworks()[network]
  const currencySymbol = networkInfo?.currency || "ETH"

  const handleSetMaxAmount = async () => {
    setIsCalculatingMax(true)
    setError("")
    try {
      const provider = getProvider(network)
      const feeData = await provider.getFeeData()

      const gasPrice = feeData.maxFeePerGas || feeData.gasPrice
      if (!gasPrice) {
        throw new Error("Could not fetch gas price.")
      }

      const gasLimit = BigInt(21000) // Gas limit for a standard ETH transfer is 21000 wei
      const gasCost = gasLimit * gasPrice

      const balance = await provider.getBalance(wallet.address)

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
    try {
      const provider = getProvider(network)
      if (!provider) {
        throw new Error("Could not connect to provider.")
      }

      const tx = {
        to: recipient,
        value: parseEther(amount),
      }

      const walletInstance = new Wallet(wallet.privateKey, provider)
      const txResponse = await walletInstance.sendTransaction(tx)
      onSuccess(txResponse.hash)
    } catch (e) {
      console.error(e)
      if (e instanceof Error) {
        setError(e.message)
      } else {
        setError("Transaction failed.")
      }
    } finally {
      setIsSending(false)
    }
  }

  return (
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
          <div>
            <label className="text-sm font-bold text-gray-300">Recipient Address</label>
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="w-full p-2 bg-black/20 rounded-lg mt-1"
              placeholder="0x..."
            />
          </div>
          <div>
            <label className="text-sm font-bold text-gray-300">Amount ({currencySymbol})</label>
            <div className="relative flex items-center">
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full p-2 bg-black/20 rounded-lg mt-1 pr-16"
                placeholder="0.1"
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
  )
}
