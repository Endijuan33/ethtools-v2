"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { Mnemonic, HDNodeWallet, randomBytes, isError } from "ethers"
import { ArrowLeft, ExternalLink, RefreshCw, WalletIcon } from "lucide-react"
import { getConverterExplorerUrl } from "@/lib/ethers" // FIX: Use the correct explorer URL function
import Card from "./ui/Card"
import Button from "./ui/Button"
import Field, { inputClassName, monoInputClassName, secretInputProps } from "./ui/Field"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import CopyButton from "./ui/CopyButton"
import SecretField from "./ui/SecretField"
import Tabs, { TabPanel } from "./ui/Tabs"
import { cn } from "@/lib/utils"

interface GeneratedWallet {
  address: string
  privateKey: string
  mnemonic: string
}

const DEFAULT_PATH = `m/44'/60'/0'/0/0`

type Network = "mainnet" | "testnet"

const MODES = [
  { id: "generate", label: "Generate New", icon: RefreshCw },
  { id: "import", label: "Import Mnemonic", icon: WalletIcon },
] as const

type Mode = (typeof MODES)[number]["id"]

const NETWORKS = [
  { id: "mainnet", label: "Mainnet" },
  { id: "testnet", label: "Testnet" },
] as const

export default function GeneratorCard() {
  const [mode, setMode] = useState("generate") // 'generate' or 'import'
  const [wallet, setWallet] = useState<GeneratedWallet | null>(null)
  const [generateWordCount, setGenerateWordCount] = useState<12 | 18 | 24>(12)
  const [derivationPath, setDerivationPath] = useState(DEFAULT_PATH)
  const [isLoading, setIsLoading] = useState(false)
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
  const explorerLabel = ethersNetworkForExplorer === "mainnet" ? "Mainnet" : "Sepolia"

  return (
    <Card className="w-full max-w-lg">
      {!wallet ? (
        <div>
          <Tabs
            items={MODES}
            value={mode as Mode}
            onChange={setMode}
            label="Wallet source"
            layoutGroupId="generator-mode"
            className="mb-4"
          />

          <TabPanel id={mode}>
            {mode === "generate" ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Generate a new, random wallet. Choose your desired mnemonic length.
                </p>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div
                    role="group"
                    aria-label="Mnemonic length"
                    className="flex gap-1 rounded-xl border border-border/60 bg-muted/40 p-1 sm:flex-1"
                  >
                    {[12, 18, 24].map((count) => (
                      <button
                        key={count}
                        type="button"
                        onClick={() => setGenerateWordCount(count as 12 | 18 | 24)}
                        aria-pressed={generateWordCount === count}
                        className={cn(
                          "min-h-[40px] flex-1 rounded-lg px-3 text-sm font-medium transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          generateWordCount === count
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {count} words
                      </button>
                    ))}
                  </div>
                  <Button
                    onClick={handleGenerate}
                    isLoading={isLoading}
                    loadingLabel="Generating..."
                    icon={<RefreshCw size={16} aria-hidden="true" />}
                    className="sm:flex-1"
                    fullWidth
                  >
                    Generate
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Import an existing mnemonic phrase to derive addresses and private keys.
                </p>
                <Field
                  label="Mnemonic phrase"
                  action={
                    <Badge tone={isMnemonicLengthValid ? "success" : "neutral"}>
                      {importedWordCount} words
                    </Badge>
                  }
                >
                  {(field) => (
                    <textarea
                      {...field}
                      {...secretInputProps}
                      value={mnemonicInput}
                      onChange={(e) => setMnemonicInput(e.target.value)}
                      placeholder="Enter your 12, 18, or 24 word mnemonic phrase here..."
                      className={cn(inputClassName, "h-28 resize-none")}
                    />
                  )}
                </Field>
                <Button onClick={handleImport} disabled={!isMnemonicLengthValid} fullWidth>
                  Import &amp; View Wallet
                </Button>
              </div>
            )}
          </TabPanel>

          {error && (
            <Alert tone="danger" className="mt-4">
              {error}
            </Alert>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={resetView}
            icon={<ArrowLeft size={16} aria-hidden="true" />}
            className="-ml-2"
          >
            Start Over
          </Button>

          <Field
            label="Derivation Path"
            error={error}
            hint="Edit the path to derive a different account from the same phrase."
          >
            {(field) => (
              <input
                {...field}
                type="text"
                value={derivationPath}
                onChange={(e) => setDerivationPath(e.target.value)}
                className={monoInputClassName}
              />
            )}
          </Field>

          <SecretField label="Mnemonic Phrase" value={wallet.mnemonic} variant="phrase" allowCopy />

          <SecretField label="Private Key" value={wallet.privateKey} variant="text" allowCopy />

          <div className="space-y-1.5">
            <p className="text-sm font-medium text-foreground">Address</p>
            <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/40 p-3">
              <p className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">
                {wallet.address}
              </p>
              <CopyButton value={wallet.address} label="address" />
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <Tabs
              items={NETWORKS}
              value={network}
              onChange={setNetwork}
              label="Explorer network"
              layoutGroupId="generator-network"
            />
            <Button asChild variant="primary" fullWidth>
              <a
                href={routescanUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Check this address on Routescan ${explorerLabel} (opens in a new tab)`}
              >
                Check on Routescan
                <ExternalLink size={16} aria-hidden="true" />
              </a>
            </Button>
          </div>
        </div>
      )}

      <Alert tone="warning" title="Client-side only" className="mt-4">
        Keys are generated in this browser and never sent to a server. Best suited to development,
        testing, or recovery — not to storing real funds.
      </Alert>
    </Card>
  )
}
