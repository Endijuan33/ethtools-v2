"use client"

/**
 * Portfolio aggregation for the encrypted vault's unlocked view.
 *
 * Split the same way `lib/gasTracker.ts` splits gas estimation: a pure,
 * synchronous aggregator that turns balance-and-price entries into totals and
 * breakdowns, and a thin async fetcher that routes the reads through the shared
 * RPC pool and the price feed. Keeping the math pure means totals, display
 * ordering, zero-collapse and missing-price degradation are all unit-testable
 * with plain fixtures — no network and no mocks.
 *
 * Security: nothing secret can reach this module. Its only inputs are an
 * address — public information — and data read from public RPC endpoints, so it
 * can never become a path by which key material leaves the vault. That is also
 * why it serves watch-only accounts identically to key-holding ones.
 *
 * ERC-20 tokens tracked in `components/TokenManager.tsx` are deliberately *not*
 * aggregated. The tracked list is persisted per network with no address
 * scoping, so it cannot be attributed to the active account cleanly, and the
 * price feed only quotes native currencies — pricing an arbitrary token by its
 * symbol would repeat the exact wrong-asset mistake `lib/priceFeed.ts` exists to
 * prevent. The aggregator itself is asset-agnostic, so wiring tokens in later
 * is a data-source change, not a math change.
 */

import { describeError, logger } from "./logger"
import { RpcError } from "./multiRpc"
import { getBalanceWei, getNativeDecimals, NETWORKS } from "./ethers"
import { getPricesForNetworks } from "./priceFeed"
import { isEthAddress } from "./schema"
import { isSupportedDecimals } from "./units"

// ===== Types =====

/**
 * Outcome of the portfolio fetcher.
 *
 * Matches the `{ ok, value | error }` convention of `lib/units.ts` and
 * `lib/gasTracker.ts`: on failure, `error` is a complete user-presentable
 * sentence, so a caller never has to format a library message.
 */
export type PortfolioResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** One asset holding on one network — the aggregator's input unit. */
export interface PortfolioEntry {
  /** Network key, e.g. `"mainnet"`. */
  networkKey: string
  /** Network display name, e.g. `"Ethereum Mainnet"`. */
  networkName: string
  /** Asset symbol, e.g. `"ETH"`. */
  symbol: string
  /** Exact balance in base units. Expected non-negative. */
  balance: bigint
  /** Decimal places of `balance`; a non-negative integer. */
  decimals: number
  /** USD price of one whole unit, or null when no quote could be obtained. */
  priceUsd: number | null
}

/** One network row of the breakdown. */
export interface NetworkHolding {
  /** Network key, e.g. `"mainnet"`. */
  networkKey: string
  /** Network display name. */
  networkName: string
  /** Asset symbol of this holding — the network's native currency today. */
  symbol: string
  /** Exact balance in base units. */
  balance: bigint
  /** Decimal places of `balance`, for display formatting. */
  decimals: number
  /** USD value of the holding, or null when no price is available. */
  usd: number | null
  /** Share of the priced portfolio in [0, 1]; zero when unpriced or valueless. */
  share: number
}

/** One asset row, aggregated across every network it is held on. */
export interface AssetHolding {
  /** Asset symbol, uppercased for grouping. */
  symbol: string
  /**
   * Exact combined balance in base units, or null when the contributing
   * entries disagree on decimals — wei of different scales cannot be summed,
   * and silently doing so would misstate the holding.
   */
  balance: bigint | null
  /** Decimal places of `balance`; null when it could not be combined. */
  decimals: number | null
  /** USD value summed across networks, or null when no occurrence is priced. */
  usd: number | null
  /** Share of the priced portfolio in [0, 1]. */
  share: number
  /** Number of networks this asset is held on with a non-zero balance. */
  networkCount: number
}

/** Aggregated portfolio: totals plus the two breakdowns. */
export interface Portfolio {
  /** Sum of the priced holdings' USD values; unpriced entries are excluded. */
  netUsd: number
  /**
   * Per-network rows, one per network+asset holding, ordered for display:
   * priced holdings by USD value descending, then unpriced holdings by name,
   * then — boringly last — the zero-balance rows the UI collapses.
   */
  byNetwork: NetworkHolding[]
  /** Per-asset rows, largest USD first, unpriced and empty assets last. */
  byAsset: AssetHolding[]
  /** Number of holdings lacking a usable price. */
  unpricedCount: number
  /** Total number of holdings considered, after collapsing duplicates. */
  entryCount: number
}

/** A network whose balance could not be read at all. */
export interface NetworkFailure {
  networkKey: string
  networkName: string
  /** Already-sanitised, user-presentable failure message. */
  error: string
}

/** Everything the portfolio card renders for one address. */
export interface PortfolioSnapshot {
  address: string
  /** Aggregated totals and breakdowns. */
  portfolio: Portfolio
  /** Networks that could not be read, so the totals knowingly omit them. */
  failures: readonly NetworkFailure[]
  /** Epoch milliseconds, so the UI can state how fresh the figures are. */
  fetchedAt: number
}

// ===== Exact USD arithmetic =====

/**
 * USD amounts are carried through the aggregation as bigint counts of
 * 1e-8 dollars — finer than any display format and finer than CoinGecko
 * quotes. Integer summation cannot drift the way repeated float addition can,
 * so a total is always the exact sum of its (truncated) parts.
 */
const USD_SCALE = 100_000_000n

/** The same scale as a number, for the single conversion at the boundary. */
const USD_SCALE_NUMBER = 100_000_000

/**
 * A price usable for arithmetic, or null.
 *
 * Non-finite and negative quotes are treated as missing rather than clamped:
 * clamping a garbage quote to zero would present an unknown value as a known
 * one, which is the failure mode this module exists to avoid.
 */
function sanitizedPrice(price: number | null): number | null {
  if (price === null || !Number.isFinite(price) || price < 0) return null
  return price
}

/**
 * A price as an integer count of {@link USD_SCALE} units, truncating toward
 * zero. Returns null for quotes so large the scaling overflows — no real
 * currency price gets near that, and a saturated value would be a lie.
 */
function priceToScaled(price: number): bigint | null {
  const scaled = price * USD_SCALE_NUMBER
  if (!Number.isFinite(scaled)) return null
  return BigInt(Math.trunc(scaled))
}

/**
 * USD value of one holding, as an exact count of {@link USD_SCALE} units.
 *
 * The balance is multiplied by the scaled price *before* the decimal division,
 * and bigint division truncates toward zero. The reverse order would zero out
 * any balance smaller than one whole unit, and a rounded-up division would
 * display money the user does not have.
 *
 * A zero balance is worth exactly zero whatever the price, so it counts as
 * priced: an empty network must never masquerade as missing price data.
 */
function entryUsdScaled(
  balance: bigint,
  decimals: number,
  price: number | null
): bigint | null {
  if (balance === 0n) return 0n
  if (!isSupportedDecimals(decimals)) return null

  const safePrice = sanitizedPrice(price)
  if (safePrice === null) return null
  const scaledPrice = priceToScaled(safePrice)
  if (scaledPrice === null) return null

  return (balance * scaledPrice) / 10n ** BigInt(decimals)
}

/** Convert an exact scaled amount to the display float. */
function scaledToUsd(scaled: bigint): number {
  return Number(scaled) / USD_SCALE_NUMBER
}

/** Proportional share of the priced total, clamped to [0, 1]. */
function shareOf(usd: number | null, netUsd: number): number {
  if (usd === null || !Number.isFinite(usd) || netUsd <= 0 || !Number.isFinite(netUsd)) {
    return 0
  }
  return Math.min(Math.max(usd / netUsd, 0), 1)
}

// ===== Pure aggregator =====

/**
 * Aggregate per-network, per-asset balance entries into totals and breakdowns.
 *
 * Each network+symbol pair (case-insensitive) must appear at most once; a
 * duplicate replaces the earlier entry, and the totals are computed over the
 * collapsed list so rows and totals can never disagree.
 *
 * @param entries - Holdings to aggregate. Balances are bigint base units; a
 *   missing price yields a visible-but-unvalued row rather than a dropped one,
 *   and a zero balance prices to exactly zero rather than "unknown".
 * @returns Totals plus per-network and per-asset breakdowns.
 */
export function aggregatePortfolio(entries: readonly PortfolioEntry[]): Portfolio {
  const unique = new Map<string, PortfolioEntry>()
  for (const entry of entries) {
    unique.set(`${entry.networkKey}\u0000${entry.symbol.toUpperCase()}`, entry)
  }
  const holdings = [...unique.values()]

  const priced = holdings.map((entry) =>
    entryUsdScaled(entry.balance, entry.decimals, entry.priceUsd)
  )

  let netUsdScaled = 0n
  let unpricedCount = 0
  for (const value of priced) {
    if (value === null) unpricedCount += 1
    else netUsdScaled += value
  }
  const netUsd = scaledToUsd(netUsdScaled)

  const byNetwork = holdings.map((entry, index) => {
    const usd = priced[index] === null ? null : scaledToUsd(priced[index] as bigint)
    return {
      networkKey: entry.networkKey,
      networkName: entry.networkName,
      symbol: entry.symbol,
      balance: entry.balance,
      decimals: entry.decimals,
      usd,
      share: shareOf(usd, netUsd),
    }
  })

  interface AssetAccumulator {
    symbol: string
    usdScaled: bigint | null
    balance: bigint | null
    decimals: number | null
    networks: Set<string>
  }

  const assets = new Map<string, AssetAccumulator>()
  holdings.forEach((entry, index) => {
    const symbol = entry.symbol.toUpperCase()
    let asset = assets.get(symbol)
    if (asset === undefined) {
      asset = {
        symbol,
        usdScaled: null,
        balance: entry.balance,
        decimals: entry.decimals,
        networks: new Set<string>(),
      }
      assets.set(symbol, asset)
    } else if (asset.decimals === null) {
      // Already poisoned by a decimals mismatch; the sum stays unavailable.
    } else if (asset.decimals === entry.decimals) {
      asset.balance = (asset.balance ?? 0n) + entry.balance
    } else {
      asset.balance = null
      asset.decimals = null
    }

    const value = priced[index]
    if (value !== null) asset.usdScaled = (asset.usdScaled ?? 0n) + value
    if (entry.balance > 0n) asset.networks.add(entry.networkKey)
  })

  const byAsset = [...assets.values()].map((asset) => {
    const usd = asset.usdScaled === null ? null : scaledToUsd(asset.usdScaled)
    return {
      symbol: asset.symbol,
      balance: asset.balance,
      decimals: asset.decimals,
      usd,
      share: shareOf(usd, netUsd),
      networkCount: asset.networks.size,
    }
  })

  byNetwork.sort(compareNetworkRows)
  byAsset.sort(compareAssetRows)

  return { netUsd, byNetwork, byAsset, unpricedCount, entryCount: holdings.length }
}

/**
 * Display order for network rows: real money first (largest USD value first),
 * then holdings whose price is missing — still real, just unvalued — and
 * last the zero-balance rows the UI collapses into a single boring line.
 */
function compareNetworkRows(a: NetworkHolding, b: NetworkHolding): number {
  const rankA = a.balance === 0n ? 2 : a.usd === null ? 1 : 0
  const rankB = b.balance === 0n ? 2 : b.usd === null ? 1 : 0
  if (rankA !== rankB) return rankA - rankB
  if (rankA === 0 && a.usd !== null && b.usd !== null && a.usd !== b.usd) {
    return b.usd - a.usd
  }
  // Plain string comparison, not localeCompare: collation varies by environment,
  // and a deterministic order is worth more here than a localized one.
  return a.networkName < b.networkName ? -1 : a.networkName > b.networkName ? 1 : 0
}

/** Display order for asset rows: same value-first policy as network rows. */
function compareAssetRows(a: AssetHolding, b: AssetHolding): number {
  const rankA = a.networkCount === 0 ? 2 : a.usd === null ? 1 : 0
  const rankB = b.networkCount === 0 ? 2 : b.usd === null ? 1 : 0
  if (rankA !== rankB) return rankA - rankB
  if (rankA === 0 && a.usd !== null && b.usd !== null && a.usd !== b.usd) {
    return b.usd - a.usd
  }
  return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
}

// ===== Fetcher =====

/**
 * Networks the portfolio covers.
 *
 * A hand-picked mainnet subset mirroring the curation in
 * `components/GasTrackerCard.tsx`, rather than the full table: fanning out to
 * twenty-plus chains would spend the RPC pool mostly on zero rows, and testnets
 * are excluded outright because `lib/priceFeed` deliberately refuses to price
 * them — test funds must never look like real money.
 */
const PORTFOLIO_NETWORK_KEYS = [
  "mainnet",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "bsc",
  "avalanche",
] as const

/** One network the fetcher will read. */
interface PortfolioTarget {
  key: string
  name: string
  currency: string
  decimals: number
}

/** The curated list, filtered through the built-in table. */
function portfolioTargets(): PortfolioTarget[] {
  // A future rename or reclassification of a key degrades to a shorter list
  // instead of crashing, the same way the gas tracker's options are filtered.
  return PORTFOLIO_NETWORK_KEYS.filter(
    (key) => key in NETWORKS && NETWORKS[key].type === "mainnet"
  ).map((key) => ({
    key,
    name: NETWORKS[key].name,
    currency: NETWORKS[key].currency,
    decimals: getNativeDecimals(key),
  }))
}

/** Outcome of reading one network's native balance. */
type NetworkRead =
  | { status: "ok"; target: PortfolioTarget; balance: bigint }
  | { status: "failed"; target: PortfolioTarget; error: string }
  | { status: "aborted" }

/**
 * Read one network's balance. Never rejects.
 *
 * Exactly one attempt at this layer: retries, per-request timeouts, and
 * endpoint failover live in the pool inside `lib/multiRpc`. An abort is
 * reported as its own status, not a failure — a superseded or unmounted batch
 * is not something the user needs to be told about.
 */
async function readNetworkBalance(
  address: string,
  target: PortfolioTarget,
  signal?: AbortSignal
): Promise<NetworkRead> {
  try {
    const balance = await getBalanceWei(address, target.key, signal)
    return { status: "ok", target, balance }
  } catch (error) {
    if (signal?.aborted || (error instanceof RpcError && error.kind === "aborted")) {
      return { status: "aborted" }
    }
    logger.warn("Portfolio balance read failed", { network: target.key, error })
    return {
      status: "failed",
      target,
      error:
        error instanceof RpcError
          ? error.userMessage
          : describeError(error, "Could not read balance."),
    }
  }
}

/**
 * Read the public balances and prices for one address and aggregate them.
 *
 * Balances and prices are fetched in parallel; each network fails
 * independently, so one unreachable chain costs one muted note rather than the
 * whole portfolio. Only when *every* network fails is the result an error, and
 * only an address ever crosses this boundary — no secret is read, passed, or
 * stored.
 *
 * @param address - Account to value. Public information.
 * @param signal - Optional cancellation, e.g. when the user switches accounts
 *   or the card unmounts while a batch is in flight.
 * @returns The aggregated snapshot, or a user-presentable error.
 */
export async function getAccountPortfolio(
  address: string,
  signal?: AbortSignal
): Promise<PortfolioResult<PortfolioSnapshot>> {
  if (!isEthAddress(address)) {
    return { ok: false, error: "This is not a valid Ethereum address." }
  }

  const targets = portfolioTargets()
  const [reads, prices] = await Promise.all([
    Promise.all(targets.map((target) => readNetworkBalance(address, target, signal))),
    // Never throws: a failed quote yields null, not a failed portfolio.
    getPricesForNetworks(
      targets.map((target) => ({
        key: target.key,
        currency: target.currency,
        isTestnet: false,
      })),
      "usd",
      signal
    ),
  ])

  // The pool cannot cancel an already-sent request, so reads can still resolve
  // after an abort; report cancellation rather than a partial portfolio.
  if (signal?.aborted) {
    return { ok: false, error: "The request was cancelled." }
  }

  const entries: PortfolioEntry[] = []
  const failures: NetworkFailure[] = []
  for (const read of reads) {
    if (read.status === "ok") {
      entries.push({
        networkKey: read.target.key,
        networkName: read.target.name,
        symbol: read.target.currency,
        balance: read.balance,
        decimals: read.target.decimals,
        priceUsd: prices.get(read.target.key) ?? null,
      })
    } else if (read.status === "failed") {
      failures.push({
        networkKey: read.target.key,
        networkName: read.target.name,
        error: read.error,
      })
    }
  }

  if (entries.length === 0 && failures.length > 0) {
    // Every network failed: there is no portfolio to show, only a reason.
    return {
      ok: false,
      error: `Could not read balances on any network. ${failures[0].error}`,
    }
  }

  return {
    ok: true,
    value: {
      address,
      portfolio: aggregatePortfolio(entries),
      failures,
      fetchedAt: Date.now(),
    },
  }
}
