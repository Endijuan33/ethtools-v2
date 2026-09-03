"use client"

/**
 * Sweep card: move EVERY asset of one account on ONE network to one address.
 *
 * What a sweep is, honestly:
 * - Every tracked ERC-20 (via the token manager's storage for the selected
 *   network) with a non-zero balance is transferred in full.
 * - The native balance is sent LAST and minus a gas reserve, so the token
 *   transfers — which all burn native gas — can never be left unfunded.
 *
 * Security posture: the private key arrives as a prop from the unlocked vault
 * and is used only to sign, locally, exactly like `components/SendForm.tsx`.
 * It is never rendered, persisted, or echoed in an error. Address-poisoning
 * screening is deliberately absent here: the send dialog owns that warning
 * surface, and a second, divergent implementation would only drift.
 *
 * Execution mirrors SendForm's broadcast-once pattern per transfer: estimate →
 * sign → send exactly once (no failover — an ambiguous retry could double-send)
 * → save history → wait for the receipt → update the status. Transfers run
 * SEQUENTIALLY; the first failure stops the queue and every remaining transfer
 * is reported as "not attempted" rather than optimistically tried.
 *
 * All ordering and amount math lives in the pure planner (`lib/sweep.ts`); this
 * component fetches inputs, renders the plan, and executes it.
 */

import { useCallback, useMemo, useState } from "react"
import { ArrowRightLeft, Coins, Send, Wallet as WalletIcon } from "lucide-react"
import { Interface, Wallet as EthersWallet, isAddress, type TransactionRequest } from "ethers"
import Card, { CardDescription, CardHeader, CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Badge from "./ui/Badge"
import Field, { inputClassName, monoInputClassName } from "./ui/Field"
import Alert from "./ui/Alert"
import { EmptyState } from "./ui/Feedback"
import { confirmAction, notify } from "./ui/Toast"
import {
  NETWORKS,
  RpcError,
  getBalanceWei,
  getNativeDecimals,
  getTokenBalanceRaw,
  withProvider,
  withProviderOnce,
  type Network,
} from "@/lib/ethers"
import { saveTransaction, updateTransactionStatus } from "@/lib/transactionHistory"
import { formatBalanceForDisplay, truncateHex } from "@/lib/format"
import { describeError, logger } from "@/lib/logger"
import { readJson, STORAGE_KEYS } from "@/lib/storage"
import {
  filterValid,
  isChecksummedAddress,
  isStoredToken,
  type StoredToken,
} from "@/lib/schema"
import { MAX_SWEEP_TOKENS, planSweep, type PlannedTransfer, type SweepPlan } from "@/lib/sweep"

export interface SweepCardProps {
  /**
   * The vault account to sweep. The private key crosses this boundary only to
   * reach the local signer — it is never displayed or transmitted, and no
   * error ever echoes it.
   */
  account: { address: string; privateKey: string }
}

/**
 * The curated network list, mirroring the portfolio's: sweeping fans out one
 * balance read plus N token reads, so the list stays to the major mainnets
 * instead of the full table. The card owns the choice because a sweep is
 * per-network by definition.
 */
const SWEEP_NETWORKS = [
  "mainnet",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "bsc",
  "avalanche",
] as const

/** Card-wide phases; one card, no wizard. */
type Phase = "form" | "preparing" | "review" | "executing" | "done"

/** Per-transfer outcome, kept honest: "pending" means broadcast but unconfirmed. */
type Outcome = "queued" | "sending" | "sent" | "pending" | "failed" | "not-attempted"

/** One row of the review/result list. */
interface TransferRow {
  key: string
  label: string
  amount: string
  estimatedFee: string
  outcome: Outcome
  hash?: string
  note?: string
}

/** ERC-20 transfer encoding; the planner's amounts are exact base units. */
const ERC20 = new Interface(["function transfer(address to, uint256 amount) returns (bool)"])

/** Fallback gas limit when a plan-time token estimate cannot run. */
const TOKEN_TRANSFER_GAS_FALLBACK = 65_000n

/** Gas-limit headroom over the node estimate, matching SendForm's 120%. */
const GAS_HEADROOM_PERCENT = 120n

/** Padded gas limit for a transfer, mirroring the send form's margin. */
function padGasLimit(estimated: bigint): bigint {
  return (estimated * GAS_HEADROOM_PERCENT) / 100n
}

/** Encode an ERC-20 transfer of an exact base-unit amount. */
function encodeTransfer(to: string, amount: bigint): string {
  return ERC20.encodeFunctionData("transfer", [to, amount])
}

/**
 * Read the tracked tokens for one network.
 *
 * Duplicated from `components/TokenManager.tsx` (which owns writes) because a
 * sweep must READ the same list the user manages there, and the reader there is
 * module-private. Validated through the schema guard like every storage read.
 */
function readTrackedTokens(network: Network): StoredToken[] {
  const all = filterValid(
    readJson<unknown>(STORAGE_KEYS.TOKENS, (value): value is unknown => true, []),
    isStoredToken,
    MAX_SWEEP_TOKENS
  )
  return all.filter((token) => token.network === network)
}

export default function SweepCard({ account }: SweepCardProps) {
  const [network, setNetwork] = useState<Network>(SWEEP_NETWORKS[0])
  const [destination, setDestination] = useState("")
  const [phase, setPhase] = useState<Phase>("form")
  const [plan, setPlan] = useState<SweepPlan | null>(null)
  const [rows, setRows] = useState<TransferRow[]>([])
  const [error, setError] = useState("")

  const networkInfo = NETWORKS[network]
  const nativeSymbol = networkInfo?.currency ?? "ETH"
  const nativeDecimals = getNativeDecimals(network)

  /*
   * Live destination validation, mirroring the watch-address form: the hint is
   * convenience, the address is re-validated and normalized by the pure planner
   * before anything is sent. No poisoning screen here by design — the send
   * dialog owns that warning surface.
   */
  const destinationTrimmed = destination.trim()
  const destinationValid = isAddress(destinationTrimmed)
  const destinationHint =
    destinationValid && !isChecksummedAddress(destinationTrimmed)
      ? "Valid address. It will be used in EIP-55 checksum form."
      : undefined

  /** Fee display for a review row; "—" when the node offered no fee data. */
  const feeLabel = useCallback(
    (feeWei: bigint | null): string =>
      feeWei === null ? "—" : `${formatBalanceForDisplay(feeWei, nativeDecimals)} ${nativeSymbol}`,
    [nativeDecimals, nativeSymbol]
  )

  // ===== Prepare =====

  /**
   * Fetch balances and estimates, then hand everything to the pure planner.
   *
   * All reads are idempotent and go through the pooled (retryable) path. A
   * failed token read or estimate degrades honestly: the token is still
   * planned with a standard transfer gas fallback, and the send-time estimate
   * is what finally decides whether a transfer can run.
   */
  const handlePrepare = useCallback(async () => {
    setError("")
    setPhase("preparing")
    try {
      // Validated by the field; the planner normalizes and re-validates it.
      const destinationAddress = destinationTrimmed
      const tracked = readTrackedTokens(network).slice(0, MAX_SWEEP_TOKENS)

      const [nativeBalance, feeData] = await Promise.all([
        getBalanceWei(account.address, network),
        withProvider(network, (provider) => provider.getFeeData()),
      ])
      // Node-suggested price per gas unit. No tier UI here by design: the
      // sweep uses whatever the node suggests at send time.
      const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? null

      let nativeGasLimit = 21_000n
      try {
        const estimated = await withProvider(network, (provider) =>
          provider.estimateGas({ from: account.address, to: destinationAddress, value: 1n })
        )
        nativeGasLimit = padGasLimit(estimated)
      } catch (cause) {
        logger.warn("Sweep native gas estimate failed; using the plain-transfer limit", {
          network,
          error: cause,
        })
      }

      const tokens = []
      for (const token of tracked) {
        const { value, decimals } = await getTokenBalanceRaw(
          token.address,
          account.address,
          network
        )
        if (value <= 0n) continue

        let gasLimit = TOKEN_TRANSFER_GAS_FALLBACK
        try {
          const estimated = await withProvider(network, (provider) =>
            provider.estimateGas({
              from: account.address,
              to: token.address,
              data: encodeTransfer(destinationAddress, value),
            })
          )
          gasLimit = padGasLimit(estimated)
        } catch (cause) {
          // Estimate failure is not fatal at plan time: the send-time estimate
          // surfaces a genuine revert before anything is broadcast.
          logger.warn("Sweep token gas estimate failed; using the standard transfer limit", {
            network,
            token: token.symbol,
            error: cause,
          })
        }

        tokens.push({
          contractAddress: token.address,
          symbol: token.symbol,
          decimals,
          balance: value,
          gasLimit,
        })
      }

      const planned = planSweep({
        from: account.address,
        destination: destinationAddress,
        nativeBalance,
        nativeDecimals,
        nativeSymbol,
        nativeGasLimit,
        tokens,
        feePerGas,
      })
      if (!planned.ok) {
        setError(planned.error)
        setPhase("form")
        return
      }

      setPlan(planned.value)
      setRows(
        planned.value.transfers.map((transfer) => ({
          key: transfer.kind === "native" ? "native" : transfer.to.toLowerCase(),
          label:
            transfer.kind === "native"
              ? `${transfer.symbol} (native)`
              : `${transfer.symbol}`,
          amount: formatBalanceForDisplay(transfer.amount, transfer.decimals),
          estimatedFee: feeLabel(transfer.estimatedFeeWei),
          outcome: "queued",
        }))
      )
      setPhase("review")
    } catch (cause) {
      logger.warn("Sweep preparation failed", { network, error: cause })
      setError(
        cause instanceof RpcError
          ? cause.userMessage
          : describeError(cause, "Could not prepare the sweep. Try again.")
      )
      setPhase("form")
    }
  }, [
    account.address,
    destinationTrimmed,
    feeLabel,
    nativeDecimals,
    nativeSymbol,
    network,
  ])

  // ===== Execute =====

  /**
   * The native amount, recomputed at execution time rather than reused from
   * the plan: by the time this leg runs, the token transfers have already
   * spent real gas, and the fresh balance/fee pair is the only honest input.
   *
   * @returns The amount to send, 0n when the balance only covers gas, or null
   *   when the fee could not be determined (the leg is then not attempted).
   */
  const freshNativeAmount = useCallback(async (): Promise<bigint | null> => {
    if (!plan) return null
    try {
      const [balance, feeData] = await Promise.all([
        getBalanceWei(account.address, network),
        withProvider(network, (provider) => provider.getFeeData()),
      ])
      const perGas = feeData.maxFeePerGas ?? feeData.gasPrice
      if (perGas === null || perGas <= 0n) return null

      let gasLimit = 21_000n
      try {
        const estimated = await withProvider(network, (provider) =>
          provider.estimateGas({ from: account.address, to: plan.destination, value: 1n })
        )
        gasLimit = padGasLimit(estimated)
      } catch {
        // Plain-transfer limit; the send-time estimate decides finally.
      }

      // Only this transfer's gas is still ahead of us — the token legs are done.
      const fee = gasLimit * perGas
      const reserve = fee + fee / 2n
      return balance > reserve ? balance - reserve : 0n
    } catch (cause) {
      logger.warn("Sweep native amount recomputation failed", { network, error: cause })
      return null
    }
  }, [account.address, network, plan])

  /**
   * Execute ONE transfer, SendForm's broadcast-once pattern verbatim:
   * estimate → sign → send exactly once → save history → wait receipt →
   * update status. Never retries: an ambiguous timeout retry could submit the
   * same transaction twice.
   */
  const executeTransfer = useCallback(
    async (
      transfer: PlannedTransfer
    ): Promise<{ outcome: "sent" | "pending" | "failed" | "not-attempted"; hash?: string; note?: string }> => {
      if (!plan) return { outcome: "failed", note: "The plan is no longer available." }

      const request: TransactionRequest = { from: account.address }
      // Captured so the history record shows the exact value that was sent.
      let nativeAmountSent = 0n

      if (transfer.kind === "token") {
        request.to = transfer.to
        request.data = encodeTransfer(plan.destination, transfer.amount)
      } else {
        // Recomputed above the estimate so the estimate covers the real value.
        const amount = await freshNativeAmount()
        if (amount === null) {
          return {
            outcome: "not-attempted",
            note: "The fee could not be determined, so the remaining balance was left in place.",
          }
        }
        if (amount === 0n) {
          return {
            outcome: "not-attempted",
            note: "The remaining balance only covers gas, so nothing was sent.",
          }
        }
        request.to = plan.destination
        request.value = amount
        nativeAmountSent = amount
      }

      try {
        const estimated = await withProvider(network, (provider) =>
          provider.estimateGas(request)
        )
        request.gasLimit = padGasLimit(estimated)
      } catch (cause) {
        // A failed estimate usually means the transaction would revert. Surface
        // it rather than broadcasting blind and burning the fee.
        logger.warn("Sweep gas estimation failed", { network, error: cause })
        return {
          outcome: "failed",
          note:
            cause instanceof RpcError
              ? cause.userMessage
              : "This transfer is expected to fail, so it was not sent.",
        }
      }

      let hash: string
      try {
        // Broadcast exactly once. Retrying an ambiguous timeout could submit
        // the same transaction twice, so this deliberately does not fail over.
        const response = await withProviderOnce(network, async (provider) => {
          const signer = new EthersWallet(account.privateKey, provider)
          return signer.sendTransaction(request)
        })
        hash = response.hash

        const amountLabel =
          transfer.kind === "native"
            ? formatBalanceForDisplay(nativeAmountSent, nativeDecimals)
            : formatBalanceForDisplay(transfer.amount, transfer.decimals)

        const saved = saveTransaction({
          hash,
          network,
          from: account.address,
          to: plan.destination,
          amount: amountLabel,
          currency: transfer.symbol,
          status: "pending",
        })
        if (!saved.ok) {
          // The transaction is already on the network; only the record failed.
          notify.warning("Transaction sent, but history could not be saved", saved.error)
        }

        // Resolve the real outcome. "Success" only when a receipt confirms
        // status 1; anything else is genuinely unknown.
        try {
          const receipt = await response.wait(1)
          if (receipt === null) {
            updateTransactionStatus(hash, "unknown")
            return { outcome: "pending", hash, note: "Broadcast, but no receipt was returned." }
          }
          if (receipt.status === 1) {
            updateTransactionStatus(hash, "success")
            return { outcome: "sent", hash }
          }
          updateTransactionStatus(hash, "failed")
          return { outcome: "failed", hash, note: "Reverted on-chain. The fee was still spent." }
        } catch (confirmError) {
          logger.warn("Sweep confirmation wait failed", { network, error: confirmError })
          updateTransactionStatus(hash, "unknown")
          return {
            outcome: "pending",
            hash,
            note: "Broadcast, but its final status could not be confirmed.",
          }
        }
      } catch (sendError) {
        logger.error("Sweep transfer failed", { network, error: sendError })
        return {
          outcome: "failed",
          note:
            sendError instanceof RpcError
              ? sendError.userMessage
              : describeError(sendError, "The transaction could not be sent."),
        }
      }
    },
    [account.address, account.privateKey, freshNativeAmount, nativeDecimals, network, plan]
  )

  /** Update one row without disturbing the others. */
  const patchRow = useCallback((key: string, patch: Partial<TransferRow>): void => {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row))
    )
  }, [])

  /**
   * Confirm, then run the plan sequentially. The FIRST transfer that does not
   * fully succeed stops the queue: after a failure (or an unconfirmed
   * broadcast) the on-chain state is unknown, and continuing would risk
   * compounding it. Remaining legs are reported as "not attempted".
   */
  const handleConfirm = useCallback(async () => {
    if (!plan || plan.transfers.length === 0) return

    const totalFeeLabel =
      plan.totalEstimatedFeeWei === null
        ? "unknown (node-suggested at send time)"
        : `${formatBalanceForDisplay(plan.totalEstimatedFeeWei, nativeDecimals)} ${nativeSymbol}`

    const confirmed = await confirmAction({
      message: "Sweep all funds?",
      description: `Send ${plan.transfers.length} transfer(s) to ${plan.destination} on ${networkInfo?.name ?? network}. Estimated gas: ${totalFeeLabel}. Token transfers go first; the native balance is sent last minus a gas reserve.`,
      confirmLabel: "Sweep",
    })
    if (!confirmed) return

    setPhase("executing")
    let stop = false
    let sentCount = 0

    for (const transfer of plan.transfers) {
      const key = transfer.kind === "native" ? "native" : transfer.to.toLowerCase()
      if (stop) {
        patchRow(key, {
          outcome: "not-attempted",
          note: "Stopped because an earlier transfer did not complete.",
        })
        continue
      }

      patchRow(key, { outcome: "sending" })
      const result = await executeTransfer(transfer)
      patchRow(key, { outcome: result.outcome, hash: result.hash, note: result.note })
      if (result.outcome === "sent") sentCount += 1
      if (result.outcome !== "sent") stop = true
    }

    setPhase("done")
    if (stop) {
      notify.warning(
        "Sweep stopped early",
        "One transfer did not fully succeed, so the remaining transfers were not attempted. Review the results below."
      )
    } else {
      notify.success(
        "Sweep complete",
        `${sentCount} transfer(s) sent to ${truncateHex(plan.destination, 10, 8)}.`
      )
    }
  }, [
    executeTransfer,
    nativeDecimals,
    nativeSymbol,
    network,
    networkInfo?.name,
    patchRow,
    plan,
  ])

  /** Back to the form, keeping the destination for a retry. */
  const reset = useCallback(() => {
    setPhase("form")
    setPlan(null)
    setRows([])
    setError("")
  }, [])

  const canPrepare = destinationValid && phase === "form"
  const nothingToSweep = plan !== null && plan.transfers.length === 0

  const rowBadge = (row: TransferRow): React.ReactNode => {
    switch (row.outcome) {
      case "queued":
        return <Badge tone="neutral">Queued</Badge>
      case "sending":
        return (
          <Badge tone="info" dot pulse>
            Sending…
          </Badge>
        )
      case "sent":
        return (
          <Badge tone="success" dot>
            Sent
          </Badge>
        )
      case "pending":
        return (
          <Badge tone="warning" dot>
            Pending
          </Badge>
        )
      case "failed":
        return <Badge tone="danger">Failed</Badge>
      default:
        return <Badge tone="neutral">Not attempted</Badge>
    }
  }

  const totals = useMemo(() => {
    if (!plan) return null
    return {
      gas: `${formatBalanceForDisplay(plan.totalGasLimit, 0)} gas units`,
      fee:
        plan.totalEstimatedFeeWei === null
          ? null
          : formatBalanceForDisplay(plan.totalEstimatedFeeWei, nativeDecimals),
    }
  }, [plan, nativeDecimals])

  return (
    <Card variant="inset" padding="sm" as="section" aria-label="Sweep funds">
      <CardHeader className="mb-3">
        <div>
          <CardTitle as="h3" className="text-base">
            Sweep funds
          </CardTitle>
          <CardDescription>
            Move every asset of this account on one network to one address. Tokens first, native
            balance last minus a gas reserve.
          </CardDescription>
        </div>
        <ArrowRightLeft className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </CardHeader>

      {error !== "" && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}

      {phase === "form" || phase === "preparing" ? (
        <div className="space-y-3">
          <Field label="Network" required>
            {(props) => (
              <select
                {...props}
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
                className={inputClassName}
              >
                {SWEEP_NETWORKS.map((key) => (
                  <option key={key} value={key}>
                    {NETWORKS[key]?.name ?? key}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field
            label="Destination address"
            required
            hint={destinationHint ?? "Everything on the selected network will be sent here."}
            action={
              destinationValid ? (
                <Badge tone="success">
                  {isChecksummedAddress(destinationTrimmed) ? "Checksummed" : "Valid"}
                </Badge>
              ) : undefined
            }
          >
            {(props) => (
              <input
                {...props}
                type="text"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="0x..."
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className={monoInputClassName}
              />
            )}
          </Field>

          <Button
            onClick={() => void handlePrepare()}
            isLoading={phase === "preparing"}
            loadingLabel="Preparing…"
            disabled={!canPrepare}
            fullWidth
            icon={<Coins className="h-4 w-4" aria-hidden="true" />}
          >
            Prepare sweep
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {nothingToSweep ? (
            <EmptyState
              icon={<WalletIcon className="h-5 w-5" />}
              title="Nothing to sweep"
              description={`This account holds no tracked tokens with a balance on ${
                networkInfo?.name ?? network
              }, and its ${
                plan?.nativeAmount === 0n ? "native balance is zero or only covers gas" : "native balance is zero"
              }.`}
            />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Sweeping <span className="font-mono">{plan?.destination}</span> on{" "}
                {networkInfo?.name ?? network}
                {totals?.fee !== null && totals !== null && (
                  <>
                    {" "}
                    · estimated gas{" "}
                    <span className="font-medium text-foreground">
                      {totals.fee} {nativeSymbol}
                    </span>
                  </>
                )}
                .
              </p>

              <ul className="space-y-2" aria-label="Planned transfers">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className="rounded-md border border-border bg-background/40 p-2.5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-medium text-foreground">
                        {row.label}
                      </span>
                      {rowBadge(row)}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 font-mono text-xs text-muted-foreground">
                      <span>{row.amount}</span>
                      <span>est. fee {row.estimatedFee}</span>
                    </div>
                    {row.note && <p className="mt-1 text-xs text-muted-foreground">{row.note}</p>}
                    {row.hash && (
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {row.hash}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Live region: sequential execution is slow (one receipt per
              transfer), so progress must be announced, not just visible. */}
          <div role="status" aria-live="polite" className="sr-only">
            {phase === "executing"
              ? rows.map((row) => `${row.label}: ${row.outcome}`).join(", ")
              : ""}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            {phase === "review" && (
              <Button
                variant="secondary"
                onClick={reset}
                disabled={nothingToSweep}
                fullWidth
              >
                Cancel
              </Button>
            )}
            {phase === "review" && (
              <Button
                variant="success"
                onClick={() => void handleConfirm()}
                disabled={nothingToSweep}
                fullWidth
                icon={<Send className="h-4 w-4" aria-hidden="true" />}
              >
                Confirm sweep
              </Button>
            )}
            {phase === "done" && (
              <Button variant="outline" onClick={reset} fullWidth>
                Sweep again
              </Button>
            )}
          </div>

          {phase === "done" && (
            <Alert tone="info" title="Sweep finished.">
              Each row above shows its own outcome and transaction hash. A &quot;pending&quot; row
              was broadcast but could not be confirmed here — check the explorer via its hash
              before retrying it.
            </Alert>
          )}
        </div>
      )}
    </Card>
  )
}
