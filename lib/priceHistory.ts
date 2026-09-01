/**
 * Historical USD price series for native assets.
 *
 * `lib/priceFeed.ts` prices a balance *now*; this module answers "what did it
 * do", which is what a chart needs. Asset identity stays in priceFeed — callers
 * resolve a network's currency to a CoinGecko id with `getCoinId`, so an
 * ETH-native L2 is charted as `ethereum`, never as its governance token.
 *
 * CoinGecko's free `market_chart` endpoint is aggressively rate limited, and a
 * chart invites exactly the traffic that trips the limit: every asset or range
 * switch is a different request. Two mitigations:
 *
 * - Every completed response is cached per (coin, range) with a short TTL, so
 *   flipping between two settings and back — or leaving and re-entering the
 *   balances section — is served from memory instead of re-asked.
 * - A 429 is cached too, for the same span: retrying into a rate limit deepens
 *   it, so the honest answer for the next minute is "rate limited".
 *
 * Other failures are deliberately not remembered: a retry button that silently
 * returned a cached failure would look broken.
 */

import { logger } from "./logger"

/** Lookback windows the chart offers, in days. */
export const PRICE_HISTORY_RANGES = [7, 30, 365] as const

/** A supported lookback window in days. */
export type PriceHistoryRange = (typeof PRICE_HISTORY_RANGES)[number]

/** How long a completed response is served without refetching. */
export const SERIES_CACHE_TTL_MS = 60_000

/** Deadline for one market-chart request. */
const REQUEST_TIMEOUT_MS = 10_000

/** Error sentence returned for a remembered rate-limit refusal. */
const RATE_LIMITED_MESSAGE = "Price history is rate limited. Try again in a minute."

/** One point of a price series. */
export interface PricePoint {
  /** Milliseconds since the Unix epoch. */
  timestamp: number
  /** Price in USD at that moment. */
  price: number
}

/** Trend statistics over a series. */
export interface PriceSeriesSummary {
  /** Earliest usable price. */
  first: number
  /** Latest usable price. */
  last: number
  /** Percentage change from first to last. */
  changePct: number
  /** Highest price in the window. */
  high: number
  /** Lowest price in the window. */
  low: number
}

/** A fetch either yields a usable series or a user-presentable error. */
export type PriceHistoryResult =
  | { ok: true; value: PricePoint[] }
  | { ok: false; error: string }

/**
 * A cached response.
 *
 * `points: null` is not "no data" but a remembered rate-limit refusal: the
 * distinction lets the TTL logic treat the two cases alike while keeping the
 * cached value honest about what it holds.
 */
interface CacheEntry {
  points: PricePoint[] | null
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Reduce a (timestamp, price) pair to a point, or null when it cannot be
 * trusted.
 *
 * A price that is zero, negative, or non-finite is not a quote — CoinGecko
 * emits such values for assets with no trade in an interval — and letting one
 * through would poison high, low, and change into `NaN`. Timestamps get the
 * same treatment so a malformed entry cannot win the sort.
 */
function toUsablePoint(timestamp: unknown, price: unknown): PricePoint | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null
  return { timestamp, price }
}

/**
 * Reduce a series to trend statistics.
 *
 * Pure and total: it never throws on malformed input, because the input
 * ultimately comes from an external API whose contract is only informally
 * held. Unusable entries are dropped, and the survivors are sorted by
 * timestamp before `first` and `last` are read, so a mis-ordered response
 * cannot invert the trend.
 *
 * @param points - Series points; may be empty or contain malformed entries.
 * @returns The summary, or null when no usable point remains.
 */
export function summarizePriceSeries(points: readonly PricePoint[]): PriceSeriesSummary | null {
  const usable: PricePoint[] = []
  for (const entry of points) {
    if (typeof entry !== "object" || entry === null) continue
    const { timestamp, price } = entry as Partial<PricePoint>
    const point = toUsablePoint(timestamp, price)
    if (point !== null) usable.push(point)
  }

  if (usable.length === 0) return null

  // `first` and `last` mean earliest and latest, so order is established here
  // rather than trusted from the caller.
  usable.sort((a, b) => a.timestamp - b.timestamp)

  const first = usable[0].price
  const last = usable[usable.length - 1].price

  let high = first
  let low = first
  for (const { price } of usable) {
    if (price > high) high = price
    if (price < low) low = price
  }

  return {
    first,
    last,
    high,
    low,
    // `first` is positive by construction, so the division cannot divide by zero.
    changePct: ((last - first) / first) * 100,
  }
}

/**
 * Parse a CoinGecko `market_chart` payload into a series.
 *
 * The documented shape is `{ prices: [[ms, usd], ...] }`, ascending. Neither
 * property is trusted: entries are validated one by one and the result is
 * sorted, so a hostile or merely buggy response degrades to fewer points
 * rather than to a crash or a backwards chart.
 *
 * @param payload - Decoded response body of unknown shape.
 * @returns Usable points, sorted by timestamp; empty when nothing parses.
 */
export function parsePriceSeries(payload: unknown): PricePoint[] {
  if (typeof payload !== "object" || payload === null) return []
  const prices = (payload as Record<string, unknown>).prices
  if (!Array.isArray(prices)) return []

  const points: PricePoint[] = []
  for (const entry of prices) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [timestamp, price] = entry as [unknown, unknown]
    const point = toUsablePoint(timestamp, price)
    if (point !== null) points.push(point)
  }

  points.sort((a, b) => a.timestamp - b.timestamp)
  return points
}

/**
 * Fetch a coin's USD price history from CoinGecko's public `market_chart`
 * endpoint.
 *
 * Never throws: every failure mode — offline, timeout, rate limit, malformed
 * body, cancellation — returns `{ ok: false, error }` with a user-presentable
 * sentence, so a decorative panel can never crash a render. Completed
 * responses and rate-limit refusals are cached per (coin, range) for
 * {@link SERIES_CACHE_TTL_MS}.
 *
 * @param coinId - CoinGecko id from `getCoinId`, e.g. `"ethereum"`.
 * @param days - Lookback window in days.
 * @param signal - Optional cancellation signal.
 */
export async function fetchPriceHistory(
  coinId: string,
  days: PriceHistoryRange,
  signal?: AbortSignal
): Promise<PriceHistoryResult> {
  if (typeof coinId !== "string" || coinId.length === 0) {
    return { ok: false, error: "This asset has no price history." }
  }
  if (!PRICE_HISTORY_RANGES.includes(days)) {
    return { ok: false, error: "Unsupported time range." }
  }

  const key = `${coinId}:${days}`
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.fetchedAt < SERIES_CACHE_TTL_MS) {
    return cached.points === null
      ? { ok: false, error: RATE_LIMITED_MESSAGE }
      : { ok: true, value: cached.points }
  }

  return requestSeries(coinId, days, key, signal)
}

/** Perform the outbound request and populate the cache. */
async function requestSeries(
  coinId: string,
  days: PriceHistoryRange,
  cacheKey: string,
  signal?: AbortSignal
): Promise<PriceHistoryResult> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  const url = new URL(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart`
  )
  url.searchParams.set("vs_currency", "usd")
  url.searchParams.set("days", String(days))

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })

    if (response.status === 429) {
      // Remember the refusal: an immediate retry would deepen the limit, and
      // the honest answer for the next minute is "rate limited".
      logger.warn("Price history rate limited", { coinId, days })
      cache.set(cacheKey, { points: null, fetchedAt: Date.now() })
      return { ok: false, error: RATE_LIMITED_MESSAGE }
    }

    if (!response.ok) {
      // Status only — never the body, which can echo request details.
      logger.warn("Price history request failed", { coinId, days, status: response.status })
      return { ok: false, error: "Price history is unavailable right now. Try again shortly." }
    }

    const payload: unknown = await response.json()
    const points = parsePriceSeries(payload)
    if (points.length === 0) {
      logger.warn("Price history response had no usable points", { coinId, days })
      return { ok: false, error: "The price service returned no usable data for this asset." }
    }

    cache.set(cacheKey, { points, fetchedAt: Date.now() })
    return { ok: true, value: points }
  } catch (error) {
    if (signal?.aborted) {
      // Superseded by an asset or range switch; the caller ignores this
      // result, and nothing is cached because nothing was learned.
      logger.debug("Price history request cancelled")
      return { ok: false, error: "Price history request was cancelled." }
    }
    if (controller.signal.aborted) {
      // The deadline fired with no caller abort pending: this was a timeout.
      logger.warn("Price history request timed out", { coinId, days })
      return { ok: false, error: "The price service took too long to respond. Try again." }
    }
    // Offline, DNS failure, or a blocked request. The app-level offline banner
    // names the condition; this sentence only has to fail soft.
    logger.warn("Price history request failed", { coinId, days, error })
    return {
      ok: false,
      error: "Could not reach the price service. Check your connection and try again.",
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** Drop every cached series. Used on logout and in tests. */
export function clearPriceHistoryCache(): void {
  cache.clear()
}

/** Cache diagnostics, for debugging only. */
export function getPriceHistoryCacheStats(): { entries: number; withSeries: number } {
  let withSeries = 0
  for (const entry of cache.values()) {
    if (entry.points !== null) withSeries++
  }
  return { entries: cache.size, withSeries }
}
