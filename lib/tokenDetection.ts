"use client"

/**
 * Automatic ERC-20 token detection across public Blockscout-family explorers.
 *
 * Split the same way `lib/portfolio.ts` splits portfolio valuation: a pure,
 * synchronous normalizer that turns a raw explorer payload into a ranked,
 * capped, validated token list, and a thin async fetcher per network. Keeping
 * the parsing pure means every filtering and ranking rule — the security
 * boundary — is unit-testable with plain fixtures, no network and no mocks.
 *
 * Security: the explorer response is hostile input. Popular addresses return
 * thousands of entries, most of them spam or dust airdropped to advertise, and
 * the payload comes from a third-party server over which this app has no
 * control. Every field is therefore validated before it reaches the UI:
 * balances stay `bigint` until display formatting, addresses are re-checksummed
 * with ethers, free-text fields are stripped of control characters and clamped,
 * and an entry that fails any check is discarded rather than allowed to error
 * the whole network. Nothing secret is involved anywhere — an address is the
 * only input, which is why detection serves watch-only accounts identically.
 */

import { getAddress } from "ethers"
import { describeError, logger } from "./logger"
import { NETWORKS } from "./ethers"
import { toFiatValue } from "./format"
import { readJson, writeJson, STORAGE_KEYS } from "./storage"
import { filterValid, isEthAddress, isRecord, isStoredToken, type StoredToken } from "./schema"

// ===== Types =====

/**
 * Outcome of a detection call.
 *
 * Matches the `{ ok, value | error }` convention of `lib/portfolio.ts`: on
 * failure, `error` is a complete user-presentable sentence.
 */
export type TokenDetectionResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** One validated ERC-20 holding found by a scan. */
export interface DetectedToken {
  /** Network key the token contract lives on, e.g. `"mainnet"`. */
  networkKey: string
  /** Token contract, normalized to EIP-55 checksum form. */
  address: string
  /** Symbol, control-character-free and length-clamped for display. */
  symbol: string
  /** Name, control-character-free and length-clamped for display. */
  name: string
  /** Decimal places of the token, an integer in [0, 36]. */
  decimals: number
  /** Exact balance in base units. Always greater than zero after filtering. */
  value: bigint
  /** USD price of one whole unit, or null when no usable quote exists. */
  exchangeRate: number | null
  /** USD value of the holding, or null when unpriced. */
  usdValue: number | null
}

/** Result of normalizing one network's payload: the capped list plus honesty about the rest. */
export interface NormalizedTokenBalances {
  /** Ranked, capped tokens — at most {@link MAX_TOKENS_PER_NETWORK}. */
  tokens: DetectedToken[]
  /** Tokens that passed every filter but fell outside the display cap. */
  moreCount: number
}

/** One network's outcome, successful or not. */
export interface NetworkTokenDetection {
  networkKey: string
  networkName: string
  isTestnet: boolean
  status: "ok" | "failed"
  tokens: DetectedToken[]
  moreCount: number
  /** Already-sanitised, user-presentable failure message; empty when ok. */
  error: string
}

/** Everything the discovery card renders for one address after one scan. */
export interface TokenDetectionSnapshot {
  address: string
  /** One entry per scanned network, in registry order. */
  networks: readonly NetworkTokenDetection[]
  /** The subset of {@link networks} that failed, so the UI can name them. */
  failures: readonly NetworkTokenDetection[]
  /** Epoch milliseconds, so the UI can state how fresh the results are. */
  fetchedAt: number
}

/** Outcome of tracking a detected token in the shared token store. */
export type TrackDetectedTokenResult =
  | { ok: true; alreadyTracked: boolean }
  | { ok: false; reason: "invalid" | "cap-reached" | "storage"; error: string }

// ===== Registry =====

/**
 * Public Blockscout-family explorer API bases, keyed by the app's network keys.
 *
 * All bases were verified against the live `api/v2` endpoints. Networks absent
 * from this registry are simply not scanned — custom and other built-in
 * networks degrade to a shorter scan list, never an error.
 */
export const EXPLORER_APIS: Record<string, { base: string }> = {
  mainnet: { base: "https://eth.blockscout.com" },
  polygon: { base: "https://polygon.blockscout.com" },
  arbitrum: { base: "https://arbitrum.blockscout.com" },
  optimism: { base: "https://explorer.optimism.io" },
  sepolia: { base: "https://eth-sepolia.blockscout.com" },
  "base-sepolia": { base: "https://base-sepolia.blockscout.com" },
  "optimism-sepolia": { base: "https://testnet-explorer.optimism.io" },
}

// ===== Limits =====

/**
 * Tokens shown per network after ranking.
 *
 * Popular addresses return thousands of rows (vitalik.eth carries ~8,000 on
 * mainnet), overwhelmingly spam and dust; an uncapped list is unreadable and a
 * privacy leak of its own. The remainder is counted honestly rather than
 * hidden.
 */
export const MAX_TOKENS_PER_NETWORK = 15

/**
 * Upper bound on tracked tokens per network.
 *
 * Mirrors `MAX_TOKENS` in `components/TokenManager.tsx`, which owns the same
 * store; duplicated here because a component module must not be imported into
 * the lib test build. Keep the two values in sync.
 */
const MAX_TRACKED_TOKENS_PER_NETWORK = 50

/*
 * Deadline for one explorer request. This has to absorb the worst case, not
 * the average: a widely-used address returns a multi-megabyte payload (7,000+
 * entries measured for vitalik.eth on mainnet, ~10s of transfer alone on a
 * slow link), and a timeout here renders as zero tokens on a network where
 * the user clearly holds many — worse than a slow scan.
 */
const REQUEST_TIMEOUT_MS = 45_000

/** Hard bound on entries examined per payload, so a hostile blob cannot stall the main thread. */
const MAX_PAYLOAD_ENTRIES = 20_000

/** Display clamp for token symbols (within the 32-char storage guard). */
const MAX_SYMBOL_LENGTH = 16

/** Display clamp for token names (within the 128-char storage guard). */
const MAX_NAME_LENGTH = 64

/** Longest decimal string accepted for a balance, ~uint256 plus slack. */
const MAX_BALANCE_DIGITS = 78

// ===== Field parsers =====

/**
 * Parse a token's decimals, which the API returns as a string.
 *
 * `null`, fractions, negatives, and anything else weird discard the entry
 * rather than defaulting: a wrong decimals value misformats the balance by
 * orders of magnitude, and a silent default would present that guess as fact.
 */
function parseDecimals(raw: unknown): number | null {
  let candidate: number
  if (typeof raw === "number") {
    candidate = raw
  } else if (typeof raw === "string" && /^\d{1,3}$/.test(raw)) {
    candidate = Number(raw)
  } else {
    return null
  }
  return Number.isInteger(candidate) && candidate >= 0 && candidate <= 36 ? candidate : null
}

/**
 * Parse a balance in base units, which the API returns as a string.
 *
 * Strictly digits, no sign, no decimal point: `BigInt` accepts `"1.5"` as a
 * constructor throw at best and a corrupted value at worst, so the shape is
 * checked before conversion. Zero and negative balances are excluded upstream
 * by the caller's `> 0` requirement — an empty holding is not a discovery.
 */
function parseBalance(raw: unknown): bigint | null {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0) return null
    return BigInt(raw)
  }
  if (typeof raw === "string" && raw.length > 0 && raw.length <= MAX_BALANCE_DIGITS) {
    if (!/^\d+$/.test(raw)) return null
    const value = BigInt(raw)
    return value > 0n ? value : null
  }
  return null
}

/**
 * Parse an exchange rate, which the API returns as a string or null.
 *
 * A missing or garbage rate is a missing price, not a failure: the entry stays
 * visible but unvalued, mirroring how `lib/portfolio.ts` treats unquotable
 * assets. Negative and non-finite quotes are likewise treated as absent.
 */
function parseExchangeRate(raw: unknown): number | null {
  let candidate: number
  if (typeof raw === "number") {
    candidate = raw
  } else if (typeof raw === "string" && raw.length <= 64 && /^\d+(\.\d+)?$/.test(raw)) {
    candidate = Number(raw)
  } else {
    return null
  }
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : null
}

/**
 * Clean a free-text field (symbol or name) for display.
 *
 * Explorer-served strings can carry control characters and hostile lengths; a
 * 300-character symbol is discarded data, not a layout problem. Control
 * characters become spaces (a `\\n` inside a name must not break the row),
 * whitespace collapses, and the result is clamped by code points so a
 * multi-byte character is never cut in half. Returns null when nothing
 * displayable remains.
 */
function cleanDisplayText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  if (cleaned === "") return null
  const characters = [...cleaned]
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength).join("")}…`
    : cleaned
}

// ===== Pure normalizer =====

/**
 * Display order for detected tokens.
 *
 * Real money first — largest USD value descending — then unpriced holdings
 * sorted by raw balance magnitude descending: still real, just unvalued, and a
 * big position deserves to outrank dust even without a price. The address is
 * the final tiebreak so the order is deterministic across renders.
 */
function compareDetectedTokens(a: DetectedToken, b: DetectedToken): number {
  const rankA = a.usdValue === null ? 1 : 0
  const rankB = b.usdValue === null ? 1 : 0
  if (rankA !== rankB) return rankA - rankB
  if (rankA === 0) {
    const usdA = a.usdValue ?? 0
    const usdB = b.usdValue ?? 0
    if (usdA !== usdB) return usdB - usdA
  } else if (a.value !== b.value) {
    return a.value > b.value ? -1 : 1
  }
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0
}

/**
 * Normalize one network's `token-balances` payload into a ranked, capped list.
 *
 * This is the security boundary between the explorer and the UI, and it is
 * pure: same payload in, same list out, no network and no storage. The rules,
 * in order:
 *
 * 1. Only `type === "ERC-20"` — the API also returns ERC-721/1155/7984 entries.
 * 2. `reputation !== "spam"` — Blockscout flags the airdrop-advertising majority.
 * 3. A valid `address_hash`, re-checksummed; a non-address discards the entry.
 * 4. Usable `decimals` (see {@link parseDecimals}); garbage discards the entry.
 * 5. A non-null balance greater than zero in base units (see {@link parseBalance}).
 * 6. Displayable `symbol` and `name` (see {@link cleanDisplayText}).
 * 7. Ranked by USD value descending, unpriced after priced, capped at
 *    {@link MAX_TOKENS_PER_NETWORK}, with the remainder counted in `moreCount`
 *    so "and N more" is honest rather than a shrug.
 *
 * A duplicate contract keeps only the larger claimed balance — a hostile
 * payload must not multiply rows for the same token.
 *
 * @param payload - Raw parsed JSON from the explorer. Hostile input.
 * @param networkKey - Network the payload was fetched for; stamped onto tokens
 *   so a detected token can be tracked without the caller re-deriving context.
 * @returns The capped, ranked list and the count of tokens beyond the cap.
 */
export function normalizeTokenBalances(
  payload: unknown,
  networkKey: string
): NormalizedTokenBalances {
  if (!Array.isArray(payload)) return { tokens: [], moreCount: 0 }

  const byAddress = new Map<string, DetectedToken>()

  for (let index = 0; index < payload.length && index < MAX_PAYLOAD_ENTRIES; index++) {
    const entry = payload[index]
    if (!isRecord(entry) || !isRecord(entry.token)) continue
    const raw = entry.token

    if (raw.type !== "ERC-20") continue
    if (raw.reputation === "spam") continue

    if (!isEthAddress(raw.address_hash)) continue
    const address = getAddress(raw.address_hash)

    const decimals = parseDecimals(raw.decimals)
    if (decimals === null) continue

    const value = parseBalance(entry.value)
    if (value === null) continue

    const symbol = cleanDisplayText(raw.symbol, MAX_SYMBOL_LENGTH)
    const name = cleanDisplayText(raw.name, MAX_NAME_LENGTH)
    if (symbol === null || name === null) continue

    const exchangeRate = parseExchangeRate(raw.exchange_rate)
    const usdValue = toFiatValue(value, decimals, exchangeRate)

    const key = address.toLowerCase()
    const previous = byAddress.get(key)
    if (previous !== undefined && previous.value >= value) continue

    byAddress.set(key, {
      networkKey,
      address,
      symbol,
      name,
      decimals,
      value,
      exchangeRate,
      usdValue,
    })
  }

  const ranked = [...byAddress.values()].sort(compareDetectedTokens)
  const tokens = ranked.slice(0, MAX_TOKENS_PER_NETWORK)
  return { tokens, moreCount: ranked.length - tokens.length }
}

// ===== Fetchers =====

/**
 * Detect tokens for one address on one network.
 *
 * Exactly one attempt with a hard deadline: an explorer that accepts the
 * connection but never answers must not pin the scan open. The caller's
 * cancellation signal is relayed into the same controller, mirroring
 * `lib/priceFeed.ts`.
 *
 * @param networkKey - Network key; must exist in {@link EXPLORER_APIS}.
 * @param address - Holder address. Public information.
 * @param signal - Optional cancellation, e.g. an unmount or account switch.
 * @returns The normalized balances, or a user-presentable error.
 */
export async function detectTokensForNetwork(
  networkKey: string,
  address: string,
  signal?: AbortSignal
): Promise<TokenDetectionResult<NormalizedTokenBalances>> {
  const api = EXPLORER_APIS[networkKey]
  if (api === undefined) {
    return { ok: false, error: `Token detection is not available on "${networkKey}".` }
  }
  if (!isEthAddress(address)) {
    return { ok: false, error: "This is not a valid Ethereum address." }
  }

  const networkName = NETWORKS[networkKey]?.name ?? networkKey

  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${api.base}/api/v2/addresses/${address}/token-balances`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })

    if (!response.ok) {
      logger.warn("Explorer rejected the token-balances request", {
        network: networkKey,
        status: response.status,
      })
      return { ok: false, error: `${networkName} did not answer (status ${response.status}).` }
    }

    const payload: unknown = await response.json()
    return { ok: true, value: normalizeTokenBalances(payload, networkKey) }
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: "The scan was cancelled." }
    }
    logger.warn("Token detection request failed", { network: networkKey, error })
    return { ok: false, error: describeError(error, `${networkName} could not be reached.`) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Detect tokens for one address across every network in {@link EXPLORER_APIS}.
 *
 * Each network is fetched and fails independently — one unreachable explorer
 * costs one muted note naming it, never the whole scan, mirroring
 * `getAccountPortfolio`. Only when every network fails is the result an error.
 * Only an address ever crosses this boundary.
 *
 * @param address - Account to scan. Public information.
 * @param signal - Optional cancellation for the whole batch.
 * @returns The per-network snapshot, or a user-presentable error.
 */
export async function detectTokensAcrossNetworks(
  address: string,
  signal?: AbortSignal
): Promise<TokenDetectionResult<TokenDetectionSnapshot>> {
  if (!isEthAddress(address)) {
    return { ok: false, error: "This is not a valid Ethereum address." }
  }

  const keys = Object.keys(EXPLORER_APIS)
  const settled = await Promise.allSettled(
    keys.map((key) => detectTokensForNetwork(key, address, signal))
  )

  // `fetch` cannot un-send a request, so results can still arrive after an
  // abort; report cancellation rather than a partial snapshot.
  if (signal?.aborted) {
    return { ok: false, error: "The scan was cancelled." }
  }

  const networks: NetworkTokenDetection[] = settled.map((outcome, index) => {
    const networkKey = keys[index]
    const config = NETWORKS[networkKey]
    const base = {
      networkKey,
      networkName: config?.name ?? networkKey,
      isTestnet: config?.type === "testnet",
    }

    if (outcome.status === "fulfilled" && outcome.value.ok) {
      return {
        ...base,
        status: "ok" as const,
        tokens: outcome.value.value.tokens,
        moreCount: outcome.value.value.moreCount,
        error: "",
      }
    }

    // `detectTokensForNetwork` never rejects, so a rejection here is a bug;
    // degrade to a generic per-network failure rather than crashing the card.
    const error =
      outcome.status === "fulfilled" && !outcome.value.ok
        ? outcome.value.error
        : "The scan failed unexpectedly."
    logger.warn("Token detection failed for a network", { network: networkKey })
    return { ...base, status: "failed" as const, tokens: [], moreCount: 0, error }
  })

  const failures = networks.filter((network) => network.status === "failed")
  if (failures.length === networks.length) {
    return { ok: false, error: `Could not reach any explorer. ${failures[0].error}` }
  }

  return {
    ok: true,
    value: { address, networks, failures, fetchedAt: Date.now() },
  }
}

// ===== Tracking integration =====

/**
 * Add a detected token to the shared tracked-token store.
 *
 * Writes exactly the shape `components/TokenManager.tsx` persists —
 * `readJson`/`writeJson` under `STORAGE_KEYS.TOKENS`, validated through
 * `isStoredToken`, merged with the other networks' tokens rather than
 * overwriting them — so the existing manager picks the token up on its next
 * read with no new code paths. The per-network cap is enforced here rather
 * than in the UI: a limit that lives only in one writer is not a limit.
 *
 * @param token - A token produced by {@link normalizeTokenBalances}.
 * @returns Whether the token is now (or was already) tracked, or why not.
 */
export function trackDetectedToken(token: DetectedToken): TrackDetectedTokenResult {
  const stored: StoredToken = {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    network: token.networkKey,
  }

  // Last line before persistence: re-check with the storage guard instead of
  // trusting that the caller passed a normalizer-produced token.
  if (!isStoredToken(stored)) {
    return { ok: false, reason: "invalid", error: "That token could not be saved." }
  }

  const all = filterValid(
    readJson<unknown>(STORAGE_KEYS.TOKENS, (value): value is unknown => true, []),
    isStoredToken,
    MAX_TRACKED_TOKENS_PER_NETWORK * 4
  )

  const lower = stored.address.toLowerCase()
  if (
    all.some(
      (existing) => existing.network === stored.network && existing.address.toLowerCase() === lower
    )
  ) {
    return { ok: true, alreadyTracked: true }
  }

  const sameNetwork = all.filter((existing) => existing.network === stored.network)
  if (sameNetwork.length >= MAX_TRACKED_TOKENS_PER_NETWORK) {
    return {
      ok: false,
      reason: "cap-reached",
      error: `You can track at most ${MAX_TRACKED_TOKENS_PER_NETWORK} tokens per network.`,
    }
  }

  const result = writeJson(STORAGE_KEYS.TOKENS, [...all, stored])
  if (!result.ok) {
    return { ok: false, reason: "storage", error: result.error }
  }
  return { ok: true, alreadyTracked: false }
}
