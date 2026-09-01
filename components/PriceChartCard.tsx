"use client"

/**
 * Native-asset price chart.
 *
 * Shows the USD history of the assets the balance table above it prices. The
 * selector offers the same curated network set as the gas tracker, resolved
 * through priceFeed's currency→coin-id mapping — so an ETH-native L2 is
 * charted as ETH, never as its governance token, the exact defect that
 * mapping exists to prevent. Networks that share a native asset collapse into
 * one option, because four selects reading "ETH" would produce four identical
 * charts.
 *
 * Accessibility: the SVG is hidden from assistive technology and recharts'
 * built-in keyboard layer is disabled — a price line read point-by-point is
 * noise, and a focusable element inside an aria-hidden subtree would itself
 * be a violation. Screen readers instead get a polite live region with the
 * trend, and everyone gets a toggleable summary with first/last/change/high/
 * low, which is also the visible fallback the chart's information lives in
 * when the picture cannot be seen.
 *
 * One in-flight request at a time, as in the gas tracker: switching asset or
 * range aborts the previous request, so a slow response can never land
 * results for a selection the user has already navigated away from.
 */

import { useEffect, useId, useMemo, useState } from "react"
import { useReducedMotion } from "framer-motion"
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ChevronDown, ChevronUp, Minus, TrendingDown, TrendingUp } from "lucide-react"
import Card, { CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import Badge, { type BadgeTone } from "@/components/ui/Badge"
import Button from "@/components/ui/Button"
import Tabs, { type TabItem } from "@/components/ui/Tabs"
import Field, { inputClassName } from "@/components/ui/Field"
import { EmptyState, ErrorState } from "@/components/ui/Feedback"
import { Skeleton, SkeletonGroup } from "@/components/ui/Skeleton"
import { NETWORKS } from "@/lib/ethers"
import { getCoinId } from "@/lib/priceFeed"
import {
  fetchPriceHistory,
  summarizePriceSeries,
  type PriceHistoryRange,
  type PricePoint,
} from "@/lib/priceHistory"
import { formatFiat, formatRelativeTime } from "@/lib/format"
import { useOnlineStatus } from "@/lib/useOnlineStatus"
import { cn } from "@/lib/utils"
import { describeError, logger } from "@/lib/logger"

/**
 * Networks whose native asset can be charted — the gas tracker's curated
 * mainnet set; see that module for why the list is hand-picked rather than the
 * full table.
 */
const CHART_NETWORK_KEYS = [
  "mainnet",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "bsc",
  "avalanche",
] as const

/** One chartable asset: a native currency resolved to its CoinGecko id. */
interface ChartAsset {
  /** Network key of the first network carrying this asset; the select value. */
  key: string
  /** CoinGecko id, resolved through priceFeed so the id table has one home. */
  coinId: string
  /** Currency symbol, e.g. `ETH`. */
  symbol: string
  /** Network display name for the option label. */
  name: string
}

/**
 * Chartable assets, derived — never hand-copied — from the network table and
 * the coin-id mapping, so a future table edit flows through here without a
 * second list to forget. A key that disappears from the table degrades to a
 * shorter list; a duplicate coin id (every ETH L2) is deduplicated, since the
 * chart prices the asset, not the chain.
 */
const CHART_ASSETS: readonly ChartAsset[] = (() => {
  const seen = new Set<string>()
  const assets: ChartAsset[] = []
  for (const key of CHART_NETWORK_KEYS) {
    const network = NETWORKS[key]
    if (network === undefined) continue
    const coinId = getCoinId(network.currency, network.type === "testnet")
    if (coinId === null || seen.has(coinId)) continue
    seen.add(coinId)
    assets.push({ key, coinId, symbol: network.currency, name: network.name })
  }
  return assets
})()

const CHART_ASSET_KEYS: ReadonlySet<string> = new Set(CHART_ASSETS.map((asset) => asset.key))

/** Tab ids double as day counts, keeping the strip and the fetch in one vocabulary. */
type RangeId = "7" | "30" | "365"

const RANGE_TABS = [
  { id: "7", label: "7d" },
  { id: "30", label: "30d" },
  { id: "365", label: "1y" },
] as const satisfies readonly TabItem<RangeId>[]

const RANGE_DAYS: Readonly<Record<RangeId, PriceHistoryRange>> = {
  "7": 7,
  "30": 30,
  "365": 365,
}

/** Spoken labels for announcements and prose. */
const RANGE_LABELS: Readonly<Record<RangeId, string>> = {
  "7": "7 days",
  "30": "30 days",
  "365": "1 year",
}

/**
 * Format a percentage change with an explicit sign.
 *
 * The sign — like the badge's arrow icon — is the primary signal; the green or
 * red tone only reinforces it, because colour alone conveys nothing to a
 * colourblind user and nothing at all in a screenshot.
 */
function formatChangePct(changePct: number): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      signDisplay: "exceptZero",
      maximumFractionDigits: 2,
    }).format(changePct / 100)
  } catch {
    return `${changePct > 0 ? "+" : changePct < 0 ? "−" : ""}${Math.abs(changePct).toFixed(2)}%`
  }
}

/**
 * Compact price for the y-axis. Full precision lives in the tooltip and the
 * summary; an axis label only has to locate the band ("$3.1k", not
 * "$3,141.59").
 */
function formatAxisPrice(value: number): string {
  if (!Number.isFinite(value)) return ""
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `$${value.toFixed(0)}`
  }
}

/**
 * Period-change badge.
 *
 * Direction is carried by the arrow icon *and* the signed text, so the tone is
 * never the only channel — the same rule the badge module itself states.
 */
function ChangeBadge({ changePct }: { changePct: number }) {
  const direction = changePct > 0 ? "up" : changePct < 0 ? "down" : "flat"
  const tone: BadgeTone =
    direction === "up" ? "success" : direction === "down" ? "danger" : "neutral"
  const Icon = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus

  return (
    <Badge tone={tone}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {formatChangePct(changePct)}
    </Badge>
  )
}

/**
 * Custom chart tooltip.
 *
 * The default recharts tooltip ships its own unthemed colours and layout; this
 * one keeps the design tokens and tabular numbers, and reads the point back
 * from the payload item so the timestamp needs no axis round-trip. Recharts
 * clones this element and supplies `active` and `payload`; `showTime` is ours
 * and survives the clone.
 */
function ChartTooltip({
  active,
  payload,
  showTime,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ value?: unknown; payload?: unknown }>
  showTime?: boolean
}) {
  if (active !== true || payload === undefined || payload.length === 0) return null

  const item = payload[0]
  const price = typeof item?.value === "number" ? item.value : null
  if (price === null || !Number.isFinite(price)) return null

  const datum =
    typeof item?.payload === "object" && item.payload !== null
      ? (item.payload as { timestamp?: unknown })
      : null
  const timestamp = typeof datum?.timestamp === "number" ? datum.timestamp : null

  let when = ""
  if (timestamp !== null && Number.isFinite(timestamp)) {
    try {
      // Sub-year ranges are hourly data, where the time of day is the useful
      // part; the 1-year range is daily, where the year is.
      when = new Date(timestamp).toLocaleString(
        undefined,
        showTime === true
          ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
          : { month: "short", day: "numeric", year: "numeric" }
      )
    } catch {
      when = ""
    }
  }

  return (
    <div className="pointer-events-none rounded-lg border border-border/60 bg-popover/95 px-3 py-2 shadow-glass backdrop-blur">
      {when !== "" && <p className="text-xs text-muted-foreground">{when}</p>}
      <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
        {formatFiat(price)}
      </p>
    </div>
  )
}

/** One statistic in the collapsible series summary. */
function SummaryStat({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground",
          valueClassName
        )}
      >
        {value}
      </dd>
    </div>
  )
}

export default function PriceChartCard() {
  const [assetKey, setAssetKey] = useState(() => CHART_ASSETS[0]?.key ?? "")
  const [rangeId, setRangeId] = useState<RangeId>("7")
  const [series, setSeries] = useState<PricePoint[] | null>(null)
  // Busy from the first render: the card loads on mount, so there is no state
  // in which "loaded nothing, quietly" would be honest.
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumped to re-run the load effect (retry button, connection recovery).
  const [reloadNonce, setReloadNonce] = useState(0)
  const [showSummary, setShowSummary] = useState(false)

  const reduceMotion = useReducedMotion()
  const { isOnline, wasOffline } = useOnlineStatus()

  const asset = useMemo(
    () => CHART_ASSETS.find((entry) => entry.key === assetKey) ?? CHART_ASSETS[0],
    [assetKey]
  )
  const days = RANGE_DAYS[rangeId]
  const summary = useMemo(
    () => (series === null ? null : summarizePriceSeries(series)),
    [series]
  )

  // useId() contains colons: legal in an HTML id, but they break SVG url(#…)
  // references, so the gradient id is stripped to url-safe characters.
  const gradientId = `price-chart-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const summaryId = useId()

  /**
   * Load the series for the current asset and range.
   *
   * The effect owns one AbortController per run; the cleanup flag and the
   * abort together guarantee that a superseded request can neither set state
   * nor keep consuming the network. `fetchPriceHistory` is total, so the catch
   * is a programming-error backstop, not an expected path.
   */
  useEffect(() => {
    if (asset === undefined) return

    let cancelled = false
    const controller = new AbortController()

    setBusy(true)
    setError(null)
    // The visible series belongs to the previous asset or range; keeping it
    // would paint BNB's chart under ETH's label.
    setSeries(null)

    const load = async (): Promise<void> => {
      try {
        const result = await fetchPriceHistory(asset.coinId, days, controller.signal)
        if (cancelled) return
        if (result.ok) {
          setSeries(result.value)
        } else {
          setError(result.error)
        }
      } catch (caught) {
        if (cancelled) return
        logger.error("Price chart load failed", { component: "PriceChartCard", error: caught })
        setError(describeError(caught, "Could not load price history."))
      } finally {
        if (!cancelled) setBusy(false)
      }
    }

    void load()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [asset, days, reloadNonce])

  useEffect(() => {
    // The offline banner names the problem; this quietly heals it. The pair
    // changes exactly once per recovery, so the load effect re-runs then and
    // only then — a manual "Try again" is not the only path back to a chart.
    if (isOnline && wasOffline) setReloadNonce((value) => value + 1)
  }, [isOnline, wasOffline])

  const selectAsset = (next: string): void => {
    if (next === assetKey || !CHART_ASSET_KEYS.has(next)) return
    // Results and errors belong to the previously selected asset; clear them
    // in this same commit so a stale chart never renders under the new label.
    setSeries(null)
    setError(null)
    setBusy(true)
    setAssetKey(next)
  }

  const selectRange = (next: RangeId): void => {
    if (next === rangeId) return
    setSeries(null)
    setError(null)
    setBusy(true)
    setRangeId(next)
  }

  const retry = (): void => setReloadNonce((value) => value + 1)

  if (asset === undefined) {
    // Reachable only if the built-in network table loses every curated key;
    // the chart is decoration and must degrade rather than hang or crash.
    return (
      <Card as="section" aria-label="Price chart" className="w-full">
        <CardHeader>
          <CardTitle as="h3">Price Chart</CardTitle>
        </CardHeader>
        <EmptyState
          title="No chartable assets."
          description="None of the built-in networks with price history are available."
        />
      </Card>
    )
  }

  /** X-axis tick label: month for the 1-year window, month + day below that. */
  const formatTickDate = (timestamp: number): string => {
    try {
      return new Date(timestamp).toLocaleDateString(
        undefined,
        rangeId === "365" ? { month: "short" } : { month: "short", day: "numeric" }
      )
    } catch {
      return ""
    }
  }

  const asOf = series !== null && series.length > 0 ? series[series.length - 1].timestamp : null

  // The trend sentence is the chart's screen-reader voice. Always mounted so
  // the live region exists before its text arrives — a region that first
  // appears alongside its content is ignored by several screen readers.
  const announcement =
    summary !== null
      ? `${asset.symbol} price over the past ${RANGE_LABELS[rangeId]}: ${formatFiat(
          summary.last
        )}, ${formatChangePct(summary.changePct)} change, high ${formatFiat(
          summary.high
        )}, low ${formatFiat(summary.low)}.`
      : ""

  return (
    <Card as="section" aria-label="Price chart" className="w-full">
      <CardHeader className="items-center">
        <div>
          <CardTitle as="h3">Price Chart</CardTitle>
          <CardDescription>Native asset price in USD over time.</CardDescription>
        </div>
      </CardHeader>

      <div className="space-y-4">
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        <Field
          label="Asset"
          hint="Major native assets, in USD. Networks that share an asset, like the ETH L2s, are charted once."
        >
          {(props) => (
            <select
              {...props}
              value={assetKey}
              onChange={(event) => selectAsset(event.target.value)}
              className={inputClassName}
            >
              {CHART_ASSETS.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.symbol} — {entry.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Tabs
          items={RANGE_TABS}
          value={rangeId}
          onChange={selectRange}
          label="Time range"
          layoutGroupId="price-chart-range"
        />

        {busy && (
          <SkeletonGroup label={`Loading ${asset.symbol} price history`} className="space-y-3">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-56 w-full rounded-xl" />
          </SkeletonGroup>
        )}

        {!busy && (error !== null || summary === null) && (
          <ErrorState
            title="Price history is unavailable."
            description={error ?? "The price service returned no usable data for this asset."}
            action={
              <Button variant="secondary" onClick={retry}>
                Try again
              </Button>
            }
          />
        )}

        {!busy && error === null && series !== null && summary !== null && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">{asset.symbol} / USD</p>
                <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                  {formatFiat(summary.last)}
                </p>
              </div>
              <ChangeBadge changePct={summary.changePct} />
            </div>

            {/*
              The picture itself is decorative: the trend is carried by the
              live region above and the summary below. recharts' keyboard
              layer is disabled for the same reason — a focusable element
              inside an aria-hidden subtree is a violation, not a feature.
            */}
            <div className="h-56 w-full" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={series}
                  margin={{ top: 8, right: 4, bottom: 0, left: 4 }}
                  accessibilityLayer={false}
                >
                  <defs>
                    {/*
                      The fill and stroke resolve through CSS variables, so the
                      chart re-themes with dark mode instead of holding a stale
                      colour captured at render time.
                    */}
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  {/* Minimal chrome by design: no gridlines, no axis lines,
                      quiet labels. The area carries the shape. */}
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={formatTickDate}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={32}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  />
                  <YAxis
                    orientation="right"
                    /* Pad by a few percent so the peaks do not kiss the plot
                       edges and read as clipped. */
                    domain={([dataMin, dataMax]) => [dataMin * 0.97, dataMax * 1.03]}
                    tickCount={3}
                    width={52}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={formatAxisPrice}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  />
                  <Tooltip
                    cursor={{ stroke: "hsl(var(--border))", strokeDasharray: "4 4" }}
                    content={<ChartTooltip showTime={rangeId !== "365"} />}
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="price"
                    name={`${asset.symbol} price`}
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill={`url(#${gradientId})`}
                    isAnimationActive={reduceMotion !== true}
                    activeDot={{ r: 4, strokeWidth: 0, fill: "hsl(var(--primary))" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div>
              <Button
                variant="ghost"
                size="sm"
                fullWidth
                aria-expanded={showSummary}
                aria-controls={summaryId}
                onClick={() => setShowSummary((value) => !value)}
                icon={
                  showSummary ? (
                    <ChevronUp className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  )
                }
              >
                {showSummary ? "Hide series summary" : "Show series summary"}
              </Button>
              {showSummary && (
                <dl id={summaryId} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <SummaryStat label="Start" value={formatFiat(summary.first)} />
                  <SummaryStat label="End" value={formatFiat(summary.last)} />
                  <SummaryStat
                    label="Change"
                    value={formatChangePct(summary.changePct)}
                    valueClassName={
                      summary.changePct > 0
                        ? "text-success"
                        : summary.changePct < 0
                          ? "text-destructive"
                          : undefined
                    }
                  />
                  <SummaryStat label="High" value={formatFiat(summary.high)} />
                  <SummaryStat label="Low" value={formatFiat(summary.low)} />
                </dl>
              )}
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              USD prices from CoinGecko
              {asOf !== null ? `, as of ${formatRelativeTime(asOf)}` : ""}. Hourly points for the
              7- and 30-day ranges, daily for 1 year.
            </p>
          </div>
        )}
      </div>
    </Card>
  )
}
