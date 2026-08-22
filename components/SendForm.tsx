"use client"

import { useState } from "react"
import { Send, Bookmark, ChevronDown, Check } from "lucide-react"
import { Wallet, formatUnits, isAddress, type TransactionRequest } from "ethers"
import {
  RpcError,
  getAllNetworks,
  getNativeDecimals,
  withProvider,
  withProviderOnce,
  type Network,
} from "@/lib/ethers"
import { saveTransaction, updateTransactionStatus } from "@/lib/transactionHistory"
import { getBookmarksByNetwork, isAddressBookmarked } from "@/lib/bookmarks"
import { parseAmount } from "@/lib/format"
import { describeError, logger } from "@/lib/logger"
import BookmarkManager from "./BookmarkManager"
import ResponsiveDialog from "./ui/ResponsiveDialog"
import Card from "./ui/Card"
import Button from "./ui/Button"
import Field, { inputClassName, monoInputClassName } from "./ui/Field"
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
  // Not every chain uses 18 decimals; assuming so would misprice a transfer.
  const nativeDecimals = getNativeDecimals(network)

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
      // Fee data, balance, and gas estimate are all idempotent reads, so they go
      // through the pooled path and inherit retry plus failover.
      const { balance, gasCost } = await withProvider(network, async (provider) => {
        const [feeData, currentBalance] = await Promise.all([
          provider.getFeeData(),
          provider.getBalance(wallet.address),
        ])

        const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice
        if (gasPrice === null) throw new Error("no-gas-price")

        let gasLimit = 21_000n
        try {
          const estimated = await provider.estimateGas({
            to: recipient !== "" && isAddress(recipient) ? recipient : wallet.address,
            value: 1n,
          })
          gasLimit = (estimated * 120n) / 100n
        } catch {
          // A plain transfer is 21000; the estimate only matters for contracts.
          gasLimit = 21_000n
        }

        return { balance: currentBalance, gasCost: gasLimit * gasPrice }
      })

      // Reserve a further margin because the base fee can rise between this
      // estimate and the send, and because OP-stack chains add an L1 data fee
      // that gasLimit * gasPrice does not include. Without it, "Max" reliably
      // fails for insufficient funds on those networks.
      const reserve = gasCost + gasCost / 2n

      if (balance <= reserve) {
        setAmount("")
        setError(
          `Balance does not cover the network fee. You need at least ${formatUnits(reserve, nativeDecimals)} ${currencySymbol}.`
        )
        return
      }

      setAmount(formatUnits(balance - reserve, nativeDecimals))
    } catch (error) {
      logger.warn("Max amount calculation failed", { network, error })
      setError(
        error instanceof RpcError
          ? error.userMessage
          : describeError(error, "Could not calculate the maximum amount.")
      )
    } finally {
      setIsCalculatingMax(false)
    }
  }

  const handleSend = async () => {
    setError("")

    if (!isAddress(recipient)) {
      setError("Enter a valid recipient address.")
      return
    }

    // Validate through the shared bigint-exact parser rather than parseFloat.
    // `Number.parseFloat("abc") <= 0` is false, so the previous check let garbage
    // through to fail later inside parseUnits with an opaque message.
    const parsedAmount = parseAmount(amount, nativeDecimals)
    if (!parsedAmount.ok) {
      setError(parsedAmount.error)
      return
    }

    setIsSending(true)
    let broadcastHash = ""

    try {
      // Estimate against the real recipient and value, not a placeholder.
      const request: TransactionRequest = { to: recipient, value: parsedAmount.value }

      try {
        const estimated = await withProvider(network, (provider) =>
          provider.estimateGas(request)
        )
        request.gasLimit = (estimated * 120n) / 100n
      } catch (error) {
        // A failed estimate usually means the transaction would revert. Surface
        // it rather than broadcasting blind and burning the fee.
        logger.warn("Gas estimation failed", { network, error })
        setError(
          error instanceof RpcError
            ? error.userMessage
            : "This transaction is expected to fail, so it was not sent. Check the recipient and amount."
        )
        setIsSending(false)
        return
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
      // unknown as success — as this code previously did — tells the user their
      // funds moved when they may not have.
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
    } catch (error) {
      logger.error("Send failed", { network, error })
      setError(
        error instanceof RpcError
          ? error.userMessage
          : describeError(error, "The transaction could not be sent.")
      )

      // Only record a failure that actually reached the network. A pre-broadcast
      // failure has no hash, and the old synthetic `failed-<timestamp>` value was
      // not a valid hash yet was still rendered as an explorer link.
      if (broadcastHash !== "") {
        updateTransactionStatus(broadcastHash, "failed")
      }
    } finally {
      setIsSending(false)
    }
  }

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
            disabled={isSending || !recipient || !amount}
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
              isLoading={isCalculatingMax}
              loadingLabel="Calculating…"
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

        {/* Summary. Every value here is already in state, so this costs no extra
            RPC call; the gas figure is deliberately absent because the estimate
            is only made at send time. */}
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
            </dl>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              The network fee is estimated when you send and is charged on top of this amount.
            </p>
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
