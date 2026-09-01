"use client"

/**
 * Gas price levels for the developer-tools gas tracker.
 *
 * Split the same way `lib/ens.ts` splits ENS resolution: a pure, synchronous
 * estimator that turns raw JSON-RPC output into numbers, and a thin async
 * fetcher that routes the calls through the shared RPC pool. Keeping the math
 * pure means the percentile behaviour, the pre-1559 fallback, and the defensive
 * parsing of hostile endpoint output are all unit-testable with plain fixtures —
 * no network and no mocks.
 *
 * Each level is a **total fee cap** — base fee plus priority fee — in wei,
 * rather than a priority fee alone. One number per tier is enough to multiply
 * by a gas limit for a worst-case cost, and it maps directly onto the
 * `maxFeePerGas` a wallet would set, so the UI never has to re-derive either.
 *
 * EIP-1559 chains are priced from `eth_feeHistory`; chains or endpoints that
 * cannot serve it fall back to `eth_gasPrice` with fixed margins rather than
 * failing, because "this chain only has legacy pricing" is still a usable
 * answer for someone deciding whether to transact now.
 */

import { logger } from "./logger"
import { RpcError } from "./multiRpc"
import { getAllNetworks, getNativeDecimals, withProvider, type Network } from "./ethers"
import { getPricesForNetworks } from "./priceFeed"

// ===== Types =====

/**
 * Outcome of the pure estimator.
 *
 * Matches the `{ ok, value | error }` convention of `lib/units.ts` and
 * `lib/hdWallet.ts`: on failure, `error` is a complete, user-presentable
 * sentence, so a caller never has to format a library message.
 */
export type GasResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Gas price levels, each a total fee cap in wei (base fee + priority fee). */
export interface GasEstimate {
  /**
   * 25th-percentile priority fee plus the latest base fee. Corresponds to the
   * first reward percentile requested by {@link getGasOverview}.
   */
  slow: bigint
  /** 50th-percentile priority fee plus the latest base fee. */
  standard: bigint
  /** 90th-percentile priority fee plus the latest base fee. */
  fast: bigint
  /**
   * Whether the levels came from `eth_feeHistory` (true) or the `eth_gasPrice`
   * fallback (false). The two describe different fee markets, so the UI states
   * which produced the numbers.
   */
  isEip1559: boolean
}

/** Everything the gas card renders for one network. */
export interface GasOverview extends GasEstimate {
  /** Network key the numbers belong to. */
  networkKey: Network
  /** Display name of the network. */
  networkName: string
  /** Native currency symbol, e.g. `ETH`. */
  currency: string
  /** Decimal places of the native currency, for base-unit cost math. */
  nativeDecimals: number
  /** USD price of one whole native unit, or null when no quote is available. */
  nativePriceUsd: number | null
  /** When the RPC data was collected, epoch milliseconds, so callers can judge staleness. */
  fetchedAt: number
}

/** Blocks of fee history requested. Enough to smooth one anomalous block. */
const FEE_HISTORY_BLOCK_COUNT = 15

/**
 * Reward percentiles requested, in the order the estimator consumes them:
 * column 0 prices `slow`, 1 `standard`, 2 `fast`.
 *
 * {@link estimateGasLevels} depends on this pairing — it reads the reward matrix
 * positionally, so the request and the estimator must be changed together.
 */
const REWARD_PERCENTILES: readonly [number, number, number] = [25, 50, 90]

// ===== Parsing helpers =====

/**
 * Parse a JSON-RPC quantity into wei.
 *
 * Accepts the hex string a raw `provider.send` returns, plus bigint, number and
 * decimal-string forms, so the estimator is usable against any provider shape.
 * Anything malformed — including negative or fractional values — yields null
 * rather than throwing: fee data from an arbitrary endpoint is untrusted input,
 * and one bad field must not take the whole estimate down.
 *
 * @param value - Candidate quantity in any accepted shape.
 * @returns The value in wei, or null when it cannot be parsed.
 */
function parseQuantity(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? BigInt(value) : null
  }
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    if (!/^[0-9a-fA-F]+$/.test(trimmed.slice(2))) return null
  } else if (!/^[0-9]+$/.test(trimmed)) {
    return null
  }

  try {
    const parsed = BigInt(trimmed)
    return parsed >= 0n ? parsed : null
  } catch {
    return null
  }
}

/**
 * Valid base fees from a fee history, oldest first.
 *
 * The RPC array is one entry longer than the block range: the final entry is
 * the node's prediction for the *next* block, which is the right base fee to
 * combine with reward percentiles for a transaction submitted now. Entries may
 * be `null` when the range straddles the London fork, so each is parsed
 * individually and unusable ones dropped.
 *
 * @param baseFeePerGas - The `baseFeePerGas` field of an `eth_feeHistory` result.
 * @returns Parsed base fees in order; empty when nothing is usable.
 */
function validBaseFees(baseFeePerGas: unknown): bigint[] {
  if (!Array.isArray(baseFeePerGas)) return []
  return baseFeePerGas
    .map((entry) => parseQuantity(entry))
    .filter((entry): entry is bigint => entry !== null)
}

/**
 * Collect the reward matrix into one array per requested percentile.
 *
 * `reward[i][j]` is the priority fee at percentile `j` paid by transactions in
 * block `i`. Rows and cells are parsed individually because some endpoints emit
 * `null` cells or short rows rather than failing the whole call. Columns beyond
 * the third are ignored, and fewer than three populated columns leaves the
 * caller to fall back to legacy pricing.
 *
 * @param reward - The `reward` field of an `eth_feeHistory` result.
 * @returns Three columns of wei values, one per tier.
 */
function rewardColumns(reward: unknown): bigint[][] {
  const columns: bigint[][] = [[], [], []]
  if (!Array.isArray(reward)) return columns

  for (const row of reward) {
    if (!Array.isArray(row)) continue
    for (let column = 0; column < columns.length; column++) {
      const parsed = parseQuantity(row[column])
      if (parsed !== null) columns[column].push(parsed)
    }
  }
  return columns
}

/**
 * Nearest-rank percentile of an already-sorted list.
 *
 * Nearest-rank needs no interpolation, so it works on bigint exactly: the result
 * is always an observed value, never a fraction that would have to be rounded.
 * Rank 50 therefore returns the middle observation — the lower of the two
 * middles for an even count — which is the conventional "median" here.
 *
 * @param sorted - Values sorted ascending. Must not be empty.
 * @param rank - Percentile between 0 and 100.
 * @returns The value at the nearest rank.
 */
function percentileOfSorted(sorted: readonly bigint[], rank: number): bigint {
  const index = Math.min(
    Math.max(Math.ceil((rank / 100) * sorted.length) - 1, 0),
    sorted.length - 1
  )
  return sorted[index]
}

/** Sort a copy ascending and take its median (rank 50). Null only when empty. */
function medianOf(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return percentileOfSorted(sorted, 50)
}

// ===== Pure estimator =====

/**
 * Estimate slow / standard / fast gas levels from raw RPC output.
 *
 * `feeHistory` is the JSON result of `eth_feeHistory` requested with reward
 * percentiles `[25, 50, 90]` (see {@link REWARD_PERCENTILES}); `latestGasPrice`
 * is the JSON result of `eth_gasPrice`, in any shape {@link parseQuantity}
 * accepts. Both are effectively optional: the estimator degrades from fee
 * history to the gas-price fallback, and only fails when neither source yields
 * a usable number.
 *
 * - EIP-1559 path: each tier is the median — across blocks — of that tier's
 *   reward percentile, plus the latest base fee. The median rather than the
 *   mean, so one anomalously expensive block cannot drag every tier up, and
 *   because a bigint median needs no division and is therefore exact.
 * - Legacy path: `gasPrice` at −10% / 100% / +25%. Multiplication happens
 *   before division so truncation toward zero only ever drops a fraction of a
 *   wei; `slow` is clamped to at least 1 wei so a non-zero node price never
 *   renders as a free transaction.
 *
 * @param feeHistory - Raw `eth_feeHistory` result, or nullish when unavailable.
 * @param latestGasPrice - Raw `eth_gasPrice` result, or nullish when unavailable.
 * @returns The three levels plus an `isEip1559` flag, or a user-presentable error.
 */
export function estimateGasLevels(
  feeHistory: unknown,
  latestGasPrice?: unknown
): GasResult<GasEstimate> {
  const history =
    typeof feeHistory === "object" && feeHistory !== null
      ? (feeHistory as { baseFeePerGas?: unknown; reward?: unknown })
      : {}

  const baseFees = validBaseFees(history.baseFeePerGas)
  const medians = rewardColumns(history.reward).map((column) => medianOf(column))

  if (baseFees.length > 0 && medians.every((median): median is bigint => median !== null)) {
    const latestBaseFee = baseFees[baseFees.length - 1]

    // A hostile or buggy endpoint could emit percentiles out of order; clamp so
    // the slow ≤ standard ≤ fast invariant the UI relies on always holds.
    const slowPriority = medians[0] < medians[1] ? medians[0] : medians[1]
    const fastPriority = medians[2] > medians[1] ? medians[2] : medians[1]

    return {
      ok: true,
      value: {
        slow: slowPriority + latestBaseFee,
        standard: medians[1] + latestBaseFee,
        fast: fastPriority + latestBaseFee,
        isEip1559: true,
      },
    }
  }

  const gasPrice = parseQuantity(latestGasPrice)
  if (gasPrice !== null) {
    // Truncation is toward zero: a "slow" price must never round up past what
    // the node suggested, and a "fast" one past 125% of it.
    let slow = (gasPrice * 9n) / 10n
    if (slow === 0n && gasPrice > 0n) slow = 1n
    const fast = (gasPrice * 5n) / 4n

    return {
      ok: true,
      value: { slow, standard: gasPrice, fast, isEip1559: false },
    }
  }

  return {
    ok: false,
    error:
      "This network returned neither usable fee history nor a gas price, so no estimate can be shown.",
  }
}

// ===== Fetcher =====

/** Captures a promise's outcome without throwing, for independent degradation. */
type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function attempt<T>(promise: Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Fetch a complete gas overview for one network.
 *
 * Both RPC calls are idempotent reads, so they go through `withProvider` and
 * inherit the pool's retry and failover. Each call is allowed to fail
 * independently — a node without `eth_feeHistory` still answers
 * `eth_gasPrice`, and the estimator degrades to legacy levels — but when both
 * fail the typed RPC error is rethrown for the UI to present. The price quote is
 * fetched in parallel because it can never fail the overview; `lib/priceFeed`
 * returns null rather than throwing.
 *
 * Nothing about the failure is logged with its payload: an RPC rejection can
 * echo the request including endpoint URLs with API keys, so errors travel out
 * as values and the only log line is a payload-free debug breadcrumb.
 *
 * @param networkKey - Network key, built-in or custom.
 * @param signal - Optional cancellation signal, e.g. when the user switches
 *   networks while a request is in flight.
 * @throws {RpcError} When the network is unknown or both RPC calls fail.
 * @throws {Error} When a node answered but the returned data is unusable.
 */
export async function getGasOverview(
  networkKey: Network,
  signal?: AbortSignal
): Promise<GasOverview> {
  const config = getAllNetworks()[networkKey]
  if (!config) {
    throw new RpcError("no-endpoints", `Network "${networkKey}" is not configured.`)
  }

  const [feeHistory, gasPrice, prices] = await Promise.all([
    attempt(
      withProvider(
        networkKey,
        (provider): Promise<unknown> =>
          provider.send("eth_feeHistory", [
            `0x${FEE_HISTORY_BLOCK_COUNT.toString(16)}`,
            "latest",
            [...REWARD_PERCENTILES],
          ]),
        signal
      )
    ),
    attempt(
      withProvider(
        networkKey,
        (provider): Promise<unknown> => provider.send("eth_gasPrice", []),
        signal
      )
    ),
    getPricesForNetworks(
      [{ key: networkKey, currency: config.currency, isTestnet: config.type === "testnet" }],
      "usd",
      signal
    ),
  ])

  if (!feeHistory.ok && !gasPrice.ok) {
    // Prefer the typed error: it carries a user-presentable message and a kind.
    const rpcError = [feeHistory.error, gasPrice.error].find(
      (error): error is RpcError => error instanceof RpcError
    )
    throw rpcError ?? new RpcError("all-endpoints-failed", "Could not read gas data.")
  }

  if (!feeHistory.ok) {
    // Dev-only breadcrumb: a chain silently falling back to legacy pricing is
    // worth noticing while debugging. The error itself stays out of the log.
    logger.debug("eth_feeHistory unavailable; pricing from eth_gasPrice", { network: networkKey })
  }

  const estimate = estimateGasLevels(
    feeHistory.ok ? feeHistory.value : null,
    gasPrice.ok ? gasPrice.value : undefined
  )
  if (!estimate.ok) {
    throw new Error(estimate.error)
  }

  return {
    networkKey,
    networkName: config.name,
    currency: config.currency,
    nativeDecimals: getNativeDecimals(networkKey),
    nativePriceUsd: prices.get(networkKey) ?? null,
    fetchedAt: Date.now(),
    ...estimate.value,
  }
}
