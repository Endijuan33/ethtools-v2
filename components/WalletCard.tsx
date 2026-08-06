"use client"

import { useState, useMemo, useEffect, useCallback } from "react"
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Copy,
  Check,
  RefreshCw,
  Send,
  Plus,
  Trash2,
  X,
  ChevronDown,
  Wallet,
  Loader2,
  Circle,
  Bookmark as BookmarkIcon,
} from "lucide-react"
import { Mnemonic, Wallet as EthersWallet, isError } from "ethers"
import {
  getBalance,
  getRoutescanUrl,
  NETWORKS,
  getCustomNetworks,
  saveCustomNetwork,
  removeCustomNetwork,
  validateRpcUrl,
  getProvider,
  cleanupRpcPools,
  getRpcHealthStatus,
  type Network as NetworkType,
  type CustomNetwork,
  type NetworkConfig,
} from "@/lib/ethers"
import { QRCodeSVG } from "qrcode.react"
import SendForm from "./SendForm"
import BookmarkManager from "./BookmarkManager"

// ===== Types =====

interface ImportedWallet {
  id: string
  label: string
  address: string
  privateKey: string
}

interface Balances {
  [key: string]: { balance: string | null; error: string | null }
}

interface RpcHealthIndicator {
  [key: string]: { healthy: boolean; responseTime: number }
}

// ===== Constants =====

const WALLETS_STORAGE_KEY = "ethtools_wallets"
const ACTIVE_WALLET_KEY = "ethtools_active_wallet"
const BALANCE_RETRY_COUNT = 3
const BALANCE_RETRY_DELAY_MS = 1000

// ===== AddCustomRpcModal (Inline) =====

function AddCustomRpcModal({
  isOpen,
  onClose,
  onAdd,
  networkType,
}: {
  isOpen: boolean
  onClose: () => void
  onAdd: (key: string, network: CustomNetwork) => void
  networkType: "mainnet" | "testnet"
}) {
  const [name, setName] = useState("")
  const [rpcUrls, setRpcUrls] = useState<string[]>([""])
  const [explorerUrl, setExplorerUrl] = useState("")
  const [currency, setCurrency] = useState("")
  const [isValidating, setIsValidating] = useState(false)
  const [error, setError] = useState("")

  const handleAddRpcUrl = () => setRpcUrls((prev) => [...prev, ""])
  const handleRemoveRpcUrl = (index: number) => {
    if (rpcUrls.length <= 1) return
    setRpcUrls((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async () => {
    setError("")

    if (!name.trim() || !currency.trim()) {
      setError("Name and Currency are required.")
      return
    }

    const filteredUrls = rpcUrls.filter((url) => url.trim() !== "")
    if (filteredUrls.length === 0) {
      setError("At least one RPC URL is required.")
      return
    }

    setIsValidating(true)
    const results = await Promise.all(filteredUrls.map((url) => validateRpcUrl(url)))
    const invalid = results.find((r) => !r.valid)
    if (invalid) {
      setError(`Invalid RPC URL: ${invalid.error}`)
      setIsValidating(false)
      return
    }
    setIsValidating(false)

    const key = name.toLowerCase().replace(/\s+/g, "-") + "-custom"
    const network: CustomNetwork = {
      name: name.trim(),
      rpcUrls: filteredUrls,
      explorerUrl: explorerUrl.trim() || "",
      currency: currency.trim().toUpperCase(),
      type: networkType,
      isCustom: true,
    }

    onAdd(key, network)
    setName("")
    setRpcUrls([""])
    setExplorerUrl("")
    setCurrency("")
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-gray-800 p-6 rounded-2xl shadow-lg w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold">Add Custom RPC ({networkType})</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-300 block mb-1">Network Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Custom Chain"
              className="w-full p-3 bg-black/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>

          <div>
            <label className="text-sm text-gray-300 block mb-1">RPC URLs * (at least one)</label>
            {rpcUrls.map((url, index) => (
              <div key={index} className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => {
                    const newUrls = [...rpcUrls]
                    newUrls[index] = e.target.value
                    setRpcUrls(newUrls)
                  }}
                  placeholder="https://rpc.example.com"
                  className="flex-1 p-3 bg-black/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                {rpcUrls.length > 1 && (
                  <button
                    onClick={() => handleRemoveRpcUrl(index)}
                    className="text-red-400 hover:text-red-300"
                  >
                    <Trash2 size={18} />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={handleAddRpcUrl}
              className="text-sm text-purple-400 hover:text-purple-300 flex items-center gap-1"
            >
              <Plus size={16} /> Add another RPC URL
            </button>
          </div>

          <div>
            <label className="text-sm text-gray-300 block mb-1">Explorer URL (optional)</label>
            <input
              type="text"
              value={explorerUrl}
              onChange={(e) => setExplorerUrl(e.target.value)}
              placeholder="https://explorer.example.com"
              className="w-full p-3 bg-black/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>

          <div>
            <label className="text-sm text-gray-300 block mb-1">Currency Symbol *</label>
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              placeholder="e.g. ETH, BNB"
              className="w-full p-3 bg-black/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            onClick={handleSubmit}
            disabled={isValidating}
            className="w-full bg-purple-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isValidating ? "Validating RPCs..." : "Add Network"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== WalletSelector =====

function WalletSelector({
  wallets,
  activeWallet,
  onSelect,
  onAddNew,
  onDelete,
}: {
  wallets: ImportedWallet[]
  activeWallet: ImportedWallet | null
  onSelect: (wallet: ImportedWallet) => void
  onAddNew: () => void
  onDelete: (id: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 bg-black/30 px-4 py-2 rounded-lg hover:bg-black/40 transition-colors w-full"
      >
        <Wallet size={18} />
        <span className="flex-1 text-left truncate">{activeWallet?.label || "Select Wallet"}</span>
        <ChevronDown size={18} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-gray-800 rounded-lg shadow-lg border border-white/10 z-40 overflow-hidden">
          <div className="max-h-60 overflow-y-auto">
            {wallets.map((wallet) => (
              <div
                key={wallet.id}
                className={`flex items-center justify-between px-4 py-3 hover:bg-black/30 cursor-pointer ${
                  activeWallet?.id === wallet.id ? "bg-purple-600/30" : ""
                }`}
              >
                <div
                  className="flex-1 min-w-0"
                  onClick={() => {
                    onSelect(wallet)
                    setIsOpen(false)
                  }}
                >
                  <p className="font-semibold truncate">{wallet.label}</p>
                  <p className="text-xs text-gray-400 font-mono truncate">
                    {wallet.address.slice(0, 10)}...{wallet.address.slice(-8)}
                  </p>
                </div>
                {wallets.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(wallet.id)
                    }}
                    className="text-red-400 hover:text-red-300 p-1 ml-2"
                    title="Remove wallet"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-white/10">
            <button
              onClick={() => {
                onAddNew()
                setIsOpen(false)
              }}
              className="w-full flex items-center gap-2 px-4 py-3 hover:bg-black/30 text-purple-400"
            >
              <Plus size={18} />
              <span>Add Another Wallet</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ===== Main WalletCard Component =====

export default function WalletCard() {
  // --- State ---
  const [wallets, setWallets] = useState<ImportedWallet[]>([])
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null)
  const [isAddingWallet, setIsAddingWallet] = useState(false)
  const [networkView, setNetworkView] = useState<"mainnet" | "testnet">("mainnet")
  const [balances, setBalances] = useState<Balances>({})
  const [isLoadingBalances, setIsLoadingBalances] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const [walletLabel, setWalletLabel] = useState("")
  const [error, setError] = useState("")
  const [isMasked, setIsMasked] = useState(true)
  const [showReceive, setShowReceive] = useState(false)
  const [sendFromNetwork, setSendFromNetwork] = useState<NetworkType | null>(null)
  const [copied, setCopied] = useState(false)
  const [txSuccess, setTxSuccess] = useState<{ hash: string; network: NetworkType } | null>(null)
  const [showLogoutConfirmation, setShowLogoutConfirmation] = useState(false)
  const [isMounted, setIsMounted] = useState(false)
  const [showAddRpc, setShowAddRpc] = useState(false)
  const [showBookmarkManager, setShowBookmarkManager] = useState(false)
  const [customNetworks, setCustomNetworks] = useState<Record<string, CustomNetwork>>({})
  const [rpcHealth, setRpcHealth] = useState<RpcHealthIndicator>({})

  // --- Derived ---
  const activeWallet = useMemo(
    () => wallets.find((w) => w.id === activeWalletId) || null,
    [wallets, activeWalletId]
  )

  const isUnlocked = wallets.length > 0 && !isAddingWallet

  const { wordCount, isMnemonic } = useMemo(() => {
    const words = inputValue.trim().split(/\s+/).filter(Boolean)
    const count = words.length
    return { wordCount: count, isMnemonic: [12, 18, 24].includes(count) }
  }, [inputValue])

  const displayedNetworks = useMemo(() => {
    const allNetworks = { ...NETWORKS, ...customNetworks }
    return Object.entries(allNetworks).filter(([, networkDetails]) => networkDetails.type === networkView) as [
      string,
      NetworkConfig,
    ][]
  }, [networkView, customNetworks])

  // --- Effects ---
  useEffect(() => {
    setIsMounted(true)
  }, [])

  useEffect(() => {
    if (!isMounted) return
    setCustomNetworks(getCustomNetworks())
  }, [isMounted])

  useEffect(() => {
    if (!isMounted) return
    try {
      const storedWalletsJSON = localStorage.getItem(WALLETS_STORAGE_KEY)
      const storedActiveId = localStorage.getItem(ACTIVE_WALLET_KEY)

      if (storedWalletsJSON) {
        const storedWallets: ImportedWallet[] = JSON.parse(storedWalletsJSON)
        if (Array.isArray(storedWallets) && storedWallets.length > 0) {
          setWallets(storedWallets)
          if (storedActiveId && storedWallets.some((w) => w.id === storedActiveId)) {
            setActiveWalletId(storedActiveId)
          } else {
            setActiveWalletId(storedWallets[0].id)
          }
        }
      }
    } catch (e) {
      console.error("Error reading wallets from localStorage:", e)
      localStorage.removeItem(WALLETS_STORAGE_KEY)
      localStorage.removeItem(ACTIVE_WALLET_KEY)
    }
  }, [isMounted])

  // Cleanup RPC pools on unmount
  useEffect(() => {
    return () => {
      cleanupRpcPools()
    }
  }, [])

  // Fetch RPC health status periodically
  useEffect(() => {
    if (!isUnlocked) return

    const updateHealthStatus = () => {
      const healthMap = getRpcHealthStatus()
      const newHealth: RpcHealthIndicator = {}
      for (const [network, statuses] of healthMap) {
        const healthy = statuses.some((s) => s.healthy)
        const avgResponseTime = statuses.reduce((sum, s) => sum + s.responseTime, 0) / statuses.length
        newHealth[network] = { healthy, responseTime: avgResponseTime }
      }
      setRpcHealth(newHealth)
    }

    updateHealthStatus()
    const interval = setInterval(updateHealthStatus, 30000)
    return () => clearInterval(interval)
  }, [isUnlocked])

  // --- Balance Fetching with Retry Logic ---

  const fetchBalanceWithRetry = useCallback(
    async (address: string, networkKey: string, retries: number = BALANCE_RETRY_COUNT): Promise<{
      networkKey: string
      balance: string | null
      error: string | null
    }> => {
      let lastError: Error | null = null
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const balance = await getBalance(address, networkKey)
          return { networkKey, balance, error: null }
        } catch (e) {
          lastError = e instanceof Error ? e : new Error("Unknown error")
          console.warn(
            `Balance fetch attempt ${attempt + 1}/${retries} failed for ${networkKey}:`,
            lastError.message
          )
          if (attempt < retries - 1) {
            const delay = BALANCE_RETRY_DELAY_MS * Math.pow(2, attempt)
            await new Promise((resolve) => setTimeout(resolve, delay))
          }
        }
      }
      const errorMsg = lastError?.message || "Failed to fetch balance"
      return { networkKey, balance: null, error: errorMsg }
    },
    []
  )

  const fetchAllBalances = useCallback(async () => {
    if (!activeWallet?.address) return
    setIsLoadingBalances(true)

    const address = activeWallet.address
    const balancePromises = displayedNetworks.map(async ([key]) => {
      const networkKey = key as NetworkType
      return await fetchBalanceWithRetry(address, networkKey)
    })

    const results = await Promise.all(balancePromises)
    const newBalances: Balances = {}
    for (const result of results) {
      newBalances[result.networkKey] = {
        balance: result.balance,
        error: result.error,
      }
    }
    setBalances((prev) => ({ ...prev, ...newBalances }))
    setIsLoadingBalances(false)
  }, [activeWallet?.address, displayedNetworks, fetchBalanceWithRetry])

  // Auto-refresh balances every 30 seconds
  useEffect(() => {
    if (activeWallet?.address && isUnlocked) {
      setBalances({})
      fetchAllBalances()
      const interval = setInterval(fetchAllBalances, 30000)
      return () => clearInterval(interval)
    }
  }, [activeWallet?.address, isUnlocked, fetchAllBalances])

  // --- Handlers ---
  const handleAddCustomNetwork = (key: string, network: CustomNetwork) => {
    saveCustomNetwork(key, network)
    setCustomNetworks((prev) => ({ ...prev, [key]: network }))
  }

  const handleRemoveCustomNetwork = (key: string) => {
    removeCustomNetwork(key)
    setCustomNetworks((prev) => {
      const updated = { ...prev }
      delete updated[key]
      return updated
    })
    setBalances((prev) => {
      const updated = { ...prev }
      delete updated[key]
      return updated
    })
  }

  const handleImport = () => {
    setError("")
    if (!inputValue.trim()) {
      setError("Please enter a mnemonic phrase or private key.")
      return
    }
    try {
      const trimmedInput = inputValue.trim()
      const importedWallet = isMnemonic
        ? (() => {
            const mnemonic = Mnemonic.fromPhrase(trimmedInput)
            return EthersWallet.fromPhrase(mnemonic.phrase)
          })()
        : new EthersWallet(trimmedInput)

      if (wallets.some((w) => w.address.toLowerCase() === importedWallet.address.toLowerCase())) {
        setError("This wallet is already imported.")
        return
      }

      const newWallet: ImportedWallet = {
        id: crypto.randomUUID(),
        label: walletLabel.trim() || `Wallet ${wallets.length + 1}`,
        address: importedWallet.address,
        privateKey: importedWallet.privateKey,
      }

      const updatedWallets = [...wallets, newWallet]
      setWallets(updatedWallets)
      setActiveWalletId(newWallet.id)
      localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(updatedWallets))
      localStorage.setItem(ACTIVE_WALLET_KEY, newWallet.id)
      setInputValue("")
      setWalletLabel("")
      setIsAddingWallet(false)
    } catch (e) {
      if (isError(e, "INVALID_ARGUMENT")) {
        setError("Invalid mnemonic phrase or private key.")
      } else if (e instanceof Error) {
        setError(e.message)
      } else {
        setError("An unknown error occurred during import.")
      }
    }
  }

  const handleSelectWallet = (wallet: ImportedWallet) => {
    setActiveWalletId(wallet.id)
    localStorage.setItem(ACTIVE_WALLET_KEY, wallet.id)
  }

  const handleDeleteWallet = (walletId: string) => {
    const updatedWallets = wallets.filter((w) => w.id !== walletId)
    setWallets(updatedWallets)
    localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(updatedWallets))

    if (activeWalletId === walletId) {
      if (updatedWallets.length > 0) {
        setActiveWalletId(updatedWallets[0].id)
        localStorage.setItem(ACTIVE_WALLET_KEY, updatedWallets[0].id)
      } else {
        setActiveWalletId(null)
        localStorage.removeItem(ACTIVE_WALLET_KEY)
      }
    }
  }

  const handleLogout = () => {
    localStorage.removeItem(WALLETS_STORAGE_KEY)
    localStorage.removeItem(ACTIVE_WALLET_KEY)
    setWallets([])
    setActiveWalletId(null)
    setError("")
    setBalances({})
    setShowLogoutConfirmation(false)
    cleanupRpcPools()
  }

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleSendSuccess = (hash: string) => {
    if (sendFromNetwork) {
      setTxSuccess({ hash, network: sendFromNetwork })
      setSendFromNetwork(null)
      fetchAllBalances()
    }
  }

  // --- Render ---
  if (!isMounted) {
    return (
      <div className="w-full max-w-lg p-6 bg-white/10 backdrop-blur-md rounded-xl shadow-glass border border-white/20 text-white">
        <div className="text-center py-8 text-gray-300">Loading wallet...</div>
      </div>
    )
  }

  if (isUnlocked && activeWallet) {
    return (
      <div className="w-full max-w-lg p-6 bg-white/10 backdrop-blur-md rounded-xl shadow-glass border border-white/20 text-white">
        <div className="mb-4">
          <WalletSelector
            wallets={wallets}
            activeWallet={activeWallet}
            onSelect={handleSelectWallet}
            onAddNew={() => setIsAddingWallet(true)}
            onDelete={handleDeleteWallet}
          />
        </div>

        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">Wallet Dashboard</h2>
          <div className="flex items-center gap-2">
            {/* Bookmark Manager Button */}
            <button
              onClick={() => setShowBookmarkManager(true)}
              className="text-gray-400 hover:text-white transition-colors p-1"
              title="Manage Address Bookmark"
            >
              <BookmarkIcon size={20} />
            </button>
            <div className="flex items-center bg-black/20 p-1 rounded-lg text-sm font-semibold">
              <button
                onClick={() => setNetworkView("mainnet")}
                className={`px-4 py-1 rounded-md transition-colors ${
                  networkView === "mainnet" ? "bg-purple-600" : ""
                }`}
              >
                Mainnets
              </button>
              <button
                onClick={() => setNetworkView("testnet")}
                className={`px-4 py-1 rounded-md transition-colors ${
                  networkView === "testnet" ? "bg-purple-600" : ""
                }`}
              >
                Testnets
              </button>
            </div>
          </div>
        </div>

        <div className="bg-black/25 p-4 rounded-lg mb-4">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-lg font-bold capitalize">{networkView} Balances</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAddRpc(true)}
                className="text-gray-400 hover:text-white transition-colors"
                title="Add Custom RPC"
              >
                <Plus size={20} />
              </button>
              <button
                onClick={fetchAllBalances}
                disabled={isLoadingBalances}
                className="text-gray-400 hover:text-white transition-colors disabled:opacity-50"
              >
                <RefreshCw size={20} className={isLoadingBalances ? "animate-spin" : ""} />
              </button>
            </div>
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {isLoadingBalances && (
              <div className="flex justify-center py-4">
                <Loader2 className="animate-spin text-purple-400" size={24} />
              </div>
            )}
            {!isLoadingBalances &&
              displayedNetworks.map(([key, networkInfo]) => {
                const networkKey = key as NetworkType
                const balanceInfo = balances[networkKey]
                const canSend = balanceInfo?.balance && Number.parseFloat(balanceInfo.balance) > 0
                const isCustom = "isCustom" in networkInfo && networkInfo.isCustom
                const health = rpcHealth[networkKey]
                const isHealthy = health?.healthy ?? true

                return (
                  <div key={key} className="flex justify-between items-center bg-black/20 p-3 rounded-md">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Circle
                          size={10}
                          className={`${isHealthy ? "text-green-400 fill-green-400" : "text-red-400 fill-red-400"}`}
                          aria-label={isHealthy ? "RPC healthy" : "RPC unhealthy"}
                          role="img"
                        />
                        <span className="font-semibold truncate">{networkInfo.name}</span>
                        {isCustom && <span className="text-xs bg-purple-600/50 px-1.5 py-0.5 rounded">Custom</span>}
                      </div>
                      {balanceInfo?.error ? (
                        <p className="text-red-400 text-xs">Error: {balanceInfo.error}</p>
                      ) : (
                        <p className="font-mono text-sm">
                          {balanceInfo?.balance ?? "0.00000"} {networkInfo.currency}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {isCustom && (
                        <button
                          onClick={() => handleRemoveCustomNetwork(key)}
                          className="text-red-400 hover:text-red-300 transition-colors p-1"
                          title="Remove network"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                      <button
                        onClick={() => setSendFromNetwork(networkKey)}
                        disabled={!canSend}
                        className="bg-green-600 text-white font-bold py-1 px-3 rounded-lg hover:bg-green-700 transition-colors disabled:bg-gray-500 disabled:cursor-not-allowed flex items-center text-sm"
                      >
                        <Send size={14} className="mr-1.5" /> Send
                      </button>
                    </div>
                  </div>
                )
              })}
          </div>
        </div>

        {/* Buttons */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <button
            onClick={() => setShowReceive(true)}
            className="bg-blue-600 w-full font-bold py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Receive
          </button>
          <button
            onClick={() => setShowLogoutConfirmation(true)}
            className="bg-red-600 w-full font-bold py-3 px-4 rounded-lg hover:bg-red-700 transition-colors"
          >
            Logout All
          </button>
        </div>

        {/* Wallet Info */}
        <div className="space-y-3 mt-4">
          <div>
            <label className="text-sm font-bold text-gray-300 flex items-center">
              Address{" "}
              <Copy
                onClick={() => handleCopy(activeWallet.address)}
                size={16}
                className="ml-2 cursor-pointer hover:text-white"
              />
            </label>
            <p className="text-sm text-green-400 break-all bg-black/20 p-2 rounded-lg font-mono">
              {activeWallet.address}
            </p>
          </div>
          <div>
            <label className="text-sm font-bold text-gray-300">Private Key</label>
            <div className="relative">
              <p
                className={`text-sm text-orange-400 break-all bg-black/20 p-2 rounded-lg font-mono ${
                  isMasked ? "blur-sm" : ""
                }`}
              >
                {activeWallet.privateKey}
              </p>
              <button
                onClick={() => setIsMasked(!isMasked)}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-gray-400 hover:text-white"
              >
                {isMasked ? <Eye size={18} /> : <EyeOff size={18} />}
              </button>
            </div>
          </div>
        </div>

        {/* Modals */}
        <AddCustomRpcModal
          isOpen={showAddRpc}
          onClose={() => setShowAddRpc(false)}
          onAdd={handleAddCustomNetwork}
          networkType={networkView}
        />

        <BookmarkManager
          isOpen={showBookmarkManager}
          onClose={() => setShowBookmarkManager(false)}
          network={networkView}
        />

        {showLogoutConfirmation && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="bg-gray-800 p-6 rounded-2xl shadow-lg text-center w-full max-w-sm mx-4">
              <h3 className="text-lg font-bold mb-4">Confirm Logout</h3>
              <p className="text-gray-300 mb-6">
                Are you sure? This will remove all {wallets.length} wallet{wallets.length > 1 ? "s" : ""} from this
                device.
              </p>
              <div className="flex justify-center gap-4">
                <button
                  onClick={() => setShowLogoutConfirmation(false)}
                  className="bg-gray-600 font-bold py-2 px-6 rounded-lg hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button onClick={handleLogout} className="bg-red-600 font-bold py-2 px-6 rounded-lg hover:bg-red-700">
                  Logout All
                </button>
              </div>
            </div>
          </div>
        )}

        {sendFromNetwork && (
          <SendForm
            wallet={activeWallet}
            network={sendFromNetwork}
            onClose={() => setSendFromNetwork(null)}
            onSuccess={handleSendSuccess}
          />
        )}

        {txSuccess && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="bg-gray-800 p-6 rounded-2xl shadow-lg text-center w-full max-w-sm mx-4">
              <h3 className="text-lg font-bold mb-2 text-green-400">Transaction Sent!</h3>
              <p className="text-sm font-mono break-all bg-black/30 p-2 rounded-lg mb-4">{txSuccess.hash}</p>
              <a
                href={getRoutescanUrl(txSuccess.hash, txSuccess.network)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline mb-4 block"
              >
                View on Explorer
              </a>
              <button
                onClick={() => setTxSuccess(null)}
                className="bg-gray-600 w-full font-bold py-2 px-4 rounded-lg hover:bg-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {showReceive && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="bg-gray-800 p-6 rounded-2xl shadow-lg text-center w-full max-w-sm mx-4">
              <h3 className="text-lg font-bold mb-2">Your Wallet Address</h3>
              <p className="text-sm text-gray-400 mb-2">{activeWallet.label}</p>
              <div className="bg-white p-4 rounded-lg mb-4 inline-block">
                <QRCodeSVG value={activeWallet.address} size={160} />
              </div>
              <p className="text-sm font-mono break-all bg-black/30 p-2 rounded-lg mb-4">{activeWallet.address}</p>
              <button
                onClick={() => handleCopy(activeWallet.address)}
                className="w-full bg-blue-600 font-bold py-2 px-4 rounded-lg hover:bg-blue-700 mb-2 flex items-center justify-center"
              >
                {copied ? (
                  <>
                    <Check size={20} className="mr-2" /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={20} className="mr-2" /> Copy Address
                  </>
                )}
              </button>
              <button
                onClick={() => setShowReceive(false)}
                className="bg-gray-600 w-full font-bold py-2 px-4 rounded-lg hover:bg-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // --- Import View ---
  return (
    <div className="w-full max-w-lg p-6 bg-white/10 backdrop-blur-md rounded-xl shadow-glass border border-white/20 text-white">
      <h2 className="text-xl font-bold text-center mb-2">
        {wallets.length > 0 ? "Add Another Wallet" : "Import Existing Wallet"}
      </h2>
      <p className="text-sm text-gray-400 text-center mb-4">Use a 12, 18, 24-word mnemonic or a private key.</p>

      <div className="mb-4">
        <label className="text-sm text-gray-300 block mb-1">Wallet Label (optional)</label>
        <input
          type="text"
          value={walletLabel}
          onChange={(e) => setWalletLabel(e.target.value)}
          placeholder={`Wallet ${wallets.length + 1}`}
          className="w-full p-3 bg-black/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500 transition-shadow"
        />
      </div>

      <div className="relative mb-4">
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Enter your mnemonic phrase or private key..."
          className="w-full h-28 p-3 bg-black/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500 transition-shadow resize-none"
        />
        <div className="absolute bottom-3 right-3 text-xs text-gray-400">
          {inputValue.trim() &&
            (isMnemonic ? (
              <span className="text-green-400">{wordCount} words (Mnemonic)</span>
            ) : (
              <span className="text-yellow-400">Private Key</span>
            ))}
        </div>
      </div>
      {error && <p className="text-red-400 text-sm mt-2 mb-2 text-center">{error}</p>}

      <div className="flex gap-3">
        {wallets.length > 0 && (
          <button
            onClick={() => {
              setIsAddingWallet(false)
              setInputValue("")
              setWalletLabel("")
              setError("")
            }}
            className="flex-1 bg-gray-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          onClick={handleImport}
          className="flex-1 bg-purple-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-purple-700 transition-colors"
        >
          Import Wallet
        </button>
      </div>

      <div className="bg-yellow-500/10 border border-yellow-500 text-yellow-300 text-sm p-3 rounded-lg mt-4 flex">
        <AlertTriangle size={42} className="mr-3 flex-shrink-0" />
        <p>
          <strong>Security Warning:</strong> This tool is intended for development and testing. Do not use a wallet
          containing substantial funds.
        </p>
      </div>
    </div>
  )
}
