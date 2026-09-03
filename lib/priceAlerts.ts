/**
 * One-shot price and gas alerts: pure evaluators, threshold validation, and an
 * id helper. No timers and no network calls live here.
 *
 * The split mirrors `lib/gasTracker.ts` and `lib/ens.ts`: every rule that
 * decides *when an alert fires* is a pure function of (alert, reading), so the
 * boundary behaviour is unit-testable with plain numbers — no network, no
 * mocks, no flakiness. `components/PriceAlertsCard.tsx` owns the polling that
 * feeds readings in; the lib never needs to know a clock exists.
 *
 * Thresholds are deliberately **inclusive** (`>=` for above, `<=` for below).
 * Prices and gas flash through a level for a single poll tick all the time, and
 * a strict comparison would silently not fire on an exact touch — for a one-shot
 * alert that the user then has to notice, missing "gas hit exactly 10" is worse
 * than firing a moment early.
 */

// ===== Types =====

/** The two directional price alert kinds. */
export type PriceAlertKind = "price-above" | "price-below"

/** The single gas alert kind. */
export type GasAlertKind = "gas-below"

/**
 * A one-shot alert on a native asset's USD price.
 *
 * `assetCoinId` (a CoinGecko id resolved through `lib/priceFeed`, never
 * hand-typed) is what the poller fetches; `assetSymbol` is carried along so the
 * evaluator and its UI can name the asset without a second lookup.
 */
export interface PriceAlert {
  id: string
  kind: PriceAlertKind
  /** Display symbol, e.g. `ETH`. */
  assetSymbol: string
  /** CoinGecko coin id, e.g. `ethereum`. */
  assetCoinId: string
  /** USD price the alert fires at (inclusive). */
  thresholdUsd: number
}

/** A one-shot alert on mainnet's standard gas tier, in gwei. */
export interface GasAlert {
  id: string
  kind: GasAlertKind
  /** Gwei level the alert fires at or below (inclusive). */
  thresholdGwei: number
}

/** Any alert the card can hold. Discriminated on `kind`. */
export type WalletAlert = PriceAlert | GasAlert

/** Why an evaluation did or did not fire. */
export type AlertEvaluationStatus = "fired" | "waiting" | "no-data"

/** Outcome of evaluating one alert against one reading. */
export interface AlertEvaluation {
  fired: boolean
  /** `fired` crossed the threshold; `waiting` has not; `no-data` could not be judged. */
  status: AlertEvaluationStatus
}

// ===== Evaluators =====

/**
 * Evaluate a price alert against a spot price.
 *
 * Total: a missing (`null`), non-finite, or non-positive price reads as
 * `no-data` rather than as "not fired", because the difference matters to the
 * UI — "waiting" promises the user a check is happening, while a failed price
 * fetch should be shown as unavailable, not as calm. An alert whose own
 * threshold is not a positive finite number is corrupt and gets the same
 * treatment: it must never fire on garbage.
 *
 * @param alert - The alert to evaluate.
 * @param spotPrice - Current USD price, or null when no quote is available.
 */
export function evaluatePriceAlert(alert: PriceAlert, spotPrice: number | null): AlertEvaluation {
  if (
    typeof alert.thresholdUsd !== "number" ||
    !Number.isFinite(alert.thresholdUsd) ||
    alert.thresholdUsd <= 0
  ) {
    return { fired: false, status: "no-data" }
  }
  if (spotPrice === null || !Number.isFinite(spotPrice) || spotPrice <= 0) {
    return { fired: false, status: "no-data" }
  }
  if (alert.kind === "price-above") {
    return spotPrice >= alert.thresholdUsd
      ? { fired: true, status: "fired" }
      : { fired: false, status: "waiting" }
  }
  return spotPrice <= alert.thresholdUsd
    ? { fired: true, status: "fired" }
    : { fired: false, status: "waiting" }
}

/**
 * Evaluate a gas alert against a gwei reading.
 *
 * Same totality rules as {@link evaluatePriceAlert}: a null, non-finite, or
 * negative reading is `no-data`, never a silent "not fired".
 *
 * @param alert - The alert to evaluate.
 * @param gwei - Current standard-tier gas price in gwei, or null when unavailable.
 */
export function evaluateGasAlert(alert: GasAlert, gwei: number | null): AlertEvaluation {
  if (
    typeof alert.thresholdGwei !== "number" ||
    !Number.isFinite(alert.thresholdGwei) ||
    alert.thresholdGwei <= 0
  ) {
    return { fired: false, status: "no-data" }
  }
  if (gwei === null || !Number.isFinite(gwei) || gwei < 0) {
    return { fired: false, status: "no-data" }
  }
  return gwei <= alert.thresholdGwei
    ? { fired: true, status: "fired" }
    : { fired: false, status: "waiting" }
}

// ===== Threshold validation =====

/**
 * Upper bound on a USD price threshold.
 *
 * No chartable asset in this app has traded within two orders of magnitude of
 * this, so a value past it is a typo (a wei amount pasted as dollars) or
 * hostility — both should be rejected at the form, not discovered as an alert
 * that can never fire.
 */
export const MAX_PRICE_THRESHOLD_USD = 1_000_000

/**
 * Upper bound on a gas threshold in gwei.
 *
 * Mainnet's standard tier has only briefly spiked past low thousands of gwei in
 * history; anything beyond this is the same typo-or-hostility case as the price
 * cap, and an alert waiting for gas *above* thousands of gwei would be noise.
 */
export const MAX_GAS_THRESHOLD_GWEI = 5_000

/** Outcome of validating a raw threshold string from the form. */
export type ThresholdValidation = { ok: true; value: number } | { ok: false; error: string }

/**
 * Parse a threshold string the way the form means it.
 *
 * Accepts plain decimals only (`3000`, `12.5`) — no sign, no exponent, no
 * thousands separators — because every alternative reading ("1e3", "-5", "3,0")
 * is a value the user almost certainly did not intend to arm a one-shot alert
 * with. Whitespace is tolerated since it is invisible, not meaningful.
 *
 * @param raw - Raw input value.
 * @returns The positive finite number, or null when unparseable.
 */
function parseThresholdNumber(raw: string): number | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Validate a USD price threshold from the form.
 *
 * Pure so the caps are testable; the component just renders the error.
 *
 * @param raw - Raw input value.
 */
export function validatePriceThresholdUsd(raw: string): ThresholdValidation {
  const parsed = parseThresholdNumber(raw)
  if (parsed === null) {
    return { ok: false, error: "Enter a price greater than 0." }
  }
  if (parsed > MAX_PRICE_THRESHOLD_USD) {
    return { ok: false, error: `Enter a threshold of $${MAX_PRICE_THRESHOLD_USD.toLocaleString()} or less.` }
  }
  return { ok: true, value: parsed }
}

/**
 * Validate a gas threshold from the form.
 *
 * @param raw - Raw input value, in gwei.
 */
export function validateGasThresholdGwei(raw: string): ThresholdValidation {
  const parsed = parseThresholdNumber(raw)
  if (parsed === null) {
    return { ok: false, error: "Enter a gas price greater than 0 gwei." }
  }
  if (parsed > MAX_GAS_THRESHOLD_GWEI) {
    return { ok: false, error: `Enter a threshold of ${MAX_GAS_THRESHOLD_GWEI.toLocaleString()} gwei or less.` }
  }
  return { ok: true, value: parsed }
}

// ===== Ids =====

/**
 * Generate an alert id.
 *
 * Prefers the platform UUID and falls back to time-plus-random, exactly like
 * `lib/bookmarks.createId`, so ids are unique without a counter the lib would
 * have to own (and which would make the lib stateful for no benefit).
 */
export function nextAlertId(): string {
  const platformCrypto = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto
  if (platformCrypto !== undefined && typeof platformCrypto.randomUUID === "function") {
    return platformCrypto.randomUUID()
  }
  return `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
