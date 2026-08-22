/**
 * Bigint-exact Ethereum unit conversion.
 *
 * Every amount in this module is carried as a `bigint`, so no intermediate step
 * can lose precision. `parseFloat` and `Number` are never applied to a value:
 * `Number` is only ever used to validate small integer *counts* such as a
 * decimal precision.
 *
 * Formatting always truncates towards zero and never rounds up. Rounding up
 * would display more funds than the user actually holds, which is a real bug in
 * a wallet context.
 *
 * This is a leaf module with no imports.
 */

/**
 * Outcome of an operation that can legitimately fail because of user input.
 *
 * On failure, `error` is a complete, user-presentable English sentence.
 */
export type UnitResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Canonical names of the standard Ethereum denominations. */
export type UnitName = "wei" | "kwei" | "mwei" | "gwei" | "szabo" | "finney" | "ether"

/** A named denomination and the number of decimal places it has relative to wei. */
export interface UnitPreset {
  /** Canonical lowercase unit name. */
  readonly name: UnitName
  /** Decimal exponent relative to wei, e.g. 9 for gwei and 18 for ether. */
  readonly decimals: number
}

/**
 * Lookup table of the standard Ethereum denominations keyed by canonical name.
 *
 * The decimal exponent is expressed relative to wei, so `wei` is 0 and
 * `ether` is 18.
 */
export const UNIT_PRESETS: Readonly<Record<UnitName, UnitPreset>> = {
  wei: { name: "wei", decimals: 0 },
  kwei: { name: "kwei", decimals: 3 },
  mwei: { name: "mwei", decimals: 6 },
  gwei: { name: "gwei", decimals: 9 },
  szabo: { name: "szabo", decimals: 12 },
  finney: { name: "finney", decimals: 15 },
  ether: { name: "ether", decimals: 18 },
}

/**
 * The preset unit names in ascending order of magnitude.
 *
 * Use this rather than `Object.keys(UNIT_PRESETS)` when the display order of a
 * picker matters.
 */
export const UNIT_NAMES: readonly UnitName[] = [
  "wei",
  "kwei",
  "mwei",
  "gwei",
  "szabo",
  "finney",
  "ether",
]

/** Smallest decimal precision this module accepts. */
export const MIN_DECIMALS = 0

/**
 * Largest decimal precision this module accepts.
 *
 * 36 comfortably covers every real ERC-20 token while keeping the scaling
 * factor bounded.
 */
export const MAX_DECIMALS = 36

/**
 * Narrow an untrusted string to a preset unit name.
 *
 * @param value - Candidate unit name, typically read from a URL or a form
 * @returns True when `value` is one of the canonical preset names
 */
export function isUnitName(value: string): value is UnitName {
  return UNIT_NAMES.some((name) => name === value)
}

/**
 * Test whether a decimal precision is supported.
 *
 * @param decimals - Candidate precision
 * @returns True when `decimals` is an integer between {@link MIN_DECIMALS} and {@link MAX_DECIMALS} inclusive
 */
export function isSupportedDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= MIN_DECIMALS && decimals <= MAX_DECIMALS
}

/**
 * Look up the decimal exponent of a preset unit.
 *
 * @param unit - A canonical preset unit name
 * @returns The unit's decimal exponent relative to wei
 */
export function getUnitDecimals(unit: UnitName): number {
  return UNIT_PRESETS[unit].decimals
}

/** Options controlling how a human decimal string is parsed. */
export interface ParseDecimalOptions {
  /**
   * Accept a leading `-` and return a negative `bigint`.
   *
   * Defaults to false, because a negative token balance is almost always a
   * typo rather than an intent.
   */
  allowNegative?: boolean
}

/** Options controlling how a `bigint` is rendered as a decimal string. */
export interface FormatDecimalOptions {
  /**
   * Maximum number of fraction digits to render.
   *
   * Surplus digits are discarded, never rounded up, so the rendered value is
   * always less than or equal to the true value in magnitude. Omit for full
   * precision.
   */
  maxFractionDigits?: number
  /**
   * Remove trailing zeros from the fraction, so `1.500` renders as `1.5` and
   * `1.000` renders as `1`. Defaults to true.
   */
  trimTrailingZeros?: boolean
}

/** Result of reinterpreting a `bigint` at a different decimal precision. */
export interface DecimalConversion {
  /** The value re-scaled to the target precision, truncated towards zero. */
  value: bigint
  /** True when at least one non-zero digit had to be discarded. */
  truncated: boolean
  /**
   * The digits that were discarded, still expressed at the source precision.
   *
   * Zero whenever `truncated` is false.
   */
  remainder: bigint
  /** How many decimal places were dropped; zero when widening the precision. */
  discardedDigits: number
}

/** Result of converting an amount between two named units. */
export interface UnitConversion {
  /** The amount in the target unit, rendered with the caller's format options. */
  value: string
  /** The amount in the target unit at full precision, with trailing zeros trimmed. */
  exact: string
  /** The exact amount in wei that the input represents. */
  wei: bigint
  /** True when `maxFractionDigits` forced digits to be dropped from `value`. */
  truncated: boolean
}

/** Options accepted by {@link convertUnits}, combining the parse and format options. */
export interface ConvertUnitsOptions extends ParseDecimalOptions, FormatDecimalOptions {}

/**
 * Parse a human decimal string into a `bigint` scaled by `decimals`.
 *
 * Accepts an optional sign, an optional integer part, an optional single
 * decimal point and an optional fraction part, e.g. `"1.5"`, `".5"`, `"5."` and
 * `"0"`. Surrounding whitespace is trimmed; whitespace anywhere else is
 * rejected. Exponent notation such as `"1e18"` and digit separators such as
 * `"1_000"` are rejected.
 *
 * Fraction digits are never silently discarded: a value with more fraction
 * digits than `decimals` can represent is an error, so `"0.0000000000000000001"`
 * at 18 decimals fails rather than quietly becoming `0`.
 *
 * @param input - The decimal string to parse
 * @param decimals - Decimal precision to scale by, between {@link MIN_DECIMALS} and {@link MAX_DECIMALS}
 * @param options - Optional parse behaviour; see {@link ParseDecimalOptions}
 * @returns The scaled `bigint`, or a failure carrying a user-presentable message
 */
export function parseDecimal(
  input: string,
  decimals: number,
  options: ParseDecimalOptions = {}
): UnitResult<bigint> {
  const decimalsError = describeInvalidDecimals(decimals, "decimals")
  if (decimalsError !== null) {
    return { ok: false, error: decimalsError }
  }

  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter an amount." }
  }

  let body = trimmed
  let isNegative = false
  if (body.startsWith("+")) {
    body = body.slice(1)
  } else if (body.startsWith("-")) {
    isNegative = true
    body = body.slice(1)
  }

  if (body.length === 0) {
    return { ok: false, error: "Enter an amount after the sign." }
  }
  if (isNegative && options.allowNegative !== true) {
    return { ok: false, error: "Negative amounts are not allowed." }
  }

  const firstDot = body.indexOf(".")
  if (firstDot !== body.lastIndexOf(".")) {
    return { ok: false, error: "An amount may contain at most one decimal point." }
  }

  const whole = firstDot === -1 ? body : body.slice(0, firstDot)
  const fraction = firstDot === -1 ? "" : body.slice(firstDot + 1)

  if (whole.length === 0 && fraction.length === 0) {
    return { ok: false, error: "Enter an amount; a lone decimal point is not a number." }
  }
  if (!isDigitsOnly(whole) || !isDigitsOnly(fraction)) {
    return {
      ok: false,
      error: "An amount may only contain the digits 0-9, one optional decimal point and an optional leading sign.",
    }
  }
  if (fraction.length > decimals) {
    return { ok: false, error: describeExcessFractionDigits(fraction.length, decimals) }
  }

  const magnitude = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`)
  return { ok: true, value: isNegative ? -magnitude : magnitude }
}

/**
 * Render a `bigint` as a decimal string at the given precision.
 *
 * Surplus fraction digits are truncated towards zero, never rounded up, so the
 * rendered magnitude never exceeds the true magnitude. A value whose visible
 * digits are all zero renders as `"0"` rather than `"-0"`.
 *
 * `decimals` and `maxFractionDigits` describe the caller's own data rather than
 * user input, so an invalid precision is treated as a programmer error.
 *
 * @param value - The scaled amount
 * @param decimals - Decimal precision `value` is scaled by
 * @param options - Optional format behaviour; see {@link FormatDecimalOptions}
 * @returns The decimal string
 * @throws {RangeError} If `decimals` is outside the supported range, or `maxFractionDigits` is not a non-negative integer
 */
export function formatDecimal(
  value: bigint,
  decimals: number,
  options: FormatDecimalOptions = {}
): string {
  const decimalsError = describeInvalidDecimals(decimals, "decimals")
  if (decimalsError !== null) {
    throw new RangeError(decimalsError)
  }

  const { maxFractionDigits, trimTrailingZeros = true } = options
  if (
    maxFractionDigits !== undefined &&
    (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 0)
  ) {
    throw new RangeError("maxFractionDigits must be a non-negative integer.")
  }

  const isNegative = value < 0n
  const magnitude = isNegative ? -value : value
  const scale = 10n ** BigInt(decimals)
  const whole = magnitude / scale

  let fraction = decimals === 0 ? "" : (magnitude % scale).toString().padStart(decimals, "0")
  if (maxFractionDigits !== undefined && maxFractionDigits < fraction.length) {
    fraction = fraction.slice(0, maxFractionDigits)
  }
  if (trimTrailingZeros) {
    fraction = fraction.replace(/0+$/, "")
  }

  const rendered = fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`
  const rendersAsZero = whole === 0n && !/[1-9]/.test(fraction)
  return isNegative && !rendersAsZero ? `-${rendered}` : rendered
}

/**
 * Reinterpret a scaled `bigint` at a different decimal precision.
 *
 * Widening the precision is exact. Narrowing it discards the surplus low-order
 * digits, truncating towards zero; the outcome reports whether anything was
 * lost and what it was, so a caller can refuse to proceed.
 *
 * @param value - The scaled amount
 * @param fromDecimals - Precision `value` is currently scaled by
 * @param toDecimals - Precision to convert to
 * @returns The conversion outcome, or a failure carrying a user-presentable message
 */
export function convertDecimals(
  value: bigint,
  fromDecimals: number,
  toDecimals: number
): UnitResult<DecimalConversion> {
  const fromError = describeInvalidDecimals(fromDecimals, "source decimals")
  if (fromError !== null) {
    return { ok: false, error: fromError }
  }
  const toError = describeInvalidDecimals(toDecimals, "target decimals")
  if (toError !== null) {
    return { ok: false, error: toError }
  }

  if (toDecimals >= fromDecimals) {
    const scale = 10n ** BigInt(toDecimals - fromDecimals)
    return {
      ok: true,
      value: { value: value * scale, truncated: false, remainder: 0n, discardedDigits: 0 },
    }
  }

  const discardedDigits = fromDecimals - toDecimals
  const scale = 10n ** BigInt(discardedDigits)
  const remainder = value % scale
  return {
    ok: true,
    value: {
      value: value / scale,
      truncated: remainder !== 0n,
      remainder,
      discardedDigits,
    },
  }
}

/**
 * Parse a human decimal string written in `unit` into an exact wei amount.
 *
 * `parseUnit("1.5", "gwei")` returns `1500000000n` wei.
 *
 * @param input - The decimal string to parse
 * @param unit - The unit `input` is written in
 * @param options - Optional parse behaviour; see {@link ParseDecimalOptions}
 * @returns The amount in wei, or a failure carrying a user-presentable message
 */
export function parseUnit(
  input: string,
  unit: UnitName,
  options: ParseDecimalOptions = {}
): UnitResult<bigint> {
  return parseDecimal(input, getUnitDecimals(unit), options)
}

/**
 * Render an exact wei amount as a decimal string in `unit`.
 *
 * Truncates rather than rounds up; see {@link formatDecimal}.
 *
 * @param wei - The amount in wei
 * @param unit - The unit to render in
 * @param options - Optional format behaviour; see {@link FormatDecimalOptions}
 * @returns The decimal string
 * @throws {RangeError} If `maxFractionDigits` is not a non-negative integer
 */
export function formatUnit(
  wei: bigint,
  unit: UnitName,
  options: FormatDecimalOptions = {}
): string {
  return formatDecimal(wei, getUnitDecimals(unit), options)
}

/**
 * Convert an amount between two named units without floating point.
 *
 * Every preset unit is a power of ten of wei, so the conversion itself is
 * always exact: the input is parsed to wei and re-rendered in the target unit.
 * Digits are only ever lost if the caller passes `maxFractionDigits`, and the
 * outcome reports that via {@link UnitConversion.truncated} alongside the
 * full-precision `exact` string.
 *
 * An amount that is not a whole number of wei, such as `"0.5"` wei, is rejected
 * rather than truncated.
 *
 * @param input - The decimal string to convert
 * @param from - The unit `input` is written in
 * @param to - The unit to convert to
 * @param options - Optional parse and format behaviour; see {@link ConvertUnitsOptions}
 * @returns The conversion outcome, or a failure carrying a user-presentable message
 */
export function convertUnits(
  input: string,
  from: UnitName,
  to: UnitName,
  options: ConvertUnitsOptions = {}
): UnitResult<UnitConversion> {
  const parsed = parseUnit(input, from, options)
  if (!parsed.ok) {
    return parsed
  }

  const wei = parsed.value
  const targetDecimals = getUnitDecimals(to)
  const exact = formatDecimal(wei, targetDecimals)
  const value = formatDecimal(wei, targetDecimals, options)
  const { maxFractionDigits } = options
  const truncated =
    maxFractionDigits !== undefined && countFractionDigits(exact) > maxFractionDigits

  return { ok: true, value: { value, exact, wei, truncated } }
}

/**
 * Count the fraction digits in a decimal string produced by {@link formatDecimal}.
 *
 * @param rendered - A decimal string
 * @returns The number of digits after the decimal point, or 0 when there is none
 */
export function countFractionDigits(rendered: string): number {
  const dotIndex = rendered.indexOf(".")
  return dotIndex === -1 ? 0 : rendered.length - dotIndex - 1
}

/**
 * Test whether a string consists only of the digits 0-9.
 *
 * The empty string counts as digits-only, because both the integer and the
 * fraction part of a decimal literal may be omitted.
 *
 * @param value - The string to test
 * @returns True when `value` contains nothing but ASCII digits
 */
function isDigitsOnly(value: string): boolean {
  return /^[0-9]*$/.test(value)
}

/**
 * Describe why a decimal precision is unusable.
 *
 * @param decimals - Candidate precision
 * @param label - How to refer to the precision in the message
 * @returns A user-presentable sentence, or null when the precision is valid
 */
function describeInvalidDecimals(decimals: number, label: string): string | null {
  if (!isSupportedDecimals(decimals)) {
    return `The ${label} must be a whole number between ${MIN_DECIMALS} and ${MAX_DECIMALS}.`
  }
  return null
}

/**
 * Describe an amount that carries more fraction digits than the precision allows.
 *
 * @param given - How many fraction digits the input has
 * @param decimals - How many the precision allows
 * @returns A user-presentable sentence
 */
function describeExcessFractionDigits(given: number, decimals: number): string {
  if (decimals === 0) {
    return "This unit has no decimal places, so a fractional amount is not allowed."
  }
  const allowed = decimals === 1 ? "1 decimal place" : `${decimals} decimal places`
  const supplied = given === 1 ? "1 was" : `${given} were`
  return `At most ${allowed} are allowed here, but ${supplied} given.`
}
