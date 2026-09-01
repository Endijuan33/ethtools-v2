"use client"

/**
 * RPC health and latency panel.
 *
 * Shows, per network, the state the RPC pools in `lib/multiRpc` have observed
 * from real requests. It deliberately issues no requests of its own: the wallet
 * card above it already refreshes balances on a 30-second cycle, and every one of
 * those requests reports whether its endpoint worked. A panel that probed every
 * network independently would spend roughly 50 requests a minute re-discovering
 * what those refreshes had just found out.
 *
 * Consequences of that design, all intentional:
 * - A network with no pool yet renders as "Idle", which is honest: nothing has
 *   been observed, so nothing can be claimed.
 * - Benched endpoints become available again when their cooldown expires, with
 *   no event to listen for, so the snapshot is re-read on a timer.
 * - The refresh button re-reads local state; it never touches the network.
 *
 * Cleanup: one interval and one visibility listener, both removed on unmount.
 * The app shell unmounts this panel together with its section, so switching to
 * another section stops all ticking.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react"
import Card, { CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import Button from "@/components/ui/Button"
import Badge, { type BadgeTone } from "@/components/ui/Badge"
import { ErrorState } from "@/components/ui/Feedback"
import { SkeletonList } from "@/components/ui/Skeleton"
import { NETWORKS, getRpcHealthStatus } from "@/lib/ethers"
import { summarizePoolHealth, type PoolHealth, type PoolHealthTier } from "@/lib/multiRpc"
import { UNKNOWN_VALUE, formatRelativeTime } from "@/lib/format"
import { describeError, logger } from "@/lib/logger"

/**
 * Snapshot re-read interval.
 *
 * The read is local and free, so the only question is how stale the display may
 * become. Twenty seconds bounds worst-case staleness below the thirty-second
 * balance cycle that produces most changes, without adding a second
 * network-bound timer to the app.
 */
const POLL_INTERVAL_MS = 20_000

/**
 * Networks always shown, even while idle.
 *
 * Thirty built-in networks is too many rows to scan at a glance; these are the
 * ones a typical session actually touches. Every other network appears as soon
 * as its pool has observed anything, so live information is never hidden behind
 * the toggle — only idle silence is.
 */
const MAJOR_NETWORK_KEYS: ReadonlySet<string> = new Set([
  "mainnet",
  "optimism",
  "arbitrum",
  "base",
  "polygon",
  "bsc",
  "avalanche",
  "sepolia",
])

/**
 * Presentation metadata per tier.
 *
 * Every tier pairs a tone with a text label, because colour alone conveys
 * nothing to a colourblind user and nothing at all in a screenshot. Only
 * "degraded" pulses: it is the one unsettled state, with cooldowns counting
 * down and the next request able to revive the endpoint. "Down" is settled, and
 * pulsing a permanent failure would suggest activity that does not exist.
 */
const TIER_META: Record<PoolHealthTier, { tone: BadgeTone; label: string }> = {
  idle: { tone: "neutral", label: "Idle" },
  healthy: { tone: "success", label: "Healthy" },
  degraded: { tone: "warning", label: "Degraded" },
  down: { tone: "danger", label: "Down" },
}

/** One rendered network row. */
interface NetworkRow {
  key: string
  name: string
  isTestnet: boolean
  health: PoolHealth | null
  tier: PoolHealthTier
  /** Why the tier is what it is; empty for idle rows. */
  reason: string
}

/** Whether the tab is hidden. Guarded for non-browser environments. */
function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden
}

export default function RpcHealthPanel() {
  // Null until the first read completes, which drives the skeleton state.
  const [snapshot, setSnapshot] = useState<ReadonlyMap<string, PoolHealth> | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  /**
   * Re-read the health snapshot.
   *
   * Local only: it inspects the outcomes the pools have already recorded and
   * issues no requests. A failure here means the pool state itself is unreadable,
   * which surfaces as an error state rather than silently rendering stale
   * numbers as current.
   */
  const readHealth = useCallback(() => {
    try {
      setSnapshot(getRpcHealthStatus())
      setLastUpdated(Date.now())
      setReadError(null)
    } catch (error) {
      logger.error("RPC health read failed", { component: "RpcHealthPanel", error })
      setReadError(describeError(error, "Could not read RPC health."))
    }
  }, [])

  /**
   * Poll while visible.
   *
   * The interval stops when the tab is hidden — a snapshot nobody can see has no
   * deadline — and one read happens on return, because cooldowns will have
   * expired in the meantime. Unmount clears both the interval and the listener;
   * the app shell unmounts this panel with its section, so switching away stops
   * all ticking.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const stop = (): void => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }

    const start = (): void => {
      if (timer === null) timer = setInterval(readHealth, POLL_INTERVAL_MS)
    }

    const handleVisibilityChange = (): void => {
      if (isDocumentHidden()) {
        stop()
      } else {
        readHealth()
        start()
      }
    }

    // The first read is free, so it happens even in a hidden tab; only the
    // ticking waits until the tab is actually looked at.
    readHealth()
    if (!isDocumentHidden()) start()

    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      stop()
    }
  }, [readHealth])

  /** Rows for every built-in network, in table order. */
  const rows = useMemo<NetworkRow[]>(
    () =>
      Object.entries(NETWORKS).map(([key, config]) => {
        const health = snapshot?.get(key) ?? null
        const summary = summarizePoolHealth(health)
        return {
          key,
          name: config.name,
          isTestnet: config.type === "testnet",
          health,
          tier: summary.tier,
          reason: summary.reason,
        }
      }),
    [snapshot]
  )

  /**
   * Idle networks beyond the major set.
   *
   * Computed from the collapsed view regardless of `showAll`, so the toggle can
   * both expand and collapse. Deriving it from the visible list instead would
   * make the button disappear once expanded, with no way back.
   */
  const collapsedIdleCount = useMemo(
    () => rows.filter((row) => row.tier === "idle" && !MAJOR_NETWORK_KEYS.has(row.key)).length,
    [rows]
  )

  const visibleRows = useMemo(
    () =>
      rows.filter(
        (row) => showAll || row.tier !== "idle" || MAJOR_NETWORK_KEYS.has(row.key)
      ),
    [rows, showAll]
  )

  if (readError !== null) {
    return (
      <Card as="section" aria-label="RPC endpoint health" className="w-full">
        <CardHeader>
          <CardTitle as="h3">RPC Health</CardTitle>
        </CardHeader>
        <ErrorState
          title="RPC health could not be read"
          description={readError}
          action={
            <Button variant="outline" size="sm" onClick={readHealth}>
              Try again
            </Button>
          }
        />
      </Card>
    )
  }

  return (
    <Card as="section" aria-label="RPC endpoint health" className="w-full">
      <CardHeader className="items-center">
        <div>
          <CardTitle as="h3">RPC Health</CardTitle>
          <CardDescription>
            Endpoint status per network, observed from this session&apos;s requests. Endpoints
            are not probed separately.
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          onClick={readHealth}
          title="Refresh RPC health"
          aria-label="Refresh RPC health"
        >
          <RefreshCw size={20} aria-hidden="true" />
        </Button>
      </CardHeader>

      {snapshot === null ? (
        <SkeletonList rows={8} label="Loading RPC health" />
      ) : (
        <>
          {/*
            Polite, not assertive: a routine status change must never interrupt.
            The label ages with each poll, which is the same cadence the data
            itself refreshes at, so a screen reader user hears the panel keep
            time rather than chatter.
          */}
          <p aria-live="polite" className="mb-3 text-xs text-muted-foreground">
            Updated{" "}
            {lastUpdated === null ? UNKNOWN_VALUE : formatRelativeTime(lastUpdated)}
          </p>

          <ul className="max-h-96 space-y-2 overflow-y-auto">
            {visibleRows.map((row) => {
              const meta = TIER_META[row.tier]
              const latency =
                row.health !== null && row.health.bestLatencyMs !== null
                  ? `${Math.round(row.health.bestLatencyMs)}ms`
                  : null
              const failovers = row.health?.failovers ?? 0

              return (
                <li
                  key={row.key}
                  className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold text-foreground">{row.name}</span>
                      {row.isTestnet && <Badge tone="info">Testnet</Badge>}
                    </div>
                    {/* Numbers only appear once something has been observed; an
                        idle row stays silent rather than inventing a "0ms". */}
                    {row.tier !== "idle" && row.health !== null && (
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        {row.reason !== "" && <span>{row.reason}</span>}
                        {/* An em dash, never "0ms": a null latency means never
                            measured, and a zero would read as impossibly fast. */}
                        <span className="tabular-nums">{latency ?? UNKNOWN_VALUE}</span>
                        {failovers > 0 && (
                          <span className="tabular-nums">
                            {failovers} {failovers === 1 ? "failover" : "failovers"}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  <Badge tone={meta.tone} dot pulse={row.tier === "degraded"}>
                    {meta.label}
                  </Badge>
                </li>
              )
            })}
          </ul>

          {collapsedIdleCount > 0 && (
            <Button
              variant="ghost"
              fullWidth
              className="mt-2"
              onClick={() => setShowAll((value) => !value)}
              aria-expanded={showAll}
              icon={
                showAll ? (
                  <ChevronUp size={18} aria-hidden="true" />
                ) : (
                  <ChevronDown size={18} aria-hidden="true" />
                )
              }
            >
              {showAll
                ? "Show fewer networks"
                : `Show ${collapsedIdleCount} more idle ${
                    collapsedIdleCount === 1 ? "network" : "networks"
                  }`}
            </Button>
          )}
        </>
      )}
    </Card>
  )
}
