/**
 * Value formatting for balances and fiat amounts.
 *
 * Rule for this module: token amounts are `bigint` base units and are only ever
 * converted to a string for display. Routing a balance through `parseFloat` or
 * `Number` loses precision, and rounding one *up* can show a user more funds
 * than they hold, so every truncation here rounds toward zero.
 */

import { formatUnits, parseUnits } from "ethers"

/** Placeholder shown when a value is genuinely unknown, not zero. */
export const UNKNOWN_VALUE = "—"

/** Fraction digits kept for sub-1 balances before falling back to a marker. */
const DUST_FRACTION_DIGITS = 8

/** Shown for a non-zero balance too small to render at the display precision. */
export const DUST_MARKER = "<0.00000001"

/**
 * Format a base-unit amount as a decimal string, truncating extra digits.
 *
 * @param value - Amount in base units (wei for an 18-decimal asset).
 * @param decimals - Decimal places of the asset.
 * @param maxFractionDigits - Fraction digits to keep. Omit to keep all of them.
 * @returns Decimal string with no thousands separators and no trailing dot.
 */
export function formatTokenAmount(
  value: bigint,
  decimals: number,
  maxFractionDigits?: number
): string {
  const full = formatUnits(value, decimals)
  if (maxFractionDigits === undefined) return full

  const dot = full.indexOf(".")
  if (dot === -1) return full
  if (maxFractionDigits <= 0) return full.slice(0, dot)

  const truncated = full.slice(0, dot + 1 + maxFractionDigits)
  // Drop a trailing dot left behind when the fraction was entirely cut.
  return truncated.endsWith(".") ? truncated.slice(0, -1) : truncated
}

/**
 * Format a balance for a compact list row.
 *
 * Small non-zero balances keep more digits so dust never renders as a flat
 * zero, which would be indistinguishable from an empty account. Amounts below
 * the display precision collapse to a "less than" marker rather than "0".
 *
 * @param value - Amount in base units.
 * @param decimals - Decimal places of the asset.
 */
export function formatBalanceForDisplay(value: bigint, decimals: number): string {
  if (value === 0n) return "0"

  const whole = value / 10n ** BigInt(decimals)
  if (whole > 0n) return formatTokenAmount(value, decimals, 5)

  // Sub-1 balance: decide against exact base units, never a formatted string.
  if (decimals > DUST_FRACTION_DIGITS) {
    const smallestShown = 10n ** BigInt(decimals - DUST_FRACTION_DIGITS)
    if (value < smallestShown) return DUST_MARKER
  }
  return formatTokenAmount(value, decimals, DUST_FRACTION_DIGITS)
}

/**
 * Whether an amount is non-zero, decided on exact base units.
 *
 * Never derive a "can send" decision from a formatted string: a truncated
 * display value of "0.00000" would disable sending for an account that holds
 * spendable dust.
 *
 * @param value - Amount in base units.
 */
export function isNonZeroAmount(value: bigint): boolean {
  return value > 0n
}

/**
 * Parse a user-entered decimal amount into base units.
 *
 * @param input - Raw text from an amount field.
 * @param decimals - Decimal places of the target asset.
 * @returns Base units, or a user-presentable error.
 */
export function parseAmount(
  input: string,
  decimals: number
): { ok: true; value: bigint } | { ok: false; error: string } {
  const trimmed = input.trim()
  if (trimmed === "") return { ok: false, error: "Enter an amount." }
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") {
    return { ok: false, error: "Enter a plain decimal number, for example 0.25." }
  }

  const dot = trimmed.indexOf(".")
  if (dot !== -1 && trimmed.length - dot - 1 > decimals) {
    return {
      ok: false,
      error: `This asset supports at most ${decimals} decimal places.`,
    }
  }

  try {
    const value = parseUnits(trimmed, decimals)
    if (value <= 0n) return { ok: false, error: "Amount must be greater than zero." }
    return { ok: true, value }
  } catch {
    return { ok: false, error: "Enter a valid amount." }
  }
}

/**
 * Format a fiat amount using the user's locale.
 *
 * @param amount - Fiat value, or null when the price is unknown.
 * @param currency - ISO 4217 currency code.
 */
export function formatFiat(amount: number | null, currency = "USD"): string {
  if (amount === null || !Number.isFinite(amount)) return UNKNOWN_VALUE

  // Very small amounts need extra digits or they collapse to $0.00.
  const fractionDigits = amount !== 0 && Math.abs(amount) < 0.01 ? 6 : 2

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: fractionDigits,
    }).format(amount)
  } catch {
    return `${amount.toFixed(fractionDigits)} ${currency}`
  }
}

/**
 * Convert a base-unit balance to a fiat amount.
 *
 * The multiplication happens in floating point because the price itself is a
 * float, but the balance is first reduced to a bounded-precision decimal so the
 * conversion cannot overflow to `Infinity` on a very large holding. The result
 * is for display only and must never be fed back into transaction math.
 *
 * @param value - Amount in base units.
 * @param decimals - Decimal places of the asset.
 * @param unitPrice - Fiat price per whole unit, or null if unknown.
 */
export function toFiatValue(
  value: bigint,
  decimals: number,
  unitPrice: number | null
): number | null {
  if (unitPrice === null || !Number.isFinite(unitPrice)) return null
  if (value === 0n) return 0

  const asDecimal = Number(formatTokenAmount(value, decimals, 18))
  if (!Number.isFinite(asDecimal)) return null

  const fiat = asDecimal * unitPrice
  return Number.isFinite(fiat) ? fiat : null
}

/**
 * Shorten a hex string for display, keeping both ends recognizable.
 *
 * @param value - Address or hash.
 * @param lead - Leading characters to keep, including `0x`.
 * @param tail - Trailing characters to keep.
 */
export function truncateHex(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value
  return `${value.slice(0, lead)}…${value.slice(-tail)}`
}

/**
 * Format a millisecond timestamp using the user's locale.
 *
 * Locale-dependent output differs between server and client, so only call this
 * from client components.
 *
 * @param timestamp - Milliseconds since the Unix epoch.
 */
export function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return UNKNOWN_VALUE
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return UNKNOWN_VALUE
  }
}

/**
 * Format a duration as a compact relative label, for example "3m ago".
 *
 * @param timestamp - Milliseconds since the Unix epoch.
 * @param now - Reference time, injectable for deterministic tests.
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return UNKNOWN_VALUE

  const seconds = Math.floor((now - timestamp) / 1000)
  if (seconds < 0) return "just now"
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
