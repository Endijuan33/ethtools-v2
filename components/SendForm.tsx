"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Send, Bookmark, ChevronDown, Check, SlidersHorizontal } from "lucide-react"
import { Wallet, formatUnits, isAddress, type TransactionRequest } from "ethers"
import {
  RpcError,
  getAllNetworks,
  getNativeDecimals,
  withProvider,
  withProviderOnce,
  type Network,
} from "@/lib/ethers"
import { getGasOverview, type GasOverview } from "@/lib/gasTracker"
import { saveTransaction, updateTransactionStatus } from "@/lib/transactionHistory"
import { getBookmarksByNetwork, isAddressBookmarked } from "@/lib/bookmarks"
import { collectKnownAddresses, describeSharedPattern, screenAddress } from "@/lib/addressGuard"
import { formatFiat, parseAmount } from "@/lib/format"
import { formatUnit } from "@/lib/units"
import { describeError, logger } from "@/lib/logger"
import BookmarkManager from "./BookmarkManager"
import ResponsiveDialog from "./ui/ResponsiveDialog"
import Card from "./ui/Card"
import Button from "./ui/Button"
import Field, { inputClassName, monoInputClassName } from "./ui/Field"
import Tabs from "./ui/Tabs"
import Alert from "./ui/Alert"
import { notify } from "./ui/Toast"
import { cn } from "@/lib/utils"

interface SendFormProps {
  network: Network
  wallet: { address: string; privateKey: string }
  onClose: () => void
  onSuccess: (txHash: string) => void
}

/** Links the dropdown trigger to the list it controls. */
const BOOKMARK_LIST_ID = "send-form-bookmark-list"

/** Selectable fee levels. */
type GasTier = "low" | "recommended" | "fast" | "custom"

const GAS_TIER_TABS = [
  { id: "low", label: "Low" },
  { id: "recommended", label: "Recommended" },
  { id: "fast", label: "Fast" },
  { id: "custom", label: "Custom" },
] as const

/** Slider resolution: 1000 positions across the spendable range. */
const SLIDER_STEPS = 1000

/**
 * A custom fee is capped at this many gwei so one fat-fingered zero cannot
 * silently burn the balance; any honest fee sits far below it.
 */
const MAX_CUSTOM_GWEI = 10_000

/**
 * Headroom added on top of the tier total when building `maxFeePerGas`. The
 * base fee can rise up to 12.5% per block between estimate and inclusion, and
 * OP-stack chains add an L1 data fee the estimate does not include; half a
 * base fee of slack absorbs both while the unused part is refunded.
 */
function withHeadroom(total: bigint, baseFee: bigint | null): bigint {
  return baseFee === null ? total : total + baseFee / 2n
}

export default function SendForm({ network, wallet, onClose, onSuccess }: SendFormProps) {
  const [recipient, setRecipient] = useState("")
  const [amount, setAmount] = useState("")
  const [error, setError] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [showBookmarkManager, setShowBookmarkManager] = useState(false)
  const [isBookmarkDropdownOpen, setIsBookmarkDropdownOpen] = useState(false)

  /*
   * Gas tier state. The overview (three tiers + base fee + priority fees +
   * USD price) is fetched once per dialog via the pooled RPC path; if that
   * fetch fails, sending still works — the node fills its own defaults — but
   * the selector says so instead of presenting invented numbers.
   */
  const [gasTier, setGasTier] = useState<GasTier>("recommended")
  const [gasOverview, setGasOverview] = useState<GasOverview | null>(null)
  const [gasNote, setGasNote] = useState<string | null>(null)
  const [customPriorityGwei, setCustomPriorityGwei] = useState("")
  const [customMaxFeeGwei, setCustomMaxFeeGwei] = useState("")
  const [customGasPriceGwei, setCustomGasPriceGwei] = useState("")

  /** Balance and the estimated gas limit, needed for the slider and fee math. */
  const [balance, setBalance] = useState<bigint | null>(null)
  const [gasLimit, setGasLimit] = useState(21_000n)

  const networkInfo = getAllNetworks()[network]
  const currencySymbol = networkInfo?.currency || "ETH"
  // Not every chain uses 18 decimals; assuming so would misprice a transfer.
  const nativeDecimals = getNativeDecimals(network)

  // Get bookmarks for this network
  const bookmarks = getBookmarksByNetwork(network as string)

  // Check if current recipient is bookmarked
  const isBookmarked = recipient && isAddress(recipient) && isAddressBookmarked(recipient)

  /*
   * Address-poisoning screen for the typed recipient, against every bookmark
   * and past recipient on any network — a lookalike does not care which chain
   * the real counterparty was saved for. Recomputed as the recipient changes,
   * and again when the bookmark manager closes, because a bookmark added
   * mid-dialog makes an exact match safe again. The comparison is pure and
   * reads only local data, so no debounce is needed. The result only ever
   * warns: it must never gate the send button, since a legitimately new
   * address can look similar by chance.
   */
  const recipientScreen = useMemo(
    () => screenAddress(recipient, collectKnownAddresses()),
    // `showBookmarkManager` is not read inside the memo, but closing the
    // manager may have changed the stored bookmarks the screen reads, so it
    // is a recompute trigger the exhaustive-deps rule cannot see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recipient, showBookmarkManager]
  )

  // ---- Gas + balance load (once per open) ----
  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      const [overviewResult, balanceResult] = await Promise.allSettled([
        getGasOverview(network),
        withProvider(network, (provider) => provider.getBalance(wallet.address)),
      ])

      if (cancelled) return

      if (overviewResult.status === "fulfilled") {
        setGasOverview(overviewResult.value)
        setGasNote(null)
      } else {
        logger.warn("Send form gas overview fetch failed", {
          network,
          error: overviewResult.reason,
        })
        setGasOverview(null)
        setGasNote(
          "Fee levels could not be fetched for this network. Sending will use the node's own suggestion."
        )
      }

      if (balanceResult.status === "fulfilled") {
        setBalance(balanceResult.value)
      } else {
        setBalance(null)
        logger.warn("Send form balance fetch failed", {
          network,
          error: balanceResult.reason,
        })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [network, wallet.address])

  // ---- Gas limit estimate (debounced, on a valid recipient) ----
  const recipientIsValid = recipient !== "" && isAddress(recipient)
  useEffect(() => {
    if (!recipientIsValid) {
      // A plain transfer is 21000; the estimate only matters for contracts.
      setGasLimit(21_000n)
      return
    }

    let cancelled = false
    const timer = setTimeout(() => {
      void withProvider(network, async (provider) => {
        try {
          const estimated = await provider.estimateGas({
            to: recipient,
            value: 1n,
          })
          if (!cancelled) setGasLimit((estimated * 120n) / 100n)
        } catch {
          // Estimate failure is not fatal: fall back to the transfer limit and
          // let the send-time estimate surface a genuine revert.
          if (!cancelled) setGasLimit(21_000n)
        }
      })
    }, 600)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [recipientIsValid, recipient, network])

  // ---- Derived fee values ----
  const tierTotal: bigint | null = useMemo(() => {
    if (gasOverview === null) return null
    if (gasTier === "low") return gasOverview.slow
    if (gasTier === "recommended") return gasOverview.standard
    if (gasTier === "fast") return gasOverview.fast
    return null
  }, [gasOverview, gasTier])

  const customFeeError = useMemo(() => {
    if (gasTier !== "custom" || gasOverview === null) return null
    const is1559 = gasOverview.isEip1559

    if (is1559) {
      if (customPriorityGwei === "" || customMaxFeeGwei === "") {
        return "Enter a priority fee and a max fee to use a custom fee."
      }
      const priority = parseAmount(customPriorityGwei, 9)
      if (!priority.ok) return priority.error
      const maxFee = parseAmount(customMaxFeeGwei, 9)
      if (!maxFee.ok) return maxFee.error
      if (priority.value <= 0n) return "The priority fee must be greater than zero."
      if (maxFee.value < priority.value) {
        return "The max fee cannot be lower than the priority fee."
      }
      if (maxFee.value > BigInt(MAX_CUSTOM_GWEI) * 1_000_000_000n) {
        return `Fees are capped at ${MAX_CUSTOM_GWEI.toLocaleString()} gwei for safety.`
      }
      if (gasOverview.baseFee !== null && maxFee.value < gasOverview.baseFee) {
        return `The max fee is below the current base fee (${formatUnit(gasOverview.baseFee, "gwei")} gwei); the transaction would stall.`
      }
      return null
    }

    if (customGasPriceGwei === "") return "Enter a gas price to use a custom fee."
    const gasPrice = parseAmount(customGasPriceGwei, 9)
    if (!gasPrice.ok) return gasPrice.error
    if (gasPrice.value <= 0n) return "The gas price must be greater than zero."
    if (gasPrice.value > BigInt(MAX_CUSTOM_GWEI) * 1_000_000_000n) {
      return `Fees are capped at ${MAX_CUSTOM_GWEI.toLocaleString()} gwei for safety.`
    }
    return null
  }, [gasTier, gasOverview, customPriorityGwei, customMaxFeeGwei, customGasPriceGwei])

  /** The per-gas price the send will pay, for the fee preview. */
  const selectedPerGas: bigint | null = useMemo(() => {
    if (gasTier !== "custom") return tierTotal
    if (gasOverview === null || customFeeError !== null) return null
    return gasOverview.isEip1559
      ? parseAmount(customMaxFeeGwei, 9).ok
        ? (parseAmount(customMaxFeeGwei, 9) as { ok: true; value: bigint }).value
        : null
      : parseAmount(customGasPriceGwei, 9).ok
        ? (parseAmount(customGasPriceGwei, 9) as { ok: true; value: bigint }).value
        : null
  }, [gasTier, tierTotal, gasOverview, customFeeError, customMaxFeeGwei, customGasPriceGwei])

  const feeEstimateWei: bigint | null =
    selectedPerGas === null ? null : selectedPerGas * gasLimit

  const feeEstimateUsd: number | null = useMemo(() => {
    if (feeEstimateWei === null || gasOverview?.nativePriceUsd == null) return null
    const native = Number(formatUnits(feeEstimateWei, nativeDecimals))
    return Number.isFinite(native) ? native * gasOverview.nativePriceUsd : null
  }, [feeEstimateWei, gasOverview, nativeDecimals])

  /**
   * The most that can be sent: balance minus the fee and a reserve, so "max"
   * never bounces for insufficient funds when the base fee ticks up or an
   * OP-stack L1 data fee appears. Mirrors the margin the old Max button used.
   */
  const maxSpendable: bigint | null = useMemo(() => {
    if (balance === null || feeEstimateWei === null) return null
    const reserve = feeEstimateWei + feeEstimateWei / 2n
    return balance > reserve ? balance - reserve : 0n
  }, [balance, feeEstimateWei])

  // ---- Slider ↔ amount wiring ----
  const parsedAmount = useMemo(() => parseAmount(amount, nativeDecimals), [amount, nativeDecimals])

  const sliderPos = useMemo(() => {
    if (maxSpendable === null || maxSpendable === 0n) return 0
    if (!parsedAmount.ok) return 0
    // Ratio only: the magnitudes lose precision in Number, but the slider
    // position is a presentation concern, not a money concern.
    const ratio = Number((parsedAmount.value * BigInt(SLIDER_STEPS)) / maxSpendable)
    return Math.min(Math.max(Math.round(ratio), 0), SLIDER_STEPS)
  }, [parsedAmount, maxSpendable])

  const handleSliderChange = (position: number): void => {
    if (maxSpendable === null) return
    if (position === SLIDER_STEPS) {
      setAmount(formatUnits(maxSpendable, nativeDecimals))
      return
    }
    const wei = (maxSpendable * BigInt(position)) / BigInt(SLIDER_STEPS)
    setAmount(wei === 0n ? "" : formatUnits(wei, nativeDecimals))
  }

  const handleSetMaxAmount = (): void => {
    if (maxSpendable === null) return
    setAmount(maxSpendable === 0n ? "" : formatUnits(maxSpendable, nativeDecimals))
  }

  // Auto-fill recipient from bookmark
  const handleSelectBookmark = (address: string) => {
    setRecipient(address)
    setIsBookmarkDropdownOpen(false)
  }

  const handleSend = async () => {
    setError("")

    if (!isAddress(recipient)) {
      setError("Enter a valid recipient address.")
      return
    }

    // Validate through the shared bigint-exact parser rather than parseFloat.
    const sendAmount = parseAmount(amount, nativeDecimals)
    if (!sendAmount.ok) {
      setError(sendAmount.error)
      return
    }

    if (gasTier === "custom" && customFeeError !== null) {
      setError(customFeeError)
      return
    }

    setIsSending(true)
    let broadcastHash = ""

    try {
      // Estimate against the real recipient and value, not a placeholder.
      const request: TransactionRequest = { to: recipient, value: sendAmount.value }

      try {
        const estimated = await withProvider(network, (provider) =>
          provider.estimateGas(request)
        )
        request.gasLimit = (estimated * 120n) / 100n
      } catch (estError) {
        // A failed estimate usually means the transaction would revert. Surface
        // it rather than broadcasting blind and burning the fee.
        logger.warn("Gas estimation failed", { network, error: estError })
        setError(
          estError instanceof RpcError
            ? estError.userMessage
            : "This transaction is expected to fail, so it was not sent. Check the recipient and amount."
        )
        setIsSending(false)
        return
      }

      /*
       * Apply the selected fee. Tiered and custom fees only ride along when the
       * overview was fetched — otherwise the node's own suggestion is used and
       * the selector already told the user that.
       */
      if (gasOverview !== null) {
        if (gasTier !== "custom") {
          const priority =
            gasTier === "low"
              ? gasOverview.slowPriority
              : gasTier === "fast"
                ? gasOverview.fastPriority
                : gasOverview.standardPriority
          const total =
            gasTier === "low"
              ? gasOverview.slow
              : gasTier === "fast"
                ? gasOverview.fast
                : gasOverview.standard

          if (gasOverview.isEip1559) {
            request.maxPriorityFeePerGas = priority
            request.maxFeePerGas = withHeadroom(total, gasOverview.baseFee)
          } else {
            request.gasPrice = total
          }
        } else if (gasOverview.isEip1559) {
          const priority = parseAmount(customPriorityGwei, 9)
          const maxFee = parseAmount(customMaxFeeGwei, 9)
          if (priority.ok && maxFee.ok) {
            request.maxPriorityFeePerGas = priority.value
            request.maxFeePerGas = maxFee.value
          }
        } else {
          const gasPrice = parseAmount(customGasPriceGwei, 9)
          if (gasPrice.ok) request.gasPrice = gasPrice.value
        }
      }

      // Broadcast exactly once. Retrying an ambiguous timeout could submit the
      // same transaction twice, so this deliberately does not fail over.
      const response = await withProviderOnce(network, async (provider) => {
        const signer = new Wallet(wallet.privateKey, provider)
        return signer.sendTransaction(request)
      })

      broadcastHash = response.hash

      const saved = saveTransaction({
        hash: broadcastHash,
        network,
        from: wallet.address,
        to: recipient,
        amount,
        currency: currencySymbol,
        status: "pending",
      })
      if (saved !== undefined && !saved.ok) {
        // The transaction is already on the network; only the local record failed.
        notify.warning("Transaction sent, but history could not be saved", saved.error)
      }

      onSuccess(broadcastHash)

      // Resolve the real outcome. A transaction is "success" only when a receipt
      // confirms status 1. Anything else is genuinely unknown, and reporting
      // unknown as success tells the user their funds moved when they may not
      // have.
      try {
        const receipt = await response.wait(1)
        if (receipt === null) {
          updateTransactionStatus(broadcastHash, "unknown")
          notify.warning(
            "Transaction status unknown",
            "It was broadcast but no receipt was returned. Check the explorer before retrying."
          )
        } else if (receipt.status === 1) {
          updateTransactionStatus(broadcastHash, "success")
          notify.success("Transaction confirmed")
        } else {
          updateTransactionStatus(broadcastHash, "failed")
          notify.error("Transaction reverted", "The network rejected it. The fee was still spent.")
        }
      } catch (confirmError) {
        // Could not confirm. The transaction may still be in the mempool, so it
        // is neither a success nor a failure.
        logger.warn("Confirmation wait failed", { network, error: confirmError })
        updateTransactionStatus(broadcastHash, "unknown")
        notify.warning(
          "Could not confirm the transaction",
          "It was broadcast successfully. Check the explorer for its final status."
        )
      }
    } catch (sendError) {
      logger.error("Send failed", { network, error: sendError })
      setError(
        sendError instanceof RpcError
          ? sendError.userMessage
          : describeError(sendError, "The transaction could not be sent.")
      )

      // Only record a failure that actually reached the network. A pre-broadcast
      // failure has no hash.
      if (broadcastHash !== "") {
        updateTransactionStatus(broadcastHash, "failed")
      }
    } finally {
      setIsSending(false)
    }
  }

  const showCustomInputs = gasTier === "custom" && gasOverview !== null
  const sliderDisabled = maxSpendable === null || maxSpendable === 0n

  return (
    <>
      <ResponsiveDialog
        isOpen
        onClose={onClose}
        title={`Send ${currencySymbol}`}
        description={networkInfo ? `On ${networkInfo.name}` : undefined}
        footer={
          <Button
            onClick={handleSend}
            disabled={isSending || !recipient || !amount || customFeeError !== null}
            isLoading={isSending}
            loadingLabel="Sending…"
            variant="success"
            fullWidth
            icon={<Send size={18} aria-hidden="true" />}
          >
            Send
          </Button>
        }
      >
        {/* Recipient Address with Bookmark Support */}
        <div className="space-y-1.5">
          <Field
            label="Recipient Address"
            required
            action={
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => setShowBookmarkManager(true)}
                icon={<Bookmark size={14} aria-hidden="true" />}
              >
                {bookmarks.length > 0 ? `Bookmarks (${bookmarks.length})` : "Add bookmark"}
              </Button>
            }
          >
            {(props) => (
              <div className="relative">
                <input
                  {...props}
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  className={cn(monoInputClassName, bookmarks.length > 0 && "pr-20")}
                  placeholder="0x..."
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />

                {/* Bookmark Dropdown Button */}
                {bookmarks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setIsBookmarkDropdownOpen(!isBookmarkDropdownOpen)}
                    aria-expanded={isBookmarkDropdownOpen}
                    aria-controls={BOOKMARK_LIST_ID}
                    aria-haspopup="true"
                    aria-label={
                      isBookmarkDropdownOpen ? "Hide saved addresses" : "Show saved addresses"
                    }
                    className={cn(
                      "absolute right-1 top-1/2 flex h-10 -translate-y-1/2 items-center gap-1 rounded-md px-2",
                      "bg-primary text-xs text-primary-foreground transition-colors hover:bg-primary/90",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                  >
                    <Bookmark size={14} aria-hidden="true" />
                    <ChevronDown
                      size={14}
                      aria-hidden="true"
                      className={isBookmarkDropdownOpen ? "rotate-180" : ""}
                    />
                  </button>
                )}

                {/* Bookmark Dropdown List */}
                {isBookmarkDropdownOpen && bookmarks.length > 0 && (
                  <div
                    id={BOOKMARK_LIST_ID}
                    role="group"
                    aria-label="Saved addresses"
                    className={cn(
                      "absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto",
                      "rounded-lg border border-border bg-card shadow-glass-lg"
                    )}
                  >
                    {bookmarks.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => handleSelectBookmark(b.address)}
                        className={cn(
                          "flex w-full min-h-[44px] flex-col justify-center px-3 py-2 text-left text-sm",
                          "transition-colors hover:bg-secondary",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        )}
                      >
                        <span className="font-semibold text-foreground">{b.label}</span>
                        <span className="break-all font-mono text-xs text-muted-foreground">
                          {b.address}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Field>

          {isBookmarked && (
            <p className="flex items-center gap-1 text-xs text-success">
              <Check size={12} aria-hidden="true" />
              Bookmarked address
            </p>
          )}

          {recipientScreen.suspect && (
            <Alert tone="warning" title="Possible address poisoning">
              {`${describeSharedPattern(recipientScreen)} Check the full address character by character before sending.`}
            </Alert>
          )}
        </div>

        {/* Amount */}
        <Field
          label={`Amount (${currencySymbol})`}
          required
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSetMaxAmount}
              disabled={maxSpendable === null || maxSpendable === 0n}
              aria-label={`Use maximum available ${currencySymbol}`}
            >
              Max
            </Button>
          }
        >
          {(props) => (
            <input
              {...props}
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputClassName}
              placeholder="0.1"
              step="any"
            />
          )}
        </Field>

        {/* Amount slider: every position between dust and max is one gesture. */}
        {balance !== null && (
          <div className="pt-1">
            <input
              type="range"
              min={0}
              max={SLIDER_STEPS}
              step={1}
              value={sliderPos}
              onChange={(e) => handleSliderChange(Number(e.target.value))}
              disabled={sliderDisabled}
              aria-label={`Amount as a share of your spendable ${currencySymbol} balance`}
              className={cn(
                "h-6 w-full cursor-pointer accent-primary",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                sliderDisabled && "cursor-not-allowed opacity-50"
              )}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0</span>
              <span>
                {maxSpendable === null
                  ? "Balance unknown"
                  : `Max ${formatUnits(maxSpendable, nativeDecimals)} ${currencySymbol}`}
              </span>
            </div>
          </div>
        )}

        {/* Gas level selection */}
        <div className="space-y-2">
          <Tabs
            items={GAS_TIER_TABS}
            value={gasTier}
            onChange={setGasTier}
            label="Gas level"
            layoutGroupId="send-gas"
          />

          {gasNote !== null ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{gasNote}</p>
          ) : gasOverview !== null ? (
            <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <SlidersHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <p>
                {gasTier === "custom"
                  ? gasOverview.isEip1559
                    ? "Set your own priority and max fee."
                    : "Set your own gas price for this legacy market."
                  : gasTier === "low"
                    ? `~${formatUnit(gasOverview.slow, "gwei")} gwei`
                    : gasTier === "fast"
                      ? `~${formatUnit(gasOverview.fast, "gwei")} gwei`
                      : `~${formatUnit(gasOverview.standard, "gwei")} gwei`}
                {feeEstimateWei !== null && selectedPerGas !== null && gasTier !== "custom" && (
                  <>
                    {" "}· est. fee {formatUnits(feeEstimateWei, nativeDecimals)}{" "}
                    {currencySymbol}
                    {feeEstimateUsd !== null && ` (${formatFiat(feeEstimateUsd)})`}
                  </>
                )}
                {!gasOverview.isEip1559 && gasTier !== "custom" && " · legacy market"}
              </p>
            </div>
          ) : null}

          {showCustomInputs && gasOverview.isEip1559 && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Priority fee (gwei)" required>
                {(props) => (
                  <input
                    {...props}
                    type="number"
                    inputMode="decimal"
                    value={customPriorityGwei}
                    onChange={(e) => setCustomPriorityGwei(e.target.value)}
                    className={inputClassName}
                    placeholder="0.5"
                    step="any"
                    min="0"
                  />
                )}
              </Field>
              <Field label="Max fee (gwei)" required>
                {(props) => (
                  <input
                    {...props}
                    type="number"
                    inputMode="decimal"
                    value={customMaxFeeGwei}
                    onChange={(e) => setCustomMaxFeeGwei(e.target.value)}
                    className={inputClassName}
                    placeholder="2"
                    step="any"
                    min="0"
                  />
                )}
              </Field>
            </div>
          )}

          {showCustomInputs && !gasOverview.isEip1559 && (
            <Field label="Gas price (gwei)" required>
              {(props) => (
                <input
                  {...props}
                  type="number"
                  inputMode="decimal"
                  value={customGasPriceGwei}
                  onChange={(e) => setCustomGasPriceGwei(e.target.value)}
                  className={inputClassName}
                  placeholder="10"
                  step="any"
                  min="0"
                />
              )}
            </Field>
          )}

          {customFeeError !== null && <Alert tone="warning">{customFeeError}</Alert>}
        </div>

        {/* Summary */}
        {(recipient !== "" || amount !== "") && (
          <Card variant="inset" padding="sm">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">Network</dt>
                <dd className="text-right font-medium">{networkInfo?.name ?? network}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">To</dt>
                <dd className="min-w-0 break-all text-right font-mono text-xs">
                  {recipient || "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-border/60 pt-2">
                <dt className="shrink-0 text-muted-foreground">Amount</dt>
                <dd className="text-right font-mono font-semibold">
                  {amount || "—"} {currencySymbol}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">Network fee</dt>
                <dd className="text-right font-mono">
                  {feeEstimateWei !== null
                    ? `${formatUnits(feeEstimateWei, nativeDecimals)} ${currencySymbol}${
                        feeEstimateUsd !== null ? ` (${formatFiat(feeEstimateUsd)})` : ""
                      }`
                    : gasOverview === null
                      ? "Set by the node at send time"
                      : "Enter a fee to see the estimate"}
                </dd>
              </div>
            </dl>
          </Card>
        )}

        {error && <Alert tone="danger">{error}</Alert>}
      </ResponsiveDialog>

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
