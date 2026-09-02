"use client"

/**
 * Token discovery card for the unlocked vault view.
 *
 * Finds ERC-20 tokens held by the active account's address by querying public
 * Blockscout-family explorer APIs across seven networks, and shows the results
 * grouped per network in foldable sections. An address is the only input — no
 * secret is read, passed, or stored — so the card serves watch-only accounts
 * identically to key-holding ones, exactly like the portfolio card beside it.
 *
 * Design decisions worth restating:
 *
 * - **Detection is an explicit action.** The address is sent to public explorer
 *   APIs, and although that is the same trust level as every balance read in
 *   this app, it is stated plainly next to the button and the scan never
 *   starts on its own. No auto-fetch on mount, no polling.
 * - **Results are foldable, collapsed by default.** Seven networks of token
 *   rows is a wall; a collapsed header per network keeps the card a summary
 *   until the user opts into detail. Each header is a real button wired with
 *   `aria-expanded`/`aria-controls`, not a clickable div.
 * - **Degradation is per-network.** One unreachable explorer costs one muted
 *   line naming it; the rest of the results render normally. A failed refresh
 *   keeps the previous results on screen with a warning, because stale
 *   discoveries are more useful than an error where data used to be.
 * - **Tracking reuses the existing token store.** "Track" writes through
 *   `trackDetectedToken`, the same `STORAGE_KEYS.TOKENS` shape
 *   `components/TokenManager.tsx` reads, so the tracked-tokens panel picks the
 *   token up with no new plumbing.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, Eye, RefreshCw, Search } from "lucide-react"
import Card, { CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Badge from "./ui/Badge"
import Alert from "./ui/Alert"
import CopyButton from "./ui/CopyButton"
import { ErrorState } from "./ui/Feedback"
import { notify } from "./ui/Toast"
import {
  EXPLORER_APIS,
  detectTokensAcrossNetworks,
  trackDetectedToken,
  type DetectedToken,
  type TokenDetectionSnapshot,
} from "@/lib/tokenDetection"
import {
  formatBalanceForDisplay,
  formatFiat,
  formatRelativeTime,
  truncateHex,
  UNKNOWN_VALUE,
} from "@/lib/format"
import { cn } from "@/lib/utils"

export interface TokenDiscoveryCardProps {
  /** Account whose tokens are scanned. Public data; no secret is used or needed. */
  address: string
  /** True for watch-only accounts. Acknowledged in copy only — behavior is identical. */
  watchOnly?: boolean
}

/** "1 network" / "3 networks" — the summary lines pluralize counts constantly. */
function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** Prefix for foldable-section ids, unique within this card. */
const SECTION_ID_PREFIX = "token-discovery-section"

export default function TokenDiscoveryCard({ address, watchOnly = false }: TokenDiscoveryCardProps) {
  const [snapshot, setSnapshot] = useState<TokenDetectionSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // One controller per in-flight scan, superseded by the next one.
  const abortRef = useRef<AbortController | null>(null)

  const networkCount = Object.keys(EXPLORER_APIS).length

  const detect = useCallback(async () => {
    // Supersede any in-flight scan: its results belong to a request the user
    // has already moved past, and letting it finish would only hold a socket.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setBusy(true)
    setError("")
    try {
      const result = await detectTokensAcrossNetworks(address, controller.signal)
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
   * Discoveries belong to an address; results from the previous account must
   * not survive into the next one's view, and the cleanup covers both unmount
   * and account switches. The parent keys this card by address, so this is
   * belt-and-braces rather than the primary reset.
   */
  useEffect(() => {
    setSnapshot(null)
    setError("")
    setExpanded({})
    return () => {
      abortRef.current?.abort()
    }
  }, [address])

  /** Fold or unfold one network's section. */
  const toggleSection = useCallback((networkKey: string): void => {
    setExpanded((previous) => ({ ...previous, [networkKey]: !previous[networkKey] }))
  }, [])

  /**
   * Track one detected token in the shared store, with a toast for the outcome.
   *
   * The write is synchronous and local, so there is no per-button busy state;
   * the refusal past the per-network cap is a toast, not an error panel — a
   * limit is information, not a failure.
   */
  const handleTrack = useCallback((token: DetectedToken): void => {
    const result = trackDetectedToken(token)
    if (result.ok) {
      if (result.alreadyTracked) {
        notify.info(`${token.symbol} is already tracked`)
      } else {
        notify.success(`Tracking ${token.symbol}`, "Added to the tracked tokens on this network.")
      }
    } else if (result.reason === "cap-reached") {
      notify.warning("Token limit reached", result.error)
    } else {
      notify.error("Could not track token", result.error)
    }
  }, [])

  const totalTokens =
    snapshot?.networks.reduce((count, network) => count + network.tokens.length, 0) ?? 0
  const networksWithTokens =
    snapshot?.networks.filter((network) => network.tokens.length > 0).length ?? 0

  /**
   * Text for the live region, mirroring what sighted users see.
   *
   * The region is always mounted and only its text changes: a live region that
   * first appears alongside its content is ignored by several screen readers.
   */
  const liveStatus = (() => {
    if (busy) {
      return `Scanning ${countLabel(networkCount, "network")} for tokens.`
    }
    if (snapshot === null) {
      return error !== ""
        ? `Token detection failed. ${error}`
        : `Token discovery can scan ${countLabel(networkCount, "network")}.`
    }
    const parts = [
      `Found ${countLabel(totalTokens, "token")} across ${countLabel(networksWithTokens, "network")}.`,
    ]
    if (snapshot.failures.length > 0) {
      parts.push(`${countLabel(snapshot.failures.length, "network")} could not be scanned.`)
    }
    if (error !== "") {
      parts.push("Last scan failed; the results shown may be stale.")
    }
    return parts.join(" ")
  })()

  const detectButton = (
    <Button
      onClick={() => void detect()}
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
      {snapshot === null ? "Detect tokens" : "Detect again"}
    </Button>
  )

  return (
    <Card variant="inset" padding="sm">
      <p role="status" aria-live="polite" className="sr-only">
        {liveStatus}
      </p>

      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h3" className="text-base">
              Token discovery
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

      {snapshot === null ? (
        error !== "" ? (
          <ErrorState
            title="Could not scan for tokens."
            description={error}
            action={
              <Button variant="secondary" onClick={() => void detect()}>
                Try again
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Detection queries public explorer APIs (the Blockscout family) with this address —
              the same public, read-only lookups as a balance check, stated plainly: the address
              is sent to those services. Nothing else leaves this app, and no key material is
              involved.
              {watchOnly && " Read-only detection: it works identically for a watch-only account."}
            </p>
            {detectButton}
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
                    aria-controls, sized to the 44px minimum touch target, so a
                    screen reader announces "collapsed/expanded" like any other
                    disclosure.
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
                        // "0 tokens" here would tell a holder they own nothing.
                        <Badge tone="warning">Scan failed</Badge>
                      ) : (
                        <Badge tone={network.tokens.length > 0 ? "primary" : "neutral"}>
                          {countLabel(network.tokens.length, "token")}
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
                      aria-label={`${network.networkName} tokens`}
                      className="border-t border-border/60 px-3 py-3"
                    >
                      {network.status === "failed" ? (
                        <p className="text-xs text-muted-foreground">{network.error}</p>
                      ) : network.tokens.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No tokens with a balance.
                        </p>
                      ) : (
                        <>
                          <ul className="space-y-2.5">
                            {network.tokens.map((token) => (
                              <li key={token.address} className="space-y-1">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-foreground">
                                      {token.name}{" "}
                                      <span className="text-muted-foreground">({token.symbol})</span>
                                    </p>
                                    <p className="font-mono text-xs text-muted-foreground">
                                      {formatBalanceForDisplay(token.value, token.decimals)}{" "}
                                      {token.symbol}
                                    </p>
                                  </div>
                                  <p
                                    className={cn(
                                      "shrink-0 font-mono text-sm tabular-nums",
                                      token.usdValue === null
                                        ? "text-muted-foreground"
                                        : "text-foreground"
                                    )}
                                  >
                                    {token.usdValue === null ? UNKNOWN_VALUE : formatFiat(token.usdValue)}
                                  </p>
                                </div>
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex min-w-0 items-center gap-1">
                                    <p className="truncate font-mono text-xs text-muted-foreground">
                                      {truncateHex(token.address, 10, 8)}
                                    </p>
                                    <CopyButton
                                      value={token.address}
                                      label="token contract address"
                                    />
                                  </div>
                                  <Button
                                    variant="ghost"
                                    onClick={() => handleTrack(token)}
                                    className="shrink-0"
                                  >
                                    Track
                                  </Button>
                                </div>
                              </li>
                            ))}
                          </ul>
                          {network.moreCount > 0 && (
                            <p className="mt-2.5 text-xs text-muted-foreground">
                              And {countLabel(network.moreCount, "more token")} with a balance.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {detectButton}
        </div>
      )}
    </Card>
  )
}
