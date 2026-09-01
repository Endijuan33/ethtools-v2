"use client"

/**
 * Portfolio overview for one vault account.
 *
 * Renders the account's public on-chain balances across the curated major
 * networks as a net-worth headline plus a per-network breakdown. Data comes
 * from `lib/portfolio.ts`, which takes an address and nothing else — no secret
 * can reach this card, which is why it serves key-holding and watch-only
 * accounts identically.
 *
 * Degradation is designed rather than accidental:
 * - A network that fails to answer costs one muted line naming it; the rest of
 *   the portfolio renders normally.
 * - Missing prices keep balances visible. When *every* price is missing, the
 *   fiat headline is replaced by an explicit note instead of a confident
 *   "$0.00" — an unknown value must never look like a zero value.
 * - A failed refresh keeps the previous figures on screen with a warning,
 *   because a slightly stale portfolio is more useful than an error where data
 *   used to be.
 * - Zero-balance networks collapse into a single line: "nothing there" must be
 *   boring, not a wall of empty rows that reads like a problem.
 *
 * Refresh is manual. An automatic poll would burn the RPC pool while the vault
 * sits open unattended, which is exactly when its idle auto-lock is about to
 * close the view anyway.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Eye, RefreshCw } from "lucide-react"
import Card, { CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Badge from "./ui/Badge"
import Alert from "./ui/Alert"
import Skeleton, { SkeletonGroup } from "./ui/Skeleton"
import { ErrorState } from "./ui/Feedback"
import { getAccountPortfolio, type PortfolioSnapshot } from "@/lib/portfolio"
import {
  formatBalanceForDisplay,
  formatFiat,
  formatRelativeTime,
  truncateHex,
  UNKNOWN_VALUE,
} from "@/lib/format"
import { cn } from "@/lib/utils"

export interface PortfolioCardProps {
  /** Account whose balances are shown. Public data; no secret is used or needed. */
  address: string
  /** Account label, so the figures are tied to a named subject. */
  label: string
  /** True for watch-only accounts. Acknowledged in copy only — behavior is identical. */
  watchOnly?: boolean
}

/** Placeholder rows shown on the first load, before any data exists. */
const SKELETON_ROWS = 4

/** "1 network" / "3 networks" — the summary lines pluralize counts constantly. */
function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

export default function PortfolioCard({ address, label, watchOnly = false }: PortfolioCardProps) {
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  // One controller per in-flight fetch, superseded by the next one.
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    // Supersede any in-flight fetch: its results belong to a request the user
    // has already moved past, and letting it finish would only hold a socket.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setBusy(true)
    setError("")
    try {
      const result = await getAccountPortfolio(address, controller.signal)
      // The pool cannot cancel an already-sent HTTP request, so an aborted call
      // can still resolve; never let it land results for a superseded fetch.
      if (controller.signal.aborted) return
      if (result.ok) {
        setSnapshot(result.value)
      } else {
        // A failed refresh does not blank the card: the previous figures stay
        // and the error is presented next to them.
        setError(result.error)
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [address])

  /**
   * Fetch on mount and whenever the address changes.
   *
   * Balances belong to an address, so the previous account's figures are
   * discarded before the first row of the new one arrives — showing them under
   * a newly selected account would be actively misleading. The cleanup aborts
   * the in-flight batch, which covers both unmount and account switches.
   */
  useEffect(() => {
    setSnapshot(null)
    setError("")
    void load()
    return () => {
      abortRef.current?.abort()
    }
  }, [address, load])

  const portfolio = snapshot?.portfolio ?? null
  // Real holdings only: unpriced rows stay (they are real money, just
  // unvalued); zero-balance rows collapse into a single line.
  const rows = portfolio?.byNetwork.filter((row) => row.balance > 0n) ?? []
  const zeroCount = portfolio ? portfolio.byNetwork.length - rows.length : 0
  const allPricesMissing =
    portfolio !== null &&
    portfolio.entryCount > 0 &&
    portfolio.unpricedCount === portfolio.entryCount
  const somePricesMissing =
    portfolio !== null && portfolio.unpricedCount > 0 && !allPricesMissing

  /**
   * Text for the live region, mirroring what sighted users see.
   *
   * The region is always mounted and only its text changes: a live region that
   * first appears alongside its content is ignored by several screen readers.
   */
  const liveStatus = (() => {
    if (portfolio === null) {
      return error !== ""
        ? `Portfolio unavailable. ${error}`
        : `Loading the portfolio for ${label}.`
    }

    const parts: string[] = []
    if (allPricesMissing) {
      parts.push("USD prices are unavailable. Balances follow without values.")
    } else if (rows.length === 0) {
      parts.push("No balances found on the networks checked.")
    } else {
      parts.push(
        `Net worth ${formatFiat(portfolio.netUsd)} across ${countLabel(rows.length, "network")}.`
      )
    }
    if (somePricesMissing) {
      parts.push(
        `${countLabel(portfolio.unpricedCount, "network")} excluded from the total for missing prices.`
      )
    }
    if (zeroCount > 0) parts.push(`${countLabel(zeroCount, "network")} with zero balance.`)
    if (snapshot !== null && snapshot.failures.length > 0) {
      parts.push(`${countLabel(snapshot.failures.length, "network")} could not be read.`)
    }
    if (error !== "") parts.push("Last refresh failed; the figures shown may be stale.")
    return parts.join(" ")
  })()

  return (
    <Card variant="inset" padding="sm">
      <p role="status" aria-live="polite" className="sr-only">
        {liveStatus}
      </p>

      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h3" className="text-base">
              Portfolio
            </CardTitle>
            {watchOnly && (
              <Badge tone="info">
                <Eye className="h-3 w-3" aria-hidden="true" />
                Watch-only
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {label} <span className="font-mono">· {truncateHex(address, 10, 8)}</span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load()}
          isLoading={busy}
          icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
          title="Refresh portfolio"
          aria-label="Refresh portfolio"
          className="shrink-0"
        />
      </div>

      {snapshot === null ? (
        error !== "" ? (
          <ErrorState
            title="Could not load the portfolio."
            description={error}
            action={
              <Button variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        ) : (
          <SkeletonGroup label={`Loading the portfolio for ${label}`}>
            <Skeleton className="h-8 w-40" />
            <Skeleton className="mt-2 h-3 w-28" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                <div key={index} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                  <Skeleton className="h-1 w-full" />
                </div>
              ))}
            </div>
          </SkeletonGroup>
        )
      ) : (
        <div className="space-y-3">
          {allPricesMissing ? (
            <div>
              <p className="text-2xl font-semibold tabular-nums text-muted-foreground">
                {UNKNOWN_VALUE}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                USD prices are unavailable, so no total is shown. The balances below are
                unaffected.
              </p>
            </div>
          ) : (
            <div>
              <p className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                {formatFiat(snapshot.portfolio.netUsd)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {rows.length > 0
                  ? `Across ${countLabel(rows.length, "network")}`
                  : "No balances on the networks checked"}
              </p>
            </div>
          )}

          {somePricesMissing && (
            <p className="text-xs leading-relaxed text-warning">
              Prices are missing for {countLabel(snapshot.portfolio.unpricedCount, "network")};
              the total excludes {snapshot.portfolio.unpricedCount === 1 ? "it" : "them"}.
            </p>
          )}

          {rows.length > 0 && (
            <ul className="space-y-2.5">
              {rows.map((row) => (
                <li key={row.networkKey} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {row.networkName}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {formatBalanceForDisplay(row.balance, row.decimals)} {row.symbol}
                      </p>
                    </div>
                    <p
                      className={cn(
                        "shrink-0 font-mono text-sm tabular-nums",
                        row.usd === null ? "text-muted-foreground" : "text-foreground"
                      )}
                    >
                      {row.usd === null ? UNKNOWN_VALUE : formatFiat(row.usd)}
                    </p>
                  </div>
                  {row.usd !== null && (
                    /* Allocation bar. The width is data, so it cannot be a static
                       class; every colour stays on a design token. A priced row
                       keeps a minimum sliver so a real holding never renders as
                       an empty track. */
                    <div
                      className="h-1 overflow-hidden rounded-full bg-muted"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full rounded-full bg-primary/70"
                        style={{
                          width: `${Math.max(Math.round(row.share * 100), row.usd > 0 ? 2 : 0)}%`,
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {zeroCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {countLabel(zeroCount, "network")} with zero balance.
            </p>
          )}

          {snapshot.failures.length > 0 && (
            <p
              className="text-xs text-muted-foreground"
              title={snapshot.failures
                .map((failure) => `${failure.networkName}: ${failure.error}`)
                .join("\n")}
            >
              Could not read {countLabel(snapshot.failures.length, "network")}:{" "}
              {snapshot.failures.map((failure) => failure.networkName).join(", ")}.
            </p>
          )}

          {error !== "" && (
            <Alert tone="warning" title="Could not refresh.">
              {error} Balances shown are from {formatRelativeTime(snapshot.fetchedAt)}.
            </Alert>
          )}
        </div>
      )}
    </Card>
  )
}
