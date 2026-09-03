/**
 * Chain metadata lookup for the custom-RPC form.
 *
 * When a user adds a custom network they usually know the RPC URL and nothing
 * else. The chain id that the RPC itself reports is authoritative, and the
 * public, keyless chainid.network dataset (the community "chains" registry,
 * ~2,700 entries) maps that id to a human name, native currency, decimals and
 * explorers. Fetching it turns six error-prone text fields into a review of
 * prefilled values.
 *
 * The dataset is METADATA, not truth: entries are community-maintained, so
 * every field is defensively validated before it is offered to the form, and
 * the user can always edit what was prefilled. Nothing here bypasses the
 * existing save-time validation in lib/schema.ts.
 */

import { logger } from "./logger"

/** Metadata offered to the custom-RPC form. */
export interface ChainMetadata {
  name: string
  currencySymbol: string
  currencyName: string | null
  decimals: number | null
  explorerUrl: string
}

export type ChainMetadataResult =
  | { ok: true; value: ChainMetadata | null }
  | { ok: false; error: string }

/** The dataset is ~1.2 MB; one fetch per session is plenty. */
const CHAIN_LIST_URL = "https://chainid.network/chains.json"
const REQUEST_TIMEOUT_MS = 15_000
/** Sanity bound on the response: the real list is ~1.2 MB, not 100 MB. */
const MAX_CHAIN_LIST_BYTES = 8 * 1024 * 1024

interface ChainListEntry {
  chainId?: number
  name?: unknown
  nativeCurrency?: {
    name?: unknown
    symbol?: unknown
    decimals?: unknown
  }
  explorers?: { url?: unknown }[]
}

/**
 * Parsed chain list, cached for the session. `null` means "not fetched yet";
 * a failed fetch is negatively cached until the user retries (the form's
 * fetch button re-runs on demand, so the cache is deliberately retryable
 * rather than sticky — see {@link fetchChainMetadata}).
 */
let chainListCache: ChainListEntry[] | null = null

/**
 * Normalise one raw chain-list entry into metadata, or `null` when the entry
 * is unusable. Pure and hostile-input safe: every field is validated
 * independently, and a missing optional field (decimals, explorer) does not
 * discard the rest. Exported for unit tests.
 */
export function normalizeChainEntry(entry: ChainListEntry): ChainMetadata | null {
  if (typeof entry.chainId !== "number" || !Number.isSafeInteger(entry.chainId)) return null

  let name = ""
  if (typeof entry.name === "string") {
    const trimmed = entry.name.trim()
    if (trimmed.length > 0 && trimmed.length <= 64) name = trimmed
  }

  let currencySymbol = ""
  let currencyName: string | null = null
  let decimals: number | null = null
  if (typeof entry.nativeCurrency === "object" && entry.nativeCurrency !== null) {
    const currency = entry.nativeCurrency
    if (
      typeof currency.symbol === "string" &&
      currency.symbol.trim().length > 0 &&
      currency.symbol.trim().length <= 16
    ) {
      currencySymbol = currency.symbol.trim()
    }
    if (typeof currency.name === "string" && currency.name.trim().length <= 32) {
      currencyName = currency.name.trim()
    }
    if (
      typeof currency.decimals === "number" &&
      Number.isInteger(currency.decimals) &&
      currency.decimals >= 0 &&
      currency.decimals <= 36
    ) {
      decimals = currency.decimals
    }
  }

  let explorerUrl = ""
  if (Array.isArray(entry.explorers)) {
    const first = entry.explorers.find(
      (candidate) =>
        typeof candidate?.url === "string" && candidate.url.startsWith("https://")
    )
    if (first && typeof first.url === "string") {
      const candidate = first.url.replace(/\/+$/, "")
      if (candidate.length <= 200) explorerUrl = candidate
    }
  }

  // A name or a symbol is the minimum worth prefilling; an entry with neither
  // would leave the form exactly as it was.
  if (name === "" && currencySymbol === "") return null

  return { name, currencySymbol, currencyName, decimals, explorerUrl }
}

/** Parse the raw dataset defensively. Exported for unit tests. */
export function parseChainList(payload: unknown): ChainListEntry[] | null {
  if (!Array.isArray(payload)) return null
  if (payload.length > 20_000) return null
  return payload.filter(
    (entry): entry is ChainListEntry => typeof entry === "object" && entry !== null
  )
}

/**
 * Look up metadata for a chain id from the public registry.
 *
 * Never throws. `ok: true, value: null` means the RPC answered with a chain
 * id that simply is not in the registry — the form shows "fill it in
 * manually", which is honest, not an error. `ok: false` is reserved for the
 * registry being unreachable, where a retry makes sense.
 *
 * @param chainId - The chain id the RPC itself reported (authoritative).
 */
export async function fetchChainMetadata(chainId: number): Promise<ChainMetadataResult> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    return { ok: false, error: "The RPC reported an unusable chain id." }
  }

  if (chainListCache === null) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(CHAIN_LIST_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
      if (!response.ok) {
        logger.warn("Chain list request failed", { status: response.status })
        return { ok: false, error: "The chain registry is unavailable right now. Try again shortly." }
      }

      const text = await response.text()
      if (text.length > MAX_CHAIN_LIST_BYTES) {
        logger.warn("Chain list response exceeded the size bound", { bytes: text.length })
        return { ok: false, error: "The chain registry returned an unexpectedly large response." }
      }

      const parsed = parseChainList(JSON.parse(text) as unknown)
      if (parsed === null) {
        logger.warn("Chain list response was not the expected shape")
        return { ok: false, error: "The chain registry returned data in an unexpected format." }
      }
      chainListCache = parsed
    } catch (error) {
      // Not negatively cached: the fetch is user-triggered (the form's
      // button), so the next click is a legitimate retry — a sticky failure
      // would wedge the form until a page reload.
      logger.warn("Chain list fetch failed", { error })
      return {
        ok: false,
        error: "Could not reach the chain registry. Check your connection and try again.",
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const entries = chainListCache
  if (entries === null) {
    // Unreachable: the block above assigns or returns.
    return { ok: false, error: "The chain registry is unavailable right now." }
  }

  // The registry occasionally contains duplicate chain ids; the first entry
  // with a usable normalisation wins, matching how the registry is ordered
  // (curated entries first).
  for (const entry of entries) {
    if (entry.chainId !== chainId) continue
    const metadata = normalizeChainEntry(entry)
    if (metadata !== null) return { ok: true, value: metadata }
  }
  return { ok: true, value: null }
}

/** Test helper: reset the module caches between test cases. */
export function clearChainMetadataCache(): void {
  chainListCache = null
}
