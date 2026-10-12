"use client"

import { useState, useMemo, useEffect, useCallback, useRef } from "react"
import {
  RefreshCw,
  Send,
  Plus,
  Trash2,
  ChevronDown,
  Wallet,
  Bookmark as BookmarkIcon,
  FileJson,
  Search,
} from "lucide-react"
import { getAddress, isAddress } from "ethers"
import { classifySecret } from "@/lib/hdWallet"
import {
  getBalanceWei,
  getNativeDecimals,
  NETWORKS,
  getCustomNetworks,
  saveCustomNetwork,
  removeCustomNetwork,
  validateRpcUrl,
  cleanupRpcPools,
  getRpcHealthStatus,
  type Network as NetworkType,
  type CustomNetwork,
  type NetworkConfig,
} from "@/lib/ethers"
import { fetchChainMetadata } from "@/lib/chainMetadata"
import { RpcError } from "@/lib/multiRpc"
import { APP_EVENTS, onAppEvent } from "@/lib/appEvents"
import { QRCodeSVG } from "qrcode.react"
import BookmarkManager from "./BookmarkManager"
import BackupManager from "./BackupManager"
import { getPricesForNetworks } from "@/lib/priceFeed"
import { logger, describeError } from "@/lib/logger"
import {
  formatBalanceForDisplay,
  formatFiat,
  isNonZeroAmount,
  toFiatValue,
  UNKNOWN_VALUE,
} from "@/lib/format"
import { filterValid, isEthAddress, isNonEmptyString, isRecord } from "@/lib/schema"
import { STORAGE_KEYS, readRaw, removeKey, readJson, writeJson, writeRaw } from "@/lib/storage"
import Card, { CardHeader, CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import ResponsiveDialog from "./ui/ResponsiveDialog"
import Field, { inputClassName, monoInputClassName } from "./ui/Field"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import CopyButton from "./ui/CopyButton"
import Tabs, { TabPanel, type TabItem } from "./ui/Tabs"
import { SkeletonList } from "./ui/Skeleton"
import { cn } from "@/lib/utils"

// ===== Types =====

/**
 * An address this panel can display balances for.
 *
 * Deliberately has no privateKey field: this panel never holds, persists,
 * or signs with a secret. Legacy records contribute only their (public)
 * address here; their keys stay untouched in the legacy store until the
 * Vault panel moves them into encrypted storage on unlock. Watch entries
 * are address-only by construction.
 */
interface AddressEntry {
  id: string
  label: string
  address: string
  source: "legacy" | "watch"
}

/** One network's balance, or the reason it could not be read. */
interface BalanceEntry {
  /**
   * Exact balance in base units, or null when the read failed.
   *
   * Read from `getBalanceWei`, never re-parsed from a display string. The
   * string-returning `getBalance` truncates to five decimal places, so parsing it
   * back reported 0 for an account holding less than 0.00001 — which then disabled
   * the Send button on funds that were genuinely spendable.
   */
  baseUnits: bigint | null
  /**
   * Decimals of this network's native unit.
   *
   * Carried per entry rather than assumed globally, so a chain whose native
   * unit differs is priced by its own configuration (see
   * `getNativeDecimals` in lib/ethers). Note Arc's native USDC uses 18
   * decimals - not the 6 decimals of ERC-20 USDC: an earlier 6-decimal
   * override understated Arc balances by a factor of a trillion.
   */
  decimals: number
  /** Already-sanitised, user-presentable failure message. */
  error: string | null
}

interface Balances {
  [networkKey: string]: BalanceEntry
}

/**
 * Per-network RPC health, keyed by network.
 *
 * Mirrors the fields of `PoolHealth` that this card actually renders. The pool
 * derives these from real request outcomes, so there is nothing to poll: the
 * snapshot only changes when a balance request succeeds or fails.
 */
interface RpcHealthIndicator {
  [key: string]: {
    /** At least one endpoint is currently usable. */
    usable: boolean
    /** Best observed latency in ms, or null when nothing has been measured yet. */
    bestLatencyMs: number | null
    healthyEndpoints: number
    totalEndpoints: number
  }
}

interface PriceMap {
  [key: string]: number | null
}

// ===== Constants =====

/**
 * Base tick of the single polling scheduler.
 *
 * One timer drives balances, RPC health, and prices. Three independent intervals
 * meant three chances to leak a timer and three separate wake-ups per minute; a
 * single tick also keeps the network fan-out from overlapping with itself.
 */
const POLL_INTERVAL_MS = 30_000

/** Ticks between price refreshes. Fiat prices move far slower than balances. */
const PRICE_REFRESH_TICKS = 4

/**
 * How long the tab must stay hidden before RPC pools are released.
 *
 * Releasing the pools frees their sockets and cached provider state after a
 * sustained absence. The grace period stops a brief tab switch from thrashing
 * them, and the next visible refresh recreates them lazily.
 */
const IDLE_TEARDOWN_MS = 60_000

/** Mainnet/testnet switch. Declared once so the tab strip stays a stable list. */
const NETWORK_TABS: readonly TabItem<"mainnet" | "testnet">[] = [
  { id: "mainnet", label: "Mainnets" },
  { id: "testnet", label: "Testnets" },
]

/** Links the wallet-selector trigger to the list it controls. */
const WALLET_LIST_ID = "wallet-selector-list"

// ===== Module helpers =====

/** Whether the tab is currently hidden. Safe to call before hydration. */
function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden
}

/** Whether a stored value carries a usable id, label, and address. */
function isAddressRecord(
  value: unknown
): value is { id: string; label: string; address: string } {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id, 128) &&
    isNonEmptyString(value.label, 128) &&
    isEthAddress(value.address)
  )
}

/** Array shape guard for the raw stored wallet list. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/**
 * Read the address list this panel may display.
 *
 * Two sources, neither of which puts a secret into component state:
 * - Legacy records contribute only id, label, and address. Their
 *   `privateKey` field is never copied out of storage by this panel; the
 *   keys are migrated by the Vault panel (see `migrateLegacyWallets`).
 * - Watch entries are address-only records this panel owns.
 *
 * Routed through `lib/storage` so a blocked or corrupted store degrades to
 * an empty list instead of throwing during render, and validated per record
 * so one malformed entry does not discard the rest.
 */
function readStoredWallets(): AddressEntry[] {
  const legacyRaw = readJson<unknown[]>(STORAGE_KEYS.LEGACY_WALLETS, isUnknownArray, [])
  const legacy: AddressEntry[] = filterValid(legacyRaw, isAddressRecord).map((record) => ({
    id: record.id,
    label: record.label,
    address: record.address,
    source: "legacy" as const,
  }))

  const watchRaw = readJson<unknown[]>(STORAGE_KEYS.WATCH_ADDRESSES, isUnknownArray, [])
  const known = new Set(legacy.map((entry) => entry.address.toLowerCase()))
  const watch: AddressEntry[] = filterValid(watchRaw, isAddressRecord)
    .filter((record) => !known.has(record.address.toLowerCase()))
    .map((record) => ({
      id: record.id,
      label: record.label,
      address: record.address,
      source: "watch" as const,
    }))

  return [...legacy, ...watch]
}

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
  /*
   * Auto-fetched metadata. `decimals` is part of the saved network (the
   * portfolio and send flows price by it), so it rides along with the
   * prefilled text fields; a null keeps the 18-decimal default.
   */
  const [decimals, setDecimals] = useState<number | null>(null)
  const [isFetchingMeta, setIsFetchingMeta] = useState(false)
  const [metaNote, setMetaNote] = useState("")

  const handleAddRpcUrl = () => setRpcUrls((prev) => [...prev, ""])
  const handleRemoveRpcUrl = (index: number) => {
    if (rpcUrls.length <= 1) return
    setRpcUrls((prev) => prev.filter((_, i) => i !== index))
  }

  /**
   * Ask the RPC for its chain id, then look the id up in the public chain
   * registry and prefill the form. Only EMPTY fields are filled — anything
   * the user already typed is theirs. The RPC's own chain id is the
   * authoritative input; the registry only supplies the human metadata.
   */
  const handleFetchMetadata = async () => {
    const firstUrl = rpcUrls.find((url) => url.trim() !== "")
    if (!firstUrl) {
      setMetaNote("Enter an RPC URL first, then fetch its metadata.")
      return
    }

    setIsFetchingMeta(true)
    setMetaNote("")
    try {
      const validation = await validateRpcUrl(firstUrl.trim())
      if (!validation.valid) {
        setMetaNote(`Could not read the RPC: ${validation.error ?? "unreachable."}`)
        return
      }

      const lookup = await fetchChainMetadata(validation.chainId ?? 0)
      if (!lookup.ok) {
        setMetaNote(lookup.error)
        return
      }
      if (lookup.value === null) {
        setMetaNote(
          `Chain ${validation.chainId} is not in the public registry — fill in the details manually.`
        )
        return
      }

      const meta = lookup.value
      if (name.trim() === "" && meta.name !== "") setName(meta.name)
      if (currency.trim() === "" && meta.currencySymbol !== "") {
        setCurrency(meta.currencySymbol)
      }
      if (explorerUrl.trim() === "" && meta.explorerUrl !== "") {
        setExplorerUrl(meta.explorerUrl)
      }
      if (meta.decimals !== null) setDecimals(meta.decimals)

      const parts = [
        meta.name !== "" ? meta.name : null,
        meta.currencySymbol !== "" ? meta.currencySymbol : null,
        meta.decimals !== null ? `${meta.decimals} decimals` : null,
      ].filter(Boolean)
      setMetaNote(
        `Chain ${validation.chainId}: ${parts.join(" · ")}${
          name.trim() !== "" || currency.trim() !== "" ? " (only empty fields were filled)" : ""
        }`
      )
    } finally {
      setIsFetchingMeta(false)
    }
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
      ...(decimals !== null ? { decimals } : {}),
    }

    onAdd(key, network)
    setName("")
    setRpcUrls([""])
    setExplorerUrl("")
    setCurrency("")
    setDecimals(null)
    setMetaNote("")
    onClose()
  }

  return (
    <ResponsiveDialog
      isOpen={isOpen}
      onClose={onClose}
      title={`Add Custom RPC (${networkType})`}
      footer={
        <Button
          onClick={handleSubmit}
          disabled={isValidating}
          isLoading={isValidating}
          loadingLabel="Validating RPCs…"
          fullWidth
        >
          Add Network
        </Button>
      }
    >
      <Field label="Network Name" required>
        {(props) => (
          <input
            {...props}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My Custom Chain"
            className={inputClassName}
          />
        )}
      </Field>

      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-foreground">
          RPC URLs
          <span className="ml-1 text-destructive" aria-hidden="true">
            *
          </span>
          <span className="sr-only"> (required)</span> (at least one)
        </legend>
        {rpcUrls.map((url, index) => (
          // The label is per-row so each input has its own accessible name;
          // hidden because the legend already carries the visible heading.
          <Field key={index} label={`RPC URL ${index + 1}`} hideLabel>
            {(props) => (
              <div className="flex items-center gap-2">
                <input
                  {...props}
                  type="text"
                  value={url}
                  onChange={(e) => {
                    const newUrls = [...rpcUrls]
                    newUrls[index] = e.target.value
                    setRpcUrls(newUrls)
                  }}
                  placeholder="https://rpc.example.com"
                  className={cn(monoInputClassName, "flex-1")}
                />
                {rpcUrls.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 hover:text-destructive"
                    onClick={() => handleRemoveRpcUrl(index)}
                    aria-label={`Remove RPC URL ${index + 1}`}
                  >
                    <Trash2 size={18} aria-hidden="true" />
                  </Button>
                )}
              </div>
            )}
          </Field>
        ))}
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0"
          onClick={handleAddRpcUrl}
          icon={<Plus size={16} aria-hidden="true" />}
        >
          Add another RPC URL
        </Button>

        {/*
          One explicit action reads the RPC's chain id and prefills the rest
          of the form from the public registry. Explicit rather than
          on-every-keystroke: the RPC URL is sent a request by the user's own
          hand, and the form stays in control of what gets filled.
        */}
        <div className="flex flex-col gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleFetchMetadata}
            disabled={isFetchingMeta || isValidating}
            isLoading={isFetchingMeta}
            loadingLabel="Fetching metadata…"
            icon={<Search size={16} aria-hidden="true" />}
            className="self-start"
          >
            Fetch metadata from RPC
          </Button>
          {metaNote !== "" && (
            <p
              className="text-xs leading-relaxed text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {metaNote}
            </p>
          )}
        </div>
      </fieldset>

      <Field label="Explorer URL" hint="Optional.">
        {(props) => (
          <input
            {...props}
            type="text"
            value={explorerUrl}
            onChange={(e) => setExplorerUrl(e.target.value)}
            placeholder="https://explorer.example.com"
            className={inputClassName}
          />
        )}
      </Field>

      <Field label="Currency Symbol" required>
        {(props) => (
          <input
            {...props}
            type="text"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="e.g. ETH, BNB"
            className={inputClassName}
          />
        )}
      </Field>

      {error && <Alert tone="danger">{error}</Alert>}
    </ResponsiveDialog>
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
  wallets: AddressEntry[]
  activeWallet: AddressEntry | null
  onSelect: (wallet: AddressEntry) => void
  onAddNew: () => void
  onDelete: (id: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="relative">
      <Button
        variant="secondary"
        fullWidth
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls={WALLET_LIST_ID}
        aria-haspopup="true"
        className="justify-start"
        icon={<Wallet size={18} aria-hidden="true" />}
      >
        <span className="flex-1 truncate text-left">{activeWallet?.label || "Select Wallet"}</span>
        <ChevronDown
          size={18}
          aria-hidden="true"
          className={cn("transition-transform", isOpen && "rotate-180")}
        />
      </Button>

      {isOpen && (
        <div
          id={WALLET_LIST_ID}
          role="group"
          aria-label="Your wallets"
          className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-lg border border-border bg-card shadow-glass-lg"
        >
          <div className="max-h-60 overflow-y-auto">
            {wallets.map((wallet) => (
              <div
                key={wallet.id}
                className={cn(
                  "flex items-center justify-between gap-2 pr-2 transition-colors hover:bg-secondary",
                  activeWallet?.id === wallet.id && "bg-primary/15"
                )}
              >
                {/* Was a <div onClick>, so it could not be reached or activated
                    from the keyboard. */}
                <button
                  type="button"
                  onClick={() => {
                    onSelect(wallet)
                    setIsOpen(false)
                  }}
                  aria-current={activeWallet?.id === wallet.id || undefined}
                  className={cn(
                    "min-w-0 flex-1 px-4 py-3 text-left",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  )}
                >
                  <span className="block truncate font-semibold text-foreground">
                    {wallet.label}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {wallet.address.slice(0, 10)}...{wallet.address.slice(-8)}
                  </span>
                </button>
                {wallet.source === "watch" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(wallet.id)
                    }}
                    title="Remove wallet"
                    aria-label={`Remove wallet ${wallet.label}`}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => {
                onAddNew()
                setIsOpen(false)
              }}
              className={cn(
                "flex min-h-[44px] w-full items-center gap-2 px-4 py-3 text-sm font-semibold text-primary",
                "transition-colors hover:bg-secondary",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              )}
            >
              <Plus size={18} aria-hidden="true" />
              <span>Add Watch Address</span>
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
  const [wallets, setWallets] = useState<AddressEntry[]>([])
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null)
  const [isAddingWallet, setIsAddingWallet] = useState(false)
  const [networkView, setNetworkView] = useState<"mainnet" | "testnet">("mainnet")
  const [balances, setBalances] = useState<Balances>({})
  const [isLoadingBalances, setIsLoadingBalances] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const [walletLabel, setWalletLabel] = useState("")
  const [error, setError] = useState("")
  const [showReceive, setShowReceive] = useState(false)
  const [showSendHelp, setShowSendHelp] = useState(false)
  const [showLogoutConfirmation, setShowLogoutConfirmation] = useState(false)
  const [isMounted, setIsMounted] = useState(false)
  const [showAddRpc, setShowAddRpc] = useState(false)
  const [showBookmarkManager, setShowBookmarkManager] = useState(false)
  const [showBackupManager, setShowBackupManager] = useState(false)
  const [customNetworks, setCustomNetworks] = useState<Record<string, CustomNetwork>>({})
  const [rpcHealth, setRpcHealth] = useState<RpcHealthIndicator>({})
  const [prices, setPrices] = useState<PriceMap>({})
  const [isLoadingPrices, setIsLoadingPrices] = useState(false)

  // --- Request generation guards ---

  /**
   * Monotonic id for balance fetches.
   *
   * Bumped on every refresh, on hide, and on unmount. A response whose id no
   * longer matches is dropped, which is what stops the real race this component
   * had: switching mainnet↔testnet started a second fan-out while the first was
   * still in flight, and whichever finished last won.
   */
  const balanceRequestId = useRef(0)

  /**
   * Aborts the in-flight balance batch.
   *
   * Complements {@link balanceRequestId}: the id stops a stale response from being
   * written, while this stops the request from continuing to occupy a socket at
   * all. Hiding the tab aborts, so nothing keeps running where nobody can see it.
   */
  const balanceAbort = useRef<AbortController | null>(null)

  /** Monotonic id for price fetches. Same contract as {@link balanceRequestId}. */
  const priceRequestId = useRef(0)

  // --- Derived ---
  const activeWallet = useMemo(
    () => wallets.find((w) => w.id === activeWalletId) || null,
    [wallets, activeWalletId]
  )

  const isUnlocked = wallets.length > 0 && !isAddingWallet

  const displayedNetworks = useMemo(() => {
    const allNetworks = { ...NETWORKS, ...customNetworks }
    return Object.entries(allNetworks).filter(([, networkDetails]) => networkDetails.type === networkView) as [
      string,
      NetworkConfig,
    ][]
  }, [networkView, customNetworks])

  /**
   * Whether to render placeholders instead of rows.
   *
   * True only while a fetch is running *and* nothing is cached for the visible
   * networks. Balances are keyed by network and never cleared on a view toggle, so
   * switching tabs or hitting a 30-second refresh keeps the rows that are already
   * correct on screen instead of blanking the list.
   */
  const showBalanceSkeleton = useMemo(
    () =>
      isLoadingBalances && displayedNetworks.every(([key]) => balances[key] === undefined),
    [isLoadingBalances, displayedNetworks, balances]
  )

  // --- Effects ---
  useEffect(() => {
    setIsMounted(true)
  }, [])

  useEffect(() => {
    if (!isMounted) return
    setCustomNetworks(getCustomNetworks())
  }, [isMounted])

  /**
   * Adopt a freshly read wallet list, keeping the active selection valid.
   *
   * Shared by the initial load and the backup-import listener so both paths agree
   * on what happens when the previously active id is no longer present.
   */
  const adoptWallets = useCallback((storedWallets: AddressEntry[]) => {
    setWallets(storedWallets)
    if (storedWallets.length === 0) {
      setActiveWalletId(null)
      removeKey(STORAGE_KEYS.ACTIVE_WALLET)
      return
    }
    const storedActiveId = readRaw(STORAGE_KEYS.ACTIVE_WALLET)
    const isKnown =
      storedActiveId !== null && storedWallets.some((w) => w.id === storedActiveId)
    setActiveWalletId(isKnown ? storedActiveId : storedWallets[0].id)
  }, [])

  useEffect(() => {
    if (!isMounted) return
    // Reads go through lib/storage: accessing localStorage throws outright in some
    // privacy modes, and a corrupt value used to take the whole render down.
    const storedWallets = readStoredWallets()
    if (storedWallets.length > 0) adoptWallets(storedWallets)
  }, [isMounted, adoptWallets])

  /**
   * Re-read everything cached from storage after a backup restore or an erase.
   *
   * Custom networks matter as much as wallets here: they are otherwise loaded
   * only on mount, so a restored network stayed invisible until the user reloaded
   * the page. The previous listener watched a `walletDataUpdated` event that no
   * longer had a dispatcher, so neither refresh happened at all.
   */
  useEffect(() => {
    const handleRestore = (): void => {
      adoptWallets(readStoredWallets())
      setCustomNetworks(getCustomNetworks())
    }

    return onAppEvent(APP_EVENTS.DATA_RESTORED, handleRestore)
  }, [adoptWallets])

  // --- Refresh primitives ---

  /**
   * Discard cached balances when the active wallet changes.
   *
   * Balances belong to an address, so showing the previous wallet's figures under
   * a newly selected one would be actively misleading. This is deliberately keyed
   * on the address and nothing else: the old code cleared on every `networkView`
   * change too, which threw away good data and blanked the list on each toggle.
   */
  useEffect(() => {
    setBalances((prev) => (Object.keys(prev).length === 0 ? prev : {}))
  }, [activeWallet?.address])

  /**
   * Read the RPC health snapshot.
   *
   * Local only: it inspects state `lib/multiRpc` already maintains from real
   * request outcomes and issues no requests of its own. That is why there is no
   * health timer any more — a dedicated 30-second poll across every network was
   * roughly 50 requests a minute spent re-discovering what the balance refresh
   * had just found out.
   */
  const refreshRpcHealth = useCallback(() => {
    const healthMap = getRpcHealthStatus()
    const newHealth: RpcHealthIndicator = {}
    for (const [network, health] of healthMap) {
      if (health.totalEndpoints === 0) continue
      newHealth[network] = {
        usable: health.usable,
        bestLatencyMs: health.bestLatencyMs,
        healthyEndpoints: health.healthyEndpoints,
        totalEndpoints: health.totalEndpoints,
      }
    }
    setRpcHealth(newHealth)
  }, [])

  /**
   * Fetch fiat prices for the visible mainnet networks.
   *
   * Guarded by a request id so a response from a superseded request — a network
   * switch, a wallet switch, or an unmount — cannot land on current state.
   */
  const refreshPrices = useCallback(async () => {
    if (displayedNetworks.length === 0) return

    // Prices are resolved from each network's native currency rather than its
    // name. Keying by name previously priced every ETH-native L2 using its
    // governance token — OP for Optimism, ARB for Arbitrum — which misstated the
    // portfolio total by orders of magnitude. Testnets are excluded entirely, so
    // test funds are never shown a real-money value.
    const priceable = displayedNetworks.map(([key, config]) => ({
      key,
      currency: config.currency,
      isTestnet: config.type === "testnet",
    }))

    if (priceable.every((entry) => entry.isTestnet)) return

    const requestId = priceRequestId.current + 1
    priceRequestId.current = requestId
    setIsLoadingPrices(true)

    try {
      const priceMap = await getPricesForNetworks(priceable, "usd")
      if (priceRequestId.current !== requestId) return
      const newPrices: PriceMap = {}
      for (const [network, price] of priceMap) {
        newPrices[network] = price
      }
      setPrices((prev) => ({ ...prev, ...newPrices }))
    } catch (error) {
      // Keep the previous prices: a stale price is more useful than an em dash,
      // and the raw error never reaches the UI.
      logger.warn("Price refresh failed", { networks: priceable.length, error })
    } finally {
      if (priceRequestId.current === requestId) setIsLoadingPrices(false)
    }
  }, [displayedNetworks])

  /**
   * Read one network's balance. Never rejects.
   *
   * Exactly one attempt at this layer. Retries, per-request timeouts, and endpoint
   * failover all live in the pool inside `lib/multiRpc`, and nesting a second
   * retry loop here multiplied the worst-case latency by the retry count — a
   * single dead network could hold the whole batch for the better part of a
   * minute.
   *
   * Returns null when the request was aborted, which is not a failure to report:
   * the tab was hidden or the view moved on, and writing "The request was
   * cancelled" into twenty rows would be noise the user never asked about.
   *
   * @param address - Account to read.
   * @param networkKey - Network to read it on.
   * @param signal - Aborted when this batch is superseded.
   */
  const fetchBalanceOnce = useCallback(
    async (
      address: string,
      networkKey: string,
      signal: AbortSignal
    ): Promise<BalanceEntry | null> => {
      const decimals = getNativeDecimals(networkKey)
      try {
        // Exact base units, not the truncated display string: `getBalance` cuts to
        // five decimals, and a "can send" decision taken on that refuses to spend
        // real dust.
        const wei = await getBalanceWei(address, networkKey, signal)
        return { baseUnits: wei, decimals, error: null }
      } catch (error) {
        if (signal.aborted || (error instanceof RpcError && error.kind === "aborted")) {
          return null
        }
        logger.warn("Balance fetch failed", { network: networkKey, error })
        // `RpcError.userMessage` separates "rate limited, wait a moment" from
        // "every endpoint failed", which is the difference between a user waiting
        // and a user giving up. It is also the only message here guaranteed not to
        // embed an endpoint URL — those can carry an API key.
        return {
          baseUnits: null,
          decimals,
          error:
            error instanceof RpcError
              ? error.userMessage
              : describeError(error, "Could not load balance."),
        }
      }
    },
    []
  )

  /**
   * Refresh balances for the visible networks.
   *
   * Each network is applied on its own as it resolves, so one slow or failing
   * endpoint shows a per-row error instead of holding up — or failing — the whole
   * batch. Every write is gated on the request id, which is what stops a response
   * from a previous network view or wallet from overwriting current state.
   */
  const refreshBalances = useCallback(async () => {
    const address = activeWallet?.address
    if (address === undefined) return

    const requestId = balanceRequestId.current + 1
    balanceRequestId.current = requestId

    // Abort the previous batch outright rather than merely ignoring its result.
    // The id check alone stops a stale write, but the sockets stayed busy — on a
    // fast tab switch that meant two full fan-outs in flight at once.
    balanceAbort.current?.abort()
    const controller = new AbortController()
    balanceAbort.current = controller
    setIsLoadingBalances(true)

    const networkKeys = displayedNetworks.map(([key]) => key)
    await Promise.all(
      networkKeys.map(async (networkKey) => {
        const entry = await fetchBalanceOnce(address, networkKey, controller.signal)
        if (entry === null || balanceRequestId.current !== requestId) return
        setBalances((prev) => ({ ...prev, [networkKey]: entry }))
      })
    )

    if (balanceRequestId.current !== requestId) return
    setIsLoadingBalances(false)
    // The pool records each endpoint's outcome as these requests resolve, so this
    // is the one moment the health snapshot can have changed. Reading it here is
    // what makes the old 30-second health interval redundant.
    refreshRpcHealth()
  }, [activeWallet?.address, displayedNetworks, fetchBalanceOnce, refreshRpcHealth])

  /**
   * Single coordinated poller.
   *
   * Replaces three independent intervals (balances 30s, RPC health 30s, prices
   * 120s), none of which paused while the tab was hidden. The health interval is
   * gone entirely — the pool now derives health from real request outcomes, so
   * that timer was pure overhead. One timer ticks only while the tab is visible;
   * going hidden stops it, and coming back refreshes once immediately because
   * anything cached is by then stale.
   *
   * After a sustained hidden period the RPC pools are released as well, so nothing
   * of this component's survives in the background. The teardown is skipped while
   * a send dialog is open so it can never interfere with a transaction the user is
   * in the middle of.
   */
  useEffect(() => {
    if (!isUnlocked) return

    let tick = 0
    let timer: ReturnType<typeof setInterval> | null = null
    let teardownTimer: ReturnType<typeof setTimeout> | null = null

    const stopTimer = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }

    const cancelTeardown = () => {
      if (teardownTimer === null) return
      clearTimeout(teardownTimer)
      teardownTimer = null
    }

    const startTimer = () => {
      if (timer !== null) return
      timer = setInterval(() => {
        tick += 1
        // Health rides along inside refreshBalances; it has no timer of its own.
        void refreshBalances()
        if (tick % PRICE_REFRESH_TICKS === 0) void refreshPrices()
      }, POLL_INTERVAL_MS)
    }

    const refreshEverything = () => {
      tick = 0
      void refreshBalances()
      void refreshPrices()
    }

    const handleVisibilityChange = () => {
      if (isDocumentHidden()) {
        stopTimer()
        // Abandon anything in flight: its response would be written into a view
        // the user is no longer looking at, and the request itself would keep a
        // socket busy in a tab nobody is watching.
        balanceRequestId.current += 1
        priceRequestId.current += 1
        balanceAbort.current?.abort()
        setIsLoadingBalances(false)
        setIsLoadingPrices(false)
        cancelTeardown()
        teardownTimer = setTimeout(() => {
          if (!isDocumentHidden()) return
          cleanupRpcPools()
        }, IDLE_TEARDOWN_MS)
        return
      }

      cancelTeardown()
      refreshEverything()
      startTimer()
    }

    if (isDocumentHidden()) {
      // Mounted in a background tab: issue nothing and wait for the tab to be
      // looked at rather than firing a fan-out nobody can see. Reading health is
      // free — it only reflects pools that already exist.
      refreshRpcHealth()
    } else {
      refreshEverything()
      startTimer()
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      stopTimer()
      cancelTeardown()
      // Invalidate in-flight work so a late response cannot call setState after
      // this effect — or the component — has gone away, and abort it so it stops
      // consuming the network too.
      balanceRequestId.current += 1
      priceRequestId.current += 1
      balanceAbort.current?.abort()
    }
  }, [isUnlocked, refreshBalances, refreshPrices, refreshRpcHealth])

  // Release RPC pools when the component goes away for good.
  useEffect(() => {
    return () => {
      cleanupRpcPools()
    }
  }, [])

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
    // Also remove price data for this network
    setPrices((prev) => {
      const updated = { ...prev }
      delete updated[key]
      return updated
    })
  }

  const handleImport = () => {
    setError("")
    const trimmedInput = inputValue.trim()
    if (!trimmedInput) {
      setError("Please enter an Ethereum address to watch.")
      return
    }

    // A secret pasted here is never persisted by this panel. classifySecret
    // is the same classifier the Converter uses, so a phrase or key gets a
    // precise redirect instead of a generic "invalid address".
    const classified = classifySecret(trimmedInput)
    if (classified.kind === "mnemonic" || classified.kind === "private-key") {
      setError(
        "That is a recovery phrase or private key. This panel never stores secrets: " +
          "import it in the Vault panel instead, where it is stored encrypted. " +
          "Wallets imported by older versions are moved into the vault automatically when you unlock it."
      )
      return
    }

    if (!isAddress(trimmedInput)) {
      setError("That is not a valid Ethereum address.")
      return
    }
    const address = getAddress(trimmedInput)

    if (wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) {
      setError("This address is already in the list.")
      return
    }

    const newEntry: AddressEntry = {
      id: crypto.randomUUID(),
      label: walletLabel.trim() || `Watch ${wallets.length + 1}`,
      address,
      source: "watch",
    }

    // Only watch records are written, and they contain no secret material.
    const watchRecords = wallets
      .filter((w) => w.source === "watch")
      .map((w) => ({ id: w.id, label: w.label, address: w.address }))
    const write = writeJson(STORAGE_KEYS.WATCH_ADDRESSES, [
      ...watchRecords,
      { id: newEntry.id, label: newEntry.label, address: newEntry.address },
    ])
    if (!write.ok) {
      logger.error("Could not persist the watch address", { reason: write.reason })
      setError(write.error)
      return
    }
    writeRaw(STORAGE_KEYS.ACTIVE_WALLET, newEntry.id)

    setWallets((prev) => [...prev, newEntry])
    setActiveWalletId(newEntry.id)
    setInputValue("")
    setWalletLabel("")
    setIsAddingWallet(false)
  }

  const handleSelectWallet = (wallet: AddressEntry) => {
    setActiveWalletId(wallet.id)
    writeRaw(STORAGE_KEYS.ACTIVE_WALLET, wallet.id)
  }

  const handleDeleteWallet = (walletId: string) => {
    // Only watch entries can be removed individually: they are address-only
    // records this panel owns. A legacy record carries key material and is
    // removed either by vault migration (the safe path) or by the explicit
    // erase-all below - never by rewriting the remaining plaintext records
    // from this panel.
    const target = wallets.find((w) => w.id === walletId)
    if (!target || target.source !== "watch") return

    const updatedWatch = wallets
      .filter((w) => w.source === "watch" && w.id !== walletId)
      .map((w) => ({ id: w.id, label: w.label, address: w.address }))
    const write = writeJson(STORAGE_KEYS.WATCH_ADDRESSES, updatedWatch)
    if (!write.ok) {
      logger.error("Could not persist the watch removal", { reason: write.reason })
      setError(write.error)
      return
    }
    const updatedWallets = wallets.filter((w) => w.id !== walletId)
    setWallets(updatedWallets)

    if (activeWalletId === walletId) {
      if (updatedWallets.length > 0) {
        setActiveWalletId(updatedWallets[0].id)
        writeRaw(STORAGE_KEYS.ACTIVE_WALLET, updatedWallets[0].id)
      } else {
        setActiveWalletId(null)
        removeKey(STORAGE_KEYS.ACTIVE_WALLET)
      }
    }
  }

  const handleLogout = () => {
    removeKey(STORAGE_KEYS.LEGACY_WALLETS)
    removeKey(STORAGE_KEYS.WATCH_ADDRESSES)
    removeKey(STORAGE_KEYS.ACTIVE_WALLET)
    setWallets([])
    setActiveWalletId(null)
    setError("")
    setBalances({})
    setPrices({})
    // Cancel in-flight work here rather than relying on the scheduler's cleanup.
    // That cleanup does bump these ids, but it runs as a passive effect, so a
    // balance response that resolves between this click and the next commit would
    // still pass its id check and repopulate balances for a wallet that no longer
    // exists on this device.
    balanceRequestId.current += 1
    priceRequestId.current += 1
    balanceAbort.current?.abort()
    setIsLoadingBalances(false)
    setIsLoadingPrices(false)
    setShowLogoutConfirmation(false)
    cleanupRpcPools()
  }

  /**
   * Fiat value of a balance.
   *
   * Converted from exact base units, never from the rounded display string: a
   * `parseFloat` of "0.00000" reported $0.00 for an account holding dust.
   *
   * @param networkKey - Network the balance belongs to.
   * @param baseUnits - Exact balance in base units, or null when unknown.
   * @param decimals - Decimals of this network's native unit.
   */
  const getFiatValue = (
    networkKey: string,
    baseUnits: bigint | null,
    decimals: number
  ): string => {
    if (baseUnits === null) return UNKNOWN_VALUE
    const price = prices[networkKey]
    if (price === null || price === undefined) return UNKNOWN_VALUE
    return formatFiat(toFiatValue(baseUnits, decimals, price))
  }

  // --- Render ---
  if (!isMounted) {
    return (
      <Card className="w-full max-w-lg">
        <p className="py-8 text-center text-muted-foreground">Loading wallet...</p>
      </Card>
    )
  }

  if (isUnlocked && activeWallet) {
    return (
      <Card className="w-full max-w-lg">
        <div className="mb-4">
          <WalletSelector
            wallets={wallets}
            activeWallet={activeWallet}
            onSelect={handleSelectWallet}
            onAddNew={() => setIsAddingWallet(true)}
            onDelete={handleDeleteWallet}
          />
        </div>

        <CardHeader className="items-center">
          <CardTitle>Wallet Dashboard</CardTitle>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              onClick={() => setShowBookmarkManager(true)}
              title="Manage Address Bookmarks"
              aria-label="Manage address bookmarks"
            >
              <BookmarkIcon size={20} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              onClick={() => setShowBackupManager(true)}
              title="Backup & Restore Data"
              aria-label="Backup and restore data"
            >
              <FileJson size={20} aria-hidden="true" />
            </Button>
          </div>
        </CardHeader>

        {/* Was a pair of plain buttons with no roving tabindex and no arrow-key
            support; Tabs implements the WAI-ARIA pattern. */}
        <Tabs
          items={NETWORK_TABS}
          value={networkView}
          onChange={setNetworkView}
          label="Network type"
          layoutGroupId="wallet-networks"
          className="mb-4"
        />

        <TabPanel id={networkView}>
          <Card variant="inset" padding="sm" className="mb-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold capitalize">{networkView} Balances</h3>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11"
                  onClick={() => setShowAddRpc(true)}
                  title="Add Custom RPC"
                  aria-label="Add custom RPC network"
                >
                  <Plus size={20} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11"
                  onClick={() => {
                    void refreshBalances()
                    void refreshPrices()
                  }}
                  disabled={isLoadingBalances || isLoadingPrices}
                  title="Refresh balances and prices"
                  aria-label="Refresh balances and prices"
                >
                  <RefreshCw
                    size={20}
                    aria-hidden="true"
                    className={isLoadingBalances || isLoadingPrices ? "animate-spin" : ""}
                  />
                </Button>
              </div>
            </div>
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {/* Skeletons only while there is genuinely nothing cached. Swapping
                  the whole list for placeholders on every 30-second refresh blanked
                  out data that was already on screen and correct. */}
              {showBalanceSkeleton ? (
                <SkeletonList rows={5} label="Loading balances" />
              ) : (
                displayedNetworks.map(([key, networkInfo]) => {
                  const networkKey = key as NetworkType
                  const balanceInfo = balances[networkKey]
                  const baseUnits = balanceInfo?.baseUnits ?? null
                  // Decided on exact base units, never on the display string.
                  const canSend = baseUnits !== null && isNonZeroAmount(baseUnits)
                  const isCustom = "isCustom" in networkInfo && networkInfo.isCustom
                  const health = rpcHealth[networkKey]
                  // Optimistic until the pool has actually reported: a network with
                  // no recorded request outcome yet is not known to be down.
                  const isHealthy = health?.usable ?? true
                  // An em dash, never "0ms": null means never measured, and a
                  // rendered zero would read as an impossibly fast endpoint.
                  const latencyLabel =
                    health === undefined
                      ? null
                      : health.bestLatencyMs === null
                        ? UNKNOWN_VALUE
                        : `${Math.round(health.bestLatencyMs)}ms`
                  const isMainnet = networkInfo.type === "mainnet"
                  // Per-network decimals: Arc's native unit is USDC at 6, so a
                  // hardcoded 18 understated it by a factor of a trillion.
                  const decimals = balanceInfo?.decimals ?? getNativeDecimals(networkKey)
                  const fiatValue = isMainnet
                    ? getFiatValue(networkKey, baseUnits, decimals)
                    : null
                  const displayBalance =
                    baseUnits !== null
                      ? formatBalanceForDisplay(baseUnits, decimals)
                      : UNKNOWN_VALUE

                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-2 rounded-md bg-muted/40 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-semibold">{networkInfo.name}</span>
                          {/* Colour alone conveyed RPC health before, which is
                              invisible to a colourblind or screen-reader user. */}
                          <Badge tone={isHealthy ? "success" : "danger"} dot>
                            {isHealthy ? "Live" : "Down"}
                            <span className="sr-only"> RPC</span>
                            {latencyLabel !== null && (
                              <span className="font-normal opacity-80">
                                <span className="sr-only">, best latency </span>
                                {latencyLabel}
                              </span>
                            )}
                          </Badge>
                          {isCustom && <Badge tone="primary">Custom</Badge>}
                        </div>
                        {balanceInfo?.error ? (
                          // Per-row failure: one unreachable network no longer
                          // takes the whole batch, and the next tick retries it.
                          // Not a live region — with twenty rows refreshing on a
                          // timer, that would announce continuously.
                          <p className="text-xs text-destructive">{balanceInfo.error}</p>
                        ) : (
                          <div>
                            {/* An em dash, not a zero: an unloaded balance must not
                                look like an empty account. */}
                            <p className="break-all font-mono text-sm">
                              {displayBalance} {networkInfo.currency}
                            </p>
                            {isMainnet && (
                              <p className="text-xs text-muted-foreground">
                                {isLoadingPrices ? "Loading price..." : fiatValue}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {isCustom && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11 hover:text-destructive"
                            onClick={() => handleRemoveCustomNetwork(key)}
                            title="Remove network"
                            aria-label={`Remove network ${networkInfo.name}`}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                          </Button>
                        )}
                        <Button
                          variant="success"
                          size="sm"
                          onClick={() => setShowSendHelp(true)}
                          disabled={!canSend}
                          icon={<Send size={14} aria-hidden="true" />}
                          aria-label={`Send ${networkInfo.currency} on ${networkInfo.name}`}
                        >
                          Send
                        </Button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </Card>
        </TabPanel>

        {/* Buttons */}
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Button onClick={() => setShowReceive(true)} fullWidth>
            Receive
          </Button>
          <Button variant="danger" onClick={() => setShowLogoutConfirmation(true)} fullWidth>
            Logout All
          </Button>
        </div>

        {/* Wallet Info */}
        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">Address</span>
              <CopyButton
                value={activeWallet.address}
                label="address"
                className="h-11 w-11 justify-center"
              />
            </div>
            <p className="break-all rounded-lg border border-border bg-muted/40 p-3 font-mono text-sm">
              {activeWallet.address}
            </p>
          </div>

          {activeWallet.source === "legacy" ? (
            <Alert tone="warning" title="This wallet is not encrypted yet.">
              It was imported by an older version and its key is still stored unencrypted on
              this device. Open the Vault panel and create or unlock your vault: the wallet
              will be moved into encrypted storage automatically and the unencrypted copy
              deleted. Sending from this panel is disabled until then.
            </Alert>
          ) : (
            <Alert tone="info" title="Watch-only address.">
              No private key is stored for this address, so it can be monitored and
              receive funds, but nothing can be sent from it here. To spend from an
              account, import it in the Vault panel.
            </Alert>
          )}
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

        <BackupManager
          isOpen={showBackupManager}
          onClose={() => setShowBackupManager(false)}
        />

        <ResponsiveDialog
          isOpen={showLogoutConfirmation}
          onClose={() => setShowLogoutConfirmation(false)}
          title="Confirm Logout"
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowLogoutConfirmation(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleLogout}>
                Logout All
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            Are you sure? This will remove all {wallets.length} address
            {wallets.length > 1 ? "es" : ""} from this device. Any older wallet that has not
            been migrated into the encrypted vault yet will be permanently lost, because its
            only copy is the unencrypted one stored here.
          </p>
        </ResponsiveDialog>

        <ResponsiveDialog
          isOpen={showSendHelp}
          onClose={() => setShowSendHelp(false)}
          title="Sending requires the encrypted vault"
          size="sm"
          footer={
            <Button variant="secondary" onClick={() => setShowSendHelp(false)} fullWidth>
              Close
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            {activeWallet.source === "legacy"
              ? "This wallet was imported by an older version and is not encrypted yet. Open the Vault panel and create or unlock your vault: it will be moved into encrypted storage automatically, and the unencrypted copy deleted. After that, use the vault account to sign and send."
              : "This is a watch-only address: no private key is stored for it, so nothing can be sent from it here. To spend from this account, import it in the Vault panel, where the key is stored encrypted."}
          </p>
        </ResponsiveDialog>

        <ResponsiveDialog
          isOpen={showReceive}
          onClose={() => setShowReceive(false)}
          title="Your Wallet Address"
          description={activeWallet.label}
          size="sm"
          footer={
            <Button variant="secondary" onClick={() => setShowReceive(false)} fullWidth>
              Close
            </Button>
          }
        >
          <div className="flex flex-col items-center gap-4">
            {/* Fixed light plate: QR scanners expect dark-on-light, so this one
                surface must not follow the theme. */}
            <div className="rounded-lg bg-white p-4">
              <QRCodeSVG value={activeWallet.address} size={160} />
            </div>
            <p className="w-full break-all rounded-lg border border-border bg-muted/40 p-3 text-center font-mono text-sm">
              {activeWallet.address}
            </p>
            <CopyButton
              value={activeWallet.address}
              label="address"
              showText
              className="min-h-[44px] px-3"
            />
          </div>
        </ResponsiveDialog>
      </Card>
    )
  }

  // --- Import View ---
  return (
    <Card className="w-full max-w-lg">
      <CardTitle className="text-center">
        {wallets.length > 0 ? "Add Watch Address" : "Track an Address"}
      </CardTitle>
      <p className="mb-4 mt-1 text-center text-sm text-muted-foreground">
        Add any Ethereum address to watch its balances. To import a wallet you can spend
        from, use the Vault panel: keys are stored encrypted there, never in this panel.
      </p>

      <div className="space-y-4">
        <Field label="Address Label" hint="Optional.">
          {(props) => (
            <input
              {...props}
              type="text"
              value={walletLabel}
              onChange={(e) => setWalletLabel(e.target.value)}
              placeholder={`Watch ${wallets.length + 1}`}
              className={inputClassName}
            />
          )}
        </Field>

        <Field label="Ethereum address" required>
          {(props) => (
            <input
              {...props}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="0x..."
              className={monoInputClassName}
            />
          )}
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="flex flex-col gap-3 sm:flex-row">
          {wallets.length > 0 && (
            <Button
              variant="secondary"
              fullWidth
              onClick={() => {
                setIsAddingWallet(false)
                setInputValue("")
                setWalletLabel("")
                setError("")
              }}
            >
              Cancel
            </Button>
          )}
          <Button fullWidth onClick={handleImport}>
            Add Watch Address
          </Button>
        </div>

        <Alert tone="warning" title="Security warning">
          Never paste a recovery phrase or private key into this panel. It is not stored
          here; use the Vault panel, where secrets are encrypted before they are saved.
        </Alert>
      </div>
    </Card>
  )
}
