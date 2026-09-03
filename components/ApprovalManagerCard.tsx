"use client"

/**
 * Allowance manager card for the unlocked vault view.
 *
 * Shows who the active account has approved to spend its ERC-20 tokens, and
 * offers a one-click revoke. The data model behind the rows is deliberate:
 *
 * - **Discovery is historical, allowances are live.** Approval event logs say
 *   who was *ever* approved; the displayed number for every row comes from a
 *   live `allowance()` call, so an approval that was spent down or revoked
 *   never shows a phantom balance. Rows whose current allowance is zero are
 *   not shown at all — they are history, not risk.
 * - **The scan is an explicit action.** The address is sent to public explorer
 *   APIs, which is the same trust level as every balance read in this app but
 *   is stated plainly next to the button. No auto-fetch on mount, no polling.
 * - **Watch-only accounts see everything except the revoke button**, with the
 *   honest reason: revoking requires a signature, and a signature requires the
 *   private key a watch-only account does not have.
 * - **Revoking mirrors SendForm's ceremony exactly** — confirm dialog, gas
 *   estimate (a revert aborts before any fee is spent), local signing,
 *   broadcast exactly once, history record, real receipt status — because a
 *   revoke is a transaction with exactly the same failure modes as a send.
 *
 * The key lives only in the parent's unlocked vault state for the duration of
 * the ceremony: it is passed to `revokeApproval` and never rendered, stored,
 * or logged.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Ban, ChevronDown, ExternalLink, Eye, RefreshCw, Search, ShieldCheck } from "lucide-react"
import Card, { CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Badge from "./ui/Badge"
import Alert from "./ui/Alert"
import CopyButton from "./ui/CopyButton"
import ResponsiveDialog from "./ui/ResponsiveDialog"
import { EmptyState, ErrorState } from "./ui/Feedback"
import { notify } from "./ui/Toast"
import {
  estimateAllowanceUsd,
  revokeApproval,
  scanApprovalsAcrossNetworks,
  type ActiveApproval,
  type ApprovalScanSnapshot,
} from "@/lib/approvals"
import { EXPLORER_APIS } from "@/lib/tokenDetection"
import { NETWORKS, getRoutescanUrl } from "@/lib/ethers"
import { formatBalanceForDisplay, formatFiat, formatRelativeTime, truncateHex } from "@/lib/format"
import { cn } from "@/lib/utils"

export interface ApprovalManagerCardProps {
  /** Account whose approvals are scanned. Public data on its own. */
  address: string
  /**
   * Private key of the account, present only for key-holding accounts. It is
   * used solely to sign a revoke when the user confirms one, never for the
   * scan itself.
   */
  privateKey?: string
  /** True for watch-only accounts: everything renders except the revoke. */
  watchOnly?: boolean
}

/** "1 network" / "3 networks" — the summary lines pluralize counts constantly. */
function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** Prefix for foldable-section ids, unique within this card. */
const SECTION_ID_PREFIX = "approval-manager-section"

/** Stable row identity: one row per (network, token, spender). */
function approvalRowKey(approval: ActiveApproval): string {
  return `${approval.networkKey}:${approval.token.toLowerCase()}:${approval.spender.toLowerCase()}`
}

export default function ApprovalManagerCard({
  address,
  privateKey,
  watchOnly = false,
}: ApprovalManagerCardProps) {
  const [snapshot, setSnapshot] = useState<ApprovalScanSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** The approval awaiting confirmation in the dialog, if any. */
  const [pendingRevoke, setPendingRevoke] = useState<ActiveApproval | null>(null)
  /** Row key of the in-flight revoke ceremony; null when idle. */
  const [revoking, setRevoking] = useState<string | null>(null)
  /** Last revoke failure, surfaced as an Alert rather than a toast-only error. */
  const [revokeError, setRevokeError] = useState("")

  // One controller per in-flight scan, superseded by the next one.
  const abortRef = useRef<AbortController | null>(null)

  const networkCount = Object.keys(EXPLORER_APIS).length
  const canRevoke = !watchOnly && typeof privateKey === "string" && privateKey !== ""
  const revokeUnavailableReason = watchOnly
    ? "This is a watch-only account: revoking needs its private key, which is not stored."
    : "Revoking needs this account's private key, which is not available right now."

  const scan = useCallback(async () => {
    // Supersede any in-flight scan: its results belong to a request the user
    // has already moved past, and letting it finish would only hold a socket.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setBusy(true)
    setError("")
    try {
      const result = await scanApprovalsAcrossNetworks(address, controller.signal)
      // `fetch` cannot un-send a request, so an aborted call can still resolve;
      // never let it land results for a superseded scan.
      if (controller.signal.aborted) return
      if (result.ok) {
        setSnapshot(result.value)
        // Fresh results: every section returns to its collapsed default.
        setExpanded({})
      } else {
        // A failed refresh does not blank the card: the previous results stay
        // and the error is presented next to them.
        setError(result.error)
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [address])

  /**
   * Reset state when the address changes and abort any in-flight scan.
   *
   * Approvals belong to an address; results from the previous account must not
   * survive into the next one's view. The parent keys this card by address, so
   * this is belt-and-braces rather than the primary reset.
   */
  useEffect(() => {
    setSnapshot(null)
    setError("")
    setExpanded({})
    setPendingRevoke(null)
    setRevokeError("")
    return () => {
      abortRef.current?.abort()
    }
  }, [address])

  /** Fold or unfold one network's section. */
  const toggleSection = useCallback((networkKey: string): void => {
    setExpanded((previous) => ({ ...previous, [networkKey]: !previous[networkKey] }))
  }, [])

  /** Drop one revoked approval from the snapshot; it is no longer active. */
  const removeApproval = useCallback((approval: ActiveApproval): void => {
    const token = approval.token.toLowerCase()
    const spender = approval.spender.toLowerCase()
    setSnapshot((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            networks: previous.networks.map((network) =>
              network.networkKey === approval.networkKey
                ? {
                    ...network,
                    approvals: network.approvals.filter(
                      (candidate) =>
                        candidate.token.toLowerCase() !== token ||
                        candidate.spender.toLowerCase() !== spender
                    ),
                  }
                : network
            ),
          }
    )
  }, [])

  /**
   * Run the confirmed revoke: close the dialog, show the ceremony on the row,
   * and surface every outcome honestly — success removes the row, a revert or
   * an unknown status keeps it with an explanation.
   */
  const handleConfirmRevoke = useCallback(async (): Promise<void> => {
    const approval = pendingRevoke
    if (approval === null || privateKey === undefined || privateKey === "" || revoking !== null) {
      return
    }

    setPendingRevoke(null)
    setRevoking(approvalRowKey(approval))
    setRevokeError("")

    const tokenShort = approval.tokenSymbol ?? truncateHex(approval.token, 6, 4)
    const spenderShort = truncateHex(approval.spender, 6, 4)
    const currency = NETWORKS[approval.networkKey]?.currency ?? "ETH"

    try {
      const result = await revokeApproval(
        approval.networkKey,
        { address, privateKey },
        approval.token,
        approval.spender,
        currency
      )

      if (!result.ok) {
        setRevokeError(result.error)
        notify.error("Could not revoke the approval", result.error)
        return
      }
      if (result.historyWarning !== undefined) {
        notify.warning("Transaction sent, but history could not be saved", result.historyWarning)
      }

      if (result.status === "success") {
        notify.success("Approval revoked", `${spenderShort} can no longer spend ${tokenShort}.`)
        removeApproval(approval)
        return
      }
      if (result.status === "failed") {
        setRevokeError(
          "The revoke transaction was reverted on-chain. The allowance is unchanged; the fee was spent."
        )
        notify.error("Transaction reverted", "The network rejected it. The fee was still spent.")
        return
      }
      setRevokeError(
        "The revoke was broadcast but its status could not be confirmed. Check the explorer before retrying."
      )
      notify.warning(
        "Transaction status unknown",
        "It was broadcast successfully. Check the explorer for its final status."
      )
    } finally {
      setRevoking(null)
    }
  }, [address, pendingRevoke, privateKey, removeApproval, revoking])

  const totalActive =
    snapshot?.networks.reduce((count, network) => count + network.approvals.length, 0) ?? 0
  const networksWithActive =
    snapshot?.networks.filter((network) => network.approvals.length > 0).length ?? 0
  const anyTruncated = snapshot?.networks.some((network) => network.truncated) ?? false

  /**
   * Text for the live region, mirroring what sighted users see.
   *
   * The region is always mounted and only its text changes: a live region that
   * first appears alongside its content is ignored by several screen readers.
   */
  const liveStatus = (() => {
    if (busy) {
      return `Scanning ${countLabel(networkCount, "network")} for approvals.`
    }
    if (snapshot === null) {
      return error !== ""
        ? `Approval scan failed. ${error}`
        : `Approval scanning can cover ${countLabel(networkCount, "network")}.`
    }
    const parts = [
      `Found ${countLabel(totalActive, "active approval")} across ${countLabel(networksWithActive, "network")}.`,
    ]
    if (snapshot.failures.length > 0) {
      parts.push(`${countLabel(snapshot.failures.length, "network")} could not be scanned.`)
    }
    if (anyTruncated) {
      parts.push("Some results may be incomplete.")
    }
    if (error !== "") {
      parts.push("Last scan failed; the results shown may be stale.")
    }
    return parts.join(" ")
  })()

  const scanButton = (
    <Button
      onClick={() => void scan()}
      // One ceremony at a time: a rescan mid-revoke would drop the row the
      // transaction is about to update.
      disabled={revoking !== null}
      isLoading={busy}
      loadingLabel={`Scanning ${countLabel(networkCount, "network")}…`}
      icon={
        snapshot === null ? (
          <Search className="h-4 w-4" aria-hidden="true" />
        ) : (
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        )
      }
    >
      {snapshot === null ? "Scan approvals" : "Scan again"}
    </Button>
  )

  const pendingNetworkName =
    pendingRevoke === null ? "" : NETWORKS[pendingRevoke.networkKey]?.name ?? pendingRevoke.networkKey

  return (
    <>
      <Card variant="inset" padding="sm">
        <p role="status" aria-live="polite" className="sr-only">
          {liveStatus}
        </p>

        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle as="h3" className="text-base">
                Allowances
              </CardTitle>
              {watchOnly && (
                <Badge tone="info">
                  <Eye className="h-3 w-3" aria-hidden="true" />
                  Watch-only
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {countLabel(networkCount, "public explorer")}, scanned only when you ask
            </p>
          </div>
        </div>

        {revokeError !== "" && (
          <Alert tone="danger" title="Could not revoke the approval." className="mb-3">
            {revokeError}
          </Alert>
        )}

        {snapshot === null ? (
          error !== "" ? (
            <ErrorState
              title="Could not scan for approvals."
              description={error}
              action={
                <Button variant="secondary" onClick={() => void scan()}>
                  Try again
                </Button>
              }
            />
          ) : (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Scanning queries public explorer APIs (the Blockscout family) with this address —
                the same public, read-only lookups as a balance check, stated plainly: the address
                is sent to those services. Each approval found is then re-read live from the
                network, so the numbers shown are current, not historical. The scan walks each
                network&apos;s full history and can take a minute.
                {canRevoke
                  ? " Nothing else leaves this app, and no key material is involved in the scan."
                  : ` Nothing else leaves this app. ${revokeUnavailableReason}`}
              </p>
              {scanButton}
            </div>
          )
        ) : (
          <div className="space-y-3">
            {error !== "" && (
              <Alert tone="warning" title="Could not refresh.">
                {error} Results shown are from {formatRelativeTime(snapshot.fetchedAt)}.
              </Alert>
            )}

            {snapshot.failures.length > 0 && (
              <p
                className="text-xs text-muted-foreground"
                title={snapshot.failures
                  .map((failure) => `${failure.networkName}: ${failure.error}`)
                  .join("\n")}
              >
                Could not scan {countLabel(snapshot.failures.length, "network")}:{" "}
                {snapshot.failures.map((failure) => failure.networkName).join(", ")}.
              </p>
            )}

            {totalActive === 0 ? (
              <>
                {anyTruncated && (
                  <p className="text-xs text-warning">
                    Some networks hit the scan&apos;s safety cap; older approvals may be missing.
                  </p>
                )}
                <EmptyState
                  title="No active token approvals found"
                  description="Nothing the scan found currently has a non-zero allowance, so there is nothing to revoke."
                  icon={<ShieldCheck className="h-6 w-6" aria-hidden="true" />}
                />
              </>
            ) : (
              <div className="space-y-2">
                {snapshot.networks.map((network) => {
                  const sectionId = `${SECTION_ID_PREFIX}-${network.networkKey}`
                  const isOpen = expanded[network.networkKey] === true
                  return (
                    <div
                      key={network.networkKey}
                      className="rounded-lg border border-border/60 bg-background/40"
                    >
                      {/*
                        Foldable section: a real button with aria-expanded and
                        aria-controls, sized to the 44px minimum touch target,
                        so a screen reader announces "collapsed/expanded" like
                        any other disclosure.
                      */}
                      <button
                        type="button"
                        onClick={() => toggleSection(network.networkKey)}
                        aria-expanded={isOpen}
                        aria-controls={sectionId}
                        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      >
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {network.networkName}
                          </span>
                          {network.isTestnet && <Badge tone="info">Testnet</Badge>}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {network.status === "failed" ? (
                            // A failed scan is not the same as an empty result —
                            // "0 approvals" here would tell an exposed account
                            // it is safe.
                            <Badge tone="warning">Scan failed</Badge>
                          ) : (
                            <Badge tone={network.approvals.length > 0 ? "primary" : "neutral"}>
                              {countLabel(network.approvals.length, "active approval")}
                            </Badge>
                          )}
                          <ChevronDown
                            className={cn(
                              "h-4 w-4 text-muted-foreground transition-transform",
                              isOpen && "rotate-180"
                            )}
                            aria-hidden="true"
                          />
                        </span>
                      </button>

                      {isOpen && (
                        <div
                          id={sectionId}
                          role="region"
                          aria-label={`${network.networkName} approvals`}
                          className="border-t border-border/60 px-3 py-3"
                        >
                          {network.status === "failed" ? (
                            <p className="text-xs text-muted-foreground">{network.error}</p>
                          ) : network.approvals.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              {network.pairsFound > 0
                                ? `Found ${countLabel(network.pairsFound, "approval")} in history; none is currently active.`
                                : "No approvals found for this address."}
                            </p>
                          ) : (
                            <>
                              <ul className="space-y-2.5">
                                {network.approvals.map((approval) => {
                                  const key = approvalRowKey(approval)
                                  const raw = approval.allowance.toString()
                                  const formatted =
                                    approval.tokenDecimals !== undefined
                                      ? formatBalanceForDisplay(
                                          approval.allowance,
                                          approval.tokenDecimals
                                        )
                                      : null
                                  /*
                                   * USD exposure only for a finite, priced
                                   * allowance: an unlimited allowance times
                                   * any price is meaningless, so it shows
                                   * nothing rather than an invented number,
                                   * and an unpriced token (no exchange_rate,
                                   * or metadata enrichment failed) degrades
                                   * the same way — missing price is missing
                                   * value, never zero.
                                   */
                                  const usdExposure =
                                    !approval.unlimited && formatted !== null
                                      ? estimateAllowanceUsd(
                                          formatted,
                                          approval.tokenPriceUsd ?? null
                                        )
                                      : null
                                  const spenderUrl = getRoutescanUrl(
                                    approval.spender,
                                    approval.networkKey
                                  )
                                  return (
                                    <li key={key} className="space-y-1">
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          {approval.tokenSymbol !== undefined ||
                                          approval.tokenName !== undefined ? (
                                            <p className="truncate text-sm font-medium text-foreground">
                                              {approval.tokenName ?? approval.tokenSymbol}
                                              {approval.tokenSymbol !== undefined &&
                                                approval.tokenName !== undefined && (
                                                  <span className="text-muted-foreground">
                                                    {" "}
                                                    ({approval.tokenSymbol})
                                                  </span>
                                                )}
                                            </p>
                                          ) : (
                                            <p
                                              className="truncate font-mono text-sm text-foreground"
                                              title={approval.token}
                                            >
                                              {truncateHex(approval.token, 10, 8)}
                                            </p>
                                          )}
                                          {approval.unlimited && (
                                            <p
                                              className="font-mono text-xs text-muted-foreground"
                                              title={`Raw allowance in base units: ${raw}`}
                                            >
                                              {raw} raw units
                                            </p>
                                          )}
                                        </div>
                                        <span
                                          className="shrink-0"
                                          title={`Current allowance in base units: ${raw}`}
                                        >
                                          {approval.unlimited ? (
                                            <Badge tone="warning">Unlimited</Badge>
                                          ) : (
                                            <span className="font-mono text-sm tabular-nums text-foreground">
                                              {formatted !== null
                                                ? approval.tokenSymbol !== undefined
                                                  ? `${formatted} ${approval.tokenSymbol}`
                                                  : formatted
                                                : raw}
                                            </span>
                                          )}
                                        </span>
                                      </div>
                                      {usdExposure !== null && (
                                        <p
                                          className="text-right font-mono text-xs tabular-nums text-muted-foreground"
                                          title="Allowance valued at the token's current USD price from the explorer"
                                        >
                                          ≈ {formatFiat(usdExposure)} exposure
                                        </p>
                                      )}
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex min-w-0 items-center gap-0.5">
                                          <p
                                            className="truncate font-mono text-xs text-muted-foreground"
                                            title={approval.spender}
                                          >
                                            {truncateHex(approval.spender, 10, 8)}
                                          </p>
                                          <CopyButton
                                            value={approval.spender}
                                            label="spender address"
                                            className="h-11 w-11 justify-center"
                                          />
                                          {spenderUrl !== "" && (
                                            <a
                                              href={spenderUrl}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-info transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                              title="View spender on explorer"
                                            >
                                              <ExternalLink
                                                className="h-4 w-4"
                                                aria-hidden="true"
                                              />
                                              <span className="sr-only">
                                                View spender{" "}
                                                {truncateHex(approval.spender, 8, 6)} on the
                                                explorer
                                              </span>
                                            </a>
                                          )}
                                        </div>
                                        {canRevoke ? (
                                          <Button
                                            variant="ghost"
                                            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                            onClick={() => setPendingRevoke(approval)}
                                            disabled={revoking !== null}
                                            isLoading={revoking === key}
                                            loadingLabel="Revoking…"
                                          >
                                            Revoke
                                          </Button>
                                        ) : (
                                          <span
                                            className="shrink-0 text-xs text-muted-foreground"
                                            title={revokeUnavailableReason}
                                          >
                                            Key required to revoke
                                          </span>
                                        )}
                                      </div>
                                    </li>
                                  )
                                })}
                              </ul>
                              {network.pairsFound > network.approvals.length && (
                                <p className="mt-2.5 text-xs text-muted-foreground">
                                  And{" "}
                                  {countLabel(
                                    network.pairsFound - network.approvals.length,
                                    "earlier approval"
                                  )}{" "}
                                  whose allowance is already zero.
                                </p>
                              )}
                            </>
                          )}
                          {network.truncated && (
                            <p className="mt-2.5 text-xs text-warning">
                              The scan hit a safety cap on this network; approvals in older
                              history may be missing.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {scanButton}
          </div>
        )}
      </Card>

      {pendingRevoke !== null && (
        <ResponsiveDialog
          isOpen
          onClose={() => setPendingRevoke(null)}
          title="Revoke approval"
          description="Sets the spender&apos;s token allowance to 0"
          footer={
            <>
              <Button variant="secondary" onClick={() => setPendingRevoke(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => void handleConfirmRevoke()}
                icon={<Ban className="h-4 w-4" aria-hidden="true" />}
              >
                Revoke
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-foreground">Token</p>
              {(pendingRevoke.tokenName !== undefined ||
                pendingRevoke.tokenSymbol !== undefined) && (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {pendingRevoke.tokenName ?? pendingRevoke.tokenSymbol}
                  {pendingRevoke.tokenSymbol !== undefined &&
                    pendingRevoke.tokenName !== undefined && (
                      <span className="text-muted-foreground">
                        {" "}
                        ({pendingRevoke.tokenSymbol})
                      </span>
                    )}
                </p>
              )}
              <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                {pendingRevoke.token}
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Spender</p>
              <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                {pendingRevoke.spender}
              </p>
            </div>
            <Alert tone="info" title="On-chain transaction">
              This writes approve(spender, 0) to {pendingNetworkName}. It costs gas, is signed
              locally with this account&apos;s key, and is broadcast exactly once. The spender
              can request a new approval afterwards; revoking does not affect approvals others
              have granted.
            </Alert>
          </div>
        </ResponsiveDialog>
      )}
    </>
  )
}
