/**
 * Native-currency price lookup.
 *
 * Two classes of defect in the previous implementation are corrected here.
 *
 * **Wrong asset priced.** Coin ids were assigned by network name, so every
 * ETH-native L2 was valued using its governance token: Optimism used OP, Arbitrum
 * used ARB, zkSync Era used ZK, and Gnosis used GNO rather than xDai. Those
 * tokens differ from the underlying asset by one to three orders of magnitude, so
 * the portfolio value shown to the user was simply wrong. The id is now derived
 * from the network's *currency*, which is the asset actually held.
 *
 * **A cache that never hit.** The fast path required every requested id to be
 * present, but an id CoinGecko could not resolve was never stored, so it stayed
 * permanently "missing" and every call refetched. Combined with a `no-cache`
 * request header, that produced sustained traffic to a rate-limited free API.
 * Unresolvable ids are now cached as explicit misses.
 */

import { logger } from "./logger"

/** Lifetime of a cached quote. */
const CACHE_TTL_MS = 5 * 60 * 1000

/** How long a failed lookup is remembered before being retried. */
const NEGATIVE_TTL_MS = 15 * 60 * 1000

/** Deadline for a price request. */
const REQUEST_TIMEOUT_MS = 8_000

/** Minimum gap between outbound requests, to respect the free-tier limit. */
const MIN_REQUEST_INTERVAL_MS = 10_000

/**
 * CoinGecko id per native currency symbol.
 *
 * Keyed by currency rather than by network: many networks share a currency, and
 * the currency is what determines the price.
 */
const CURRENCY_COIN_IDS: Readonly<Record<string, string>> = {
  ETH: "ethereum",
  BNB: "binancecoin",
  MATIC: "matic-network",
  POL: "matic-network",
  AVAX: "avalanche-2",
  FTM: "fantom",
  CELO: "celo",
  // Gnosis Chain's native unit is xDai, a dollar stablecoin — not the GNO token.
  XDAI: "xdai",
  MNT: "mantle",
  METIS: "metis-token",
  GLMR: "moonbeam",
  ZETA: "zetachain",
  KAIA: "kaia",
  BERA: "berachain-bera",
  USDC: "usd-coin",
  SOMI: "somnia",
}

/** Cached quote for one coin id. */
interface CacheEntry {
  /** Price in the quote currency, or null for a remembered miss. */
  price: number | null
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
let lastRequestAt = 0
let inFlight: Promise<void> | null = null

/**
 * Resolve the CoinGecko id for a network's native currency.
 *
 * Testnets deliberately return null: pricing test funds at mainnet rates invites a
 * user to believe worthless balances are worth thousands.
 *
 * @param currency - Native currency symbol, e.g. `ETH`.
 * @param isTestnet - Whether the network is a testnet.
 */
export function getCoinId(currency: string, isTestnet: boolean): string | null {
  if (isTestnet) return null
  return CURRENCY_COIN_IDS[currency.toUpperCase()] ?? null
}

function isFresh(entry: CacheEntry): boolean {
  const ttl = entry.price === null ? NEGATIVE_TTL_MS : CACHE_TTL_MS
  return Date.now() - entry.fetchedAt < ttl
}

/**
 * Fetch quotes for a set of coin ids, using the cache where possible.
 *
 * Never throws. A network failure, timeout, or rate-limit response yields the best
 * available data — stale entries in preference to nothing — because a price is
 * decoration and must never fail a balance render.
 *
 * @param coinIds - CoinGecko ids to price.
 * @param currency - Quote currency. Defaults to `usd`.
 * @param signal - Optional cancellation signal.
 * @returns Map of coin id to price, or null where unknown.
 */
export async function fetchPrices(
  coinIds: readonly string[],
  currency = "usd",
  signal?: AbortSignal
): Promise<Map<string, number | null>> {
  const unique = [...new Set(coinIds)].filter((id) => id.length > 0)
  const result = new Map<string, number | null>()
  if (unique.length === 0) return result

  const stale = unique.filter((id) => {
    const entry = cache.get(id)
    return entry === undefined || !isFresh(entry)
  })

  if (stale.length > 0) {
    if (inFlight !== null) {
      // Coalesce concurrent callers onto one request. Several panels mounting at
      // once previously produced several identical outbound calls.
      await inFlight.catch(() => undefined)
    } else if (Date.now() - lastRequestAt >= MIN_REQUEST_INTERVAL_MS) {
      inFlight = refresh(stale, currency, signal).finally(() => {
        inFlight = null
      })
      await inFlight.catch(() => undefined)
    }
    // Inside the throttle window, fall through and serve whatever is cached.
  }

  for (const id of unique) {
    result.set(id, cache.get(id)?.price ?? null)
  }
  return result
}

/** Perform the outbound request and populate the cache. */
async function refresh(
  coinIds: readonly string[],
  currency: string,
  signal?: AbortSignal
): Promise<void> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  const url = new URL("https://api.coingecko.com/api/v3/simple/price")
  url.searchParams.set("ids", coinIds.join(","))
  url.searchParams.set("vs_currencies", currency)

  try {
    lastRequestAt = Date.now()
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })

    if (response.status === 429) {
      // Treat a rate limit as a miss; the negative TTL stops an immediate retry
      // from compounding the problem.
      logger.warn("Price API rate limited")
      markMisses(coinIds)
      return
    }
    if (!response.ok) {
      logger.warn("Price API returned an error status", { status: response.status })
      markMisses(coinIds)
      return
    }

    const payload: unknown = await response.json()
    if (typeof payload !== "object" || payload === null) {
      markMisses(coinIds)
      return
    }

    const now = Date.now()
    const record = payload as Record<string, unknown>
    for (const id of coinIds) {
      const quote = record[id]
      const price =
        typeof quote === "object" && quote !== null
          ? (quote as Record<string, unknown>)[currency]
          : undefined

      cache.set(id, {
        // Remember an unresolvable id as an explicit miss so it stops being
        // refetched on every call.
        price: typeof price === "number" && Number.isFinite(price) ? price : null,
        fetchedAt: now,
      })
    }
  } catch (error) {
    if (controller.signal.aborted) {
      logger.debug("Price request aborted")
    } else {
      logger.warn("Price request failed", { error })
    }
    markMisses(coinIds)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** Record a batch as misses, preserving any existing usable price. */
function markMisses(coinIds: readonly string[]): void {
  const now = Date.now()
  for (const id of coinIds) {
    const existing = cache.get(id)
    // Keep a previously good price as stale data rather than discarding it: a
    // slightly old number is more useful to the user than an em dash.
    if (existing != null && existing.price !== null) continue
    cache.set(id, { price: null, fetchedAt: now })
  }
}

/** A network, described by what it actually holds. */
export interface PriceableNetwork {
  key: string
  currency: string
  isTestnet: boolean
}

/**
 * Prices keyed by network.
 *
 * @param networks - Network descriptors to price.
 * @param currency - Quote currency. Defaults to `usd`.
 * @param signal - Optional cancellation signal.
 */
export async function getPricesForNetworks(
  networks: readonly PriceableNetwork[],
  currency = "usd",
  signal?: AbortSignal
): Promise<Map<string, number | null>> {
  const byNetwork = new Map<string, string>()
  for (const network of networks) {
    const coinId = getCoinId(network.currency, network.isTestnet)
    if (coinId !== null) byNetwork.set(network.key, coinId)
  }

  const prices = await fetchPrices([...byNetwork.values()], currency, signal)

  const result = new Map<string, number | null>()
  for (const network of networks) {
    const coinId = byNetwork.get(network.key)
    result.set(network.key, coinId === undefined ? null : (prices.get(coinId) ?? null))
  }
  return result
}

/** Drop every cached quote. Used on logout and in tests. */
export function clearPriceCache(): void {
  cache.clear()
  lastRequestAt = 0
  inFlight = null
}

/** Cache diagnostics, for debugging only. */
export function getPriceCacheStats(): { entries: number; withPrice: number } {
  let withPrice = 0
  for (const entry of cache.values()) {
    if (entry.price !== null) withPrice++
  }
  return { entries: cache.size, withPrice }
}
