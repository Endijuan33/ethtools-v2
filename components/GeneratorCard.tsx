"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { Mnemonic, HDNodeWallet, randomBytes, isError } from "ethers"
import { AlertTriangle, Copy, Check, KeyRound, WalletIcon, RefreshCw, ExternalLink } from "lucide-react"
import { getConverterExplorerUrl } from "@/lib/ethers" // FIX: Use the correct explorer URL function

// Helper function to copy text to clipboard
async function copyToClipboard(text: string, setCopied: (item: string) => void, item: string) {
  try {
    await navigator.clipboard.writeText(text)
    setCopied(item)
    setTimeout(() => setCopied(""), 2000)
  } catch (err) {
    console.error("Failed to copy text:", err)
  }
}

interface GeneratedWallet {
  address: string
  privateKey: string
  mnemonic: string
}

const DEFAULT_PATH = `m/44'/60'/0'/0/0`

type Network = "mainnet" | "testnet"

export default function GeneratorCard() {
  const [mode, setMode] = useState("generate") // 'generate' or 'import'
  const [wallet, setWallet] = useState<GeneratedWallet | null>(null)
  const [generateWordCount, setGenerateWordCount] = useState<12 | 18 | 24>(12)
  const [derivationPath, setDerivationPath] = useState(DEFAULT_PATH)
  const [isLoading, setIsLoading] = useState(false)
  const [copied, setCopied] = useState("")
  const [error, setError] = useState("")
  const [mnemonicInput, setMnemonicInput] = useState("")
  const [network, setNetwork] = useState<Network>("mainnet")

  const mnemonicRef = useRef<string | null>(null)

  const importedWordCount = useMemo(() => {
    const words = mnemonicInput.trim().split(/\s+/).filter(Boolean)
    return words.length
  }, [mnemonicInput])

  const isMnemonicLengthValid = importedWordCount === 12 || importedWordCount === 18 || importedWordCount === 24

  useEffect(() => {
    if (!mnemonicRef.current) return

    setError("")
    try {
      const mnemonic = Mnemonic.fromPhrase(mnemonicRef.current)
      const hdNode = HDNodeWallet.fromMnemonic(mnemonic, derivationPath)

      setWallet({
        mnemonic: mnemonicRef.current,
        address: hdNode.address,
        privateKey: hdNode.privateKey,
      })
    } catch (e) {
      if (isError(e, "INVALID_ARGUMENT")) {
        setError("Invalid derivation path. Please check the format.")
      } else {
        setError("Could not derive wallet from the provided path.")
      }
    }
  }, [derivationPath])

  const handleGenerate = () => {
    setIsLoading(true)
    setError("")
    setWallet(null)
    setMnemonicInput("")
    setDerivationPath(DEFAULT_PATH)
    try {
      const entropySize = generateWordCount === 12 ? 16 : generateWordCount === 18 ? 24 : 32
      const entropy = randomBytes(entropySize)
      const newMnemonic = Mnemonic.fromEntropy(entropy)
      const hdNode = HDNodeWallet.fromMnemonic(newMnemonic, DEFAULT_PATH)

      mnemonicRef.current = newMnemonic.phrase

      setWallet({
        address: hdNode.address,
        privateKey: hdNode.privateKey,
        mnemonic: newMnemonic.phrase,
      })
    } catch {
      setError("Failed to generate wallet. Please try again.")
    }
    setIsLoading(false)
    setCopied("")
  }

  const handleImport = () => {
    setError("")
    if (!isMnemonicLengthValid) {
      setError("Mnemonic must have 12, 18, or 24 words.")
      return
    }
    try {
      const validatedMnemonic = Mnemonic.fromPhrase(mnemonicInput.trim())
      setDerivationPath(DEFAULT_PATH)
      const hdNode = HDNodeWallet.fromMnemonic(validatedMnemonic, DEFAULT_PATH)

      mnemonicRef.current = validatedMnemonic.phrase

      setWallet({
        address: hdNode.address,
        privateKey: hdNode.privateKey,
        mnemonic: validatedMnemonic.phrase,
      })
      setCopied("")
    } catch {
      setError("Invalid mnemonic phrase. Please check your words and try again.")
      setWallet(null)
    }
  }

  const resetView = () => {
    setWallet(null)
    setMnemonicInput("")
    setError("")
    setDerivationPath(DEFAULT_PATH)
    mnemonicRef.current = null
  }

  // FIX: Use the correct function and map 'testnet' to 'sepolia' for the function call.
  const ethersNetworkForExplorer = network === "mainnet" ? "mainnet" : "sepolia"
  const routescanUrl = wallet ? getConverterExplorerUrl(wallet.address, ethersNetworkForExplorer) : ""

  return (
    <div className="w-full max-w-lg p-6 bg-white/10 backdrop-blur-md rounded-xl shadow-glass border border-white/20">
      {!wallet ? (
        <div>
          <div className="w-full bg-black/20 p-1 rounded-lg flex justify-center space-x-1 mb-4">
            <button
              onClick={() => setMode("generate")}
              className={`w-full py-2 rounded-md font-semibold text-sm transition-colors ${mode === "generate" ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-white/10"}`}
            >
              Generate New
            </button>
            <button
              onClick={() => setMode("import")}
              className={`w-full py-2 rounded-md font-semibold text-sm transition-colors ${mode === "import" ? "bg-green-600 text-white" : "text-gray-300 hover:bg-white/10"}`}
            >
              Import Mnemonic
            </button>
          </div>

          {mode === "generate" ? (
            <div className="text-center">
              <p className="text-gray-300 mb-4">Generate a new, random wallet. Choose your desired mnemonic length.</p>
              <div className="flex items-center justify-center gap-4 mb-4">
                <div className="flex items-center bg-black/20 p-1 rounded-lg">
                  {[12, 18, 24].map((count) => (
                    <button
                      key={count}
                      onClick={() => setGenerateWordCount(count as 12 | 18 | 24)}
                      className={`px-4 py-1 rounded-md text-sm font-semibold transition-colors ${
                        generateWordCount === count ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-white/10"
                      }`}
                    >
                      {count} words
                    </button>
                  ))}
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={isLoading}
                  className="bg-blue-600 text-white font-bold py-2 px-5 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center"
                >
                  <RefreshCw size={18} className="mr-2" />
                  {isLoading ? "Generating..." : "Generate"}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-gray-300 mb-4">
                Import an existing mnemonic phrase to derive addresses and private keys.
              </p>
              <div className="relative">
                <textarea
                  value={mnemonicInput}
                  onChange={(e) => setMnemonicInput(e.target.value)}
                  placeholder="Enter your 12, 18, or 24 word mnemonic phrase here..."
                  className="w-full h-28 p-3 bg-black/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 transition-shadow resize-none"
                />
                <div
                  className={`absolute bottom-3 right-3 text-xs ${isMnemonicLengthValid ? "text-green-400" : "text-gray-400"}`}
                >
                  {importedWordCount} words
                </div>
              </div>
              <button
                onClick={handleImport}
                className="mt-3 w-full bg-green-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                disabled={!isMnemonicLengthValid}
              >
                Import & View Wallet
              </button>
            </div>
          )}
          {error && <p className="text-red-400 text-sm mt-4 text-center">{error}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <button onClick={resetView} className="text-sm text-blue-400 hover:underline mb-2">
            ← Start Over
          </button>

          <div className="space-y-1">
            <label htmlFor="derivation-path" className="text-sm font-bold text-gray-300">
              Derivation Path
            </label>
            <input
              id="derivation-path"
              type="text"
              value={derivationPath}
              onChange={(e) => setDerivationPath(e.target.value)}
              className="w-full p-2 bg-black/20 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-bold text-gray-300 flex items-center">
              <WalletIcon className="mr-2" size={16} />
              Mnemonic Phrase
            </label>
            <div className="relative flex items-center bg-black/20 p-3 rounded-lg">
              <p className="text-green-400 break-words flex-grow pr-8">{wallet.mnemonic}</p>
              <button
                onClick={() => copyToClipboard(wallet.mnemonic, setCopied, "mnemonic")}
                className="absolute right-2 p-1 text-gray-400 hover:text-white"
              >
                <Check size={18} className={`text-green-500 ${copied === "mnemonic" ? "opacity-100" : "opacity-0"}`} />
                <Copy
                  size={18}
                  className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ${copied === "mnemonic" ? "opacity-0" : "opacity-100"}`}
                />
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-bold text-gray-300 flex items-center">
              <KeyRound className="mr-2" size={16} />
              Private Key
            </label>
            <div className="relative flex items-center bg-black/20 p-3 rounded-lg">
              <p className="text-orange-400 break-all flex-grow pr-8">{wallet.privateKey}</p>
              <button
                onClick={() => copyToClipboard(wallet.privateKey, setCopied, "pk")}
                className="absolute right-2 p-1 text-gray-400 hover:text-white"
              >
                <Check size={18} className={`text-green-500 ${copied === "pk" ? "opacity-100" : "opacity-0"}`} />
                <Copy
                  size={18}
                  className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ${copied === "pk" ? "opacity-0" : "opacity-100"}`}
                />
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-bold text-gray-300">Address</label>
            <div className="relative flex items-center bg-black/20 p-3 rounded-lg">
              <p className="text-blue-400 break-all flex-grow pr-8">{wallet.address}</p>
              <button
                onClick={() => copyToClipboard(wallet.address, setCopied, "address")}
                className="absolute right-2 p-1 text-gray-400 hover:text-white"
              >
                <Check size={18} className={`text-green-500 ${copied === "address" ? "opacity-100" : "opacity-0"}`} />
                <Copy
                  size={18}
                  className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ${copied === "address" ? "opacity-0" : "opacity-100"}`}
                />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <div className="flex items-center bg-black/20 p-1 rounded-lg">
              {(["mainnet", "testnet"] as Network[]).map((net) => (
                <button
                  key={net}
                  onClick={() => setNetwork(net)}
                  className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${
                    network === net ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-white/10"
                  }`}
                >
                  {net}
                </button>
              ))}
            </div>
            <a
              href={routescanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-grow flex items-center justify-center bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Check on Routescan
              <ExternalLink size={18} className="ml-2" />
            </a>
          </div>
        </div>
      )}
      <div className="bg-yellow-500/10 border border-yellow-500 text-yellow-300 text-sm p-3 rounded-lg mt-4 flex">
        <AlertTriangle size={32} className="mr-2 flex-shrink-0" />
        <p>
          <strong>Security Warning:</strong> This is a client-side tool. Your keys are never sent to a server, but
          always be cautious. Best for development, testing, or recovery.
        </p>
      </div>
    </div>
  )
}
