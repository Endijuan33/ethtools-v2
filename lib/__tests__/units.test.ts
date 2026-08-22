import { test } from "node:test"
import assert from "node:assert/strict"

import type { UnitResult } from "../units"
import {
  MAX_DECIMALS,
  MIN_DECIMALS,
  UNIT_NAMES,
  UNIT_PRESETS,
  convertDecimals,
  convertUnits,
  countFractionDigits,
  formatDecimal,
  formatUnit,
  getUnitDecimals,
  isSupportedDecimals,
  isUnitName,
  parseDecimal,
  parseUnit,
} from "../units"

/**
 * Unwrap a successful result, failing the test with the error message otherwise.
 */
function expectOk<T>(result: UnitResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected a success but got: ${result.error}`)
  }
  return result.value
}

/**
 * Unwrap a failed result, failing the test when the operation unexpectedly succeeded.
 */
function expectError<T>(result: UnitResult<T>): string {
  if (result.ok) {
    assert.fail("expected a failure but the operation succeeded")
  }
  return result.error
}

// ---------- presets ----------

test("UNIT_PRESETS carries the standard decimal exponents", () => {
  assert.equal(UNIT_PRESETS.wei.decimals, 0)
  assert.equal(UNIT_PRESETS.kwei.decimals, 3)
  assert.equal(UNIT_PRESETS.mwei.decimals, 6)
  assert.equal(UNIT_PRESETS.gwei.decimals, 9)
  assert.equal(UNIT_PRESETS.szabo.decimals, 12)
  assert.equal(UNIT_PRESETS.finney.decimals, 15)
  assert.equal(UNIT_PRESETS.ether.decimals, 18)
})

test("UNIT_NAMES lists every preset in ascending magnitude and self-names each entry", () => {
  assert.deepEqual(UNIT_NAMES, ["wei", "kwei", "mwei", "gwei", "szabo", "finney", "ether"])
  for (const name of UNIT_NAMES) {
    assert.equal(UNIT_PRESETS[name].name, name)
    assert.equal(getUnitDecimals(name), UNIT_PRESETS[name].decimals)
  }
})

test("isUnitName narrows only the canonical names", () => {
  assert.equal(isUnitName("gwei"), true)
  assert.equal(isUnitName("ether"), true)
  assert.equal(isUnitName("Ether"), false)
  assert.equal(isUnitName("babbage"), false)
  assert.equal(isUnitName(""), false)
  assert.equal(isUnitName("toString"), false)
})

test("isSupportedDecimals accepts the documented range only", () => {
  assert.equal(isSupportedDecimals(MIN_DECIMALS), true)
  assert.equal(isSupportedDecimals(MAX_DECIMALS), true)
  assert.equal(isSupportedDecimals(6), true)
  assert.equal(isSupportedDecimals(-1), false)
  assert.equal(isSupportedDecimals(MAX_DECIMALS + 1), false)
  assert.equal(isSupportedDecimals(1.5), false)
  assert.equal(isSupportedDecimals(Number.NaN), false)
  assert.equal(isSupportedDecimals(Number.POSITIVE_INFINITY), false)
})

// ---------- parseDecimal ----------

test("parseDecimal scales well-formed decimal strings exactly", () => {
  assert.equal(expectOk(parseDecimal("1.5", 18)), 1500000000000000000n)
  assert.equal(expectOk(parseDecimal("1", 18)), 1000000000000000000n)
  assert.equal(expectOk(parseDecimal("1.0", 18)), 1000000000000000000n)
  assert.equal(expectOk(parseDecimal("0", 18)), 0n)
  assert.equal(expectOk(parseDecimal("0.0", 18)), 0n)
  assert.equal(expectOk(parseDecimal("0.000000000000000001", 18)), 1n)
  assert.equal(expectOk(parseDecimal("123", 0)), 123n)
  assert.equal(expectOk(parseDecimal("+2.5", 18)), 2500000000000000000n)
})

test("parseDecimal allows an omitted integer or fraction part", () => {
  assert.equal(expectOk(parseDecimal(".5", 18)), 500000000000000000n)
  assert.equal(expectOk(parseDecimal("5.", 18)), 5000000000000000000n)
  assert.equal(expectOk(parseDecimal("007", 0)), 7n)
})

test("parseDecimal trims surrounding whitespace but rejects internal whitespace", () => {
  assert.equal(expectOk(parseDecimal("  1.5\n", 18)), 1500000000000000000n)
  expectError(parseDecimal("1 000", 18))
  expectError(parseDecimal("1. 5", 18))
})

test("parseDecimal rejects malformed input rather than coercing it", () => {
  for (const input of ["", "   ", "abc", ".", "-", "+", "1.2.3", "1e18", "1_000", "0x10", "1,5", "Infinity", "NaN"]) {
    const error = expectError(parseDecimal(input, 18))
    assert.equal(error.length > 0, true, `no message for ${JSON.stringify(input)}`)
  }
})

test("parseDecimal rejects more fraction digits than the precision can hold", () => {
  // 19 fraction digits at 18 decimals must be an error, not a silent 0.
  const error = expectError(parseDecimal("0.0000000000000000001", 18))
  assert.match(error, /18 decimal places/)
  assert.match(error, /19 were given/)

  // The last representable digit is still fine.
  assert.equal(expectOk(parseDecimal("0.000000000000000001", 18)), 1n)

  // A unit with no decimals rejects any fraction at all, including ".0".
  assert.match(expectError(parseDecimal("0.5", 0)), /no decimal places/)
  assert.match(expectError(parseDecimal("1.0", 0)), /no decimal places/)

  // Token precisions behave the same way.
  assert.equal(expectOk(parseDecimal("1.123456", 6)), 1123456n)
  expectError(parseDecimal("1.1234567", 6))
  assert.equal(expectOk(parseDecimal("1.12345678", 8)), 112345678n)
  expectError(parseDecimal("1.123456789", 8))
})

test("parseDecimal rejects negative amounts unless they are opted in", () => {
  assert.match(expectError(parseDecimal("-1", 18)), /Negative/)
  assert.match(expectError(parseDecimal("-0.5", 18)), /Negative/)
  assert.equal(expectOk(parseDecimal("-1.5", 18, { allowNegative: true })), -1500000000000000000n)
  assert.equal(expectOk(parseDecimal("-0", 18, { allowNegative: true })), 0n)
})

test("parseDecimal rejects an unsupported precision", () => {
  expectError(parseDecimal("1", -1))
  expectError(parseDecimal("1", MAX_DECIMALS + 1))
  expectError(parseDecimal("1", 1.5))
  assert.equal(expectOk(parseDecimal("1", MAX_DECIMALS)), 10n ** 36n)
})

test("parseDecimal handles values far beyond Number.MAX_SAFE_INTEGER exactly", () => {
  const uint256Max = 2n ** 256n - 1n
  const asDecimal = `${uint256Max / 10n ** 18n}.${(uint256Max % 10n ** 18n).toString().padStart(18, "0")}`
  assert.equal(expectOk(parseDecimal(asDecimal, 18)), uint256Max)

  // A value that Number cannot represent must survive the round trip untouched.
  const awkward = 9007199254740993n
  assert.equal(expectOk(parseDecimal(formatDecimal(awkward, 0), 0)), awkward)
})

// ---------- formatDecimal ----------

test("formatDecimal renders scaled values and trims trailing zeros by default", () => {
  assert.equal(formatDecimal(1500000000000000000n, 18), "1.5")
  assert.equal(formatDecimal(1000000000000000000n, 18), "1")
  assert.equal(formatDecimal(0n, 18), "0")
  assert.equal(formatDecimal(1n, 18), "0.000000000000000001")
  assert.equal(formatDecimal(1234n, 0), "1234")
  assert.equal(formatDecimal(0n, 0), "0")
  assert.equal(formatDecimal(1500000n, 6), "1.5")
})

test("formatDecimal can keep trailing zeros", () => {
  assert.equal(formatDecimal(1000000000000000000n, 18, { trimTrailingZeros: false }), "1.000000000000000000")
  assert.equal(formatDecimal(1500000n, 6, { trimTrailingZeros: false }), "1.500000")
  assert.equal(formatDecimal(1234n, 0, { trimTrailingZeros: false }), "1234")
})

test("formatDecimal truncates surplus digits and never rounds up", () => {
  assert.equal(formatDecimal(1999999999999999999n, 18, { maxFractionDigits: 2 }), "1.99")
  assert.equal(formatDecimal(1999999999999999999n, 18, { maxFractionDigits: 0 }), "1")
  assert.equal(formatDecimal(999999999999999999n, 18, { maxFractionDigits: 0 }), "0")
  assert.equal(formatDecimal(999999999999999999n, 18, { maxFractionDigits: 4 }), "0.9999")
  assert.equal(formatDecimal(1n, 18, { maxFractionDigits: 6 }), "0")
  assert.equal(formatDecimal(1050000n, 6, { maxFractionDigits: 1, trimTrailingZeros: false }), "1.0")

  // maxFractionDigits is a ceiling, not a fixed width.
  assert.equal(formatDecimal(1500000000000000000n, 18, { maxFractionDigits: 30 }), "1.5")
})

test("formatDecimal output never exceeds the true value in magnitude", () => {
  const values = [
    1n,
    999999999999999999n,
    1000000000000000001n,
    1999999999999999999n,
    123456789012345678901234567890n,
    2n ** 256n - 1n,
  ]
  for (const value of values) {
    for (const maxFractionDigits of [0, 1, 2, 6, 9, 17, 18]) {
      const rendered = formatDecimal(value, 18, { maxFractionDigits })
      const reparsed = expectOk(parseDecimal(rendered, 18))
      assert.equal(
        reparsed <= value,
        true,
        `${rendered} reparsed to ${reparsed}, which exceeds ${value}`
      )
    }
  }
})

test("formatDecimal never renders a negative zero", () => {
  assert.equal(formatDecimal(-1n, 18, { maxFractionDigits: 2 }), "0")
  assert.equal(formatDecimal(-1n, 18, { maxFractionDigits: 2, trimTrailingZeros: false }), "0.00")
  assert.equal(formatDecimal(0n, 18), "0")
  assert.equal(formatDecimal(-1500000000000000000n, 18), "-1.5")
  assert.equal(formatDecimal(-1n, 18), "-0.000000000000000001")
})

test("formatDecimal truncates negative values towards zero", () => {
  // Truncation must shrink the magnitude, so -1.999... becomes -1.99 and not -2.
  assert.equal(formatDecimal(-1999999999999999999n, 18, { maxFractionDigits: 2 }), "-1.99")
  assert.equal(formatDecimal(-1999999999999999999n, 18, { maxFractionDigits: 0 }), "-1")
})

test("formatDecimal treats an impossible precision as a programmer error", () => {
  assert.throws(() => formatDecimal(1n, -1), RangeError)
  assert.throws(() => formatDecimal(1n, MAX_DECIMALS + 1), RangeError)
  assert.throws(() => formatDecimal(1n, 1.5), RangeError)
  assert.throws(() => formatDecimal(1n, 18, { maxFractionDigits: -1 }), RangeError)
  assert.throws(() => formatDecimal(1n, 18, { maxFractionDigits: 2.5 }), RangeError)
})

// ---------- round trips ----------

test("parseDecimal and formatDecimal round-trip at several precisions", () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["0", 18],
    ["1", 18],
    ["1.5", 18],
    ["0.000000000000000001", 18],
    ["123456789.123456789", 18],
    ["1.123456", 6],
    ["0.00000001", 8],
    ["42", 0],
    ["0.1", 1],
  ]
  for (const [input, decimals] of cases) {
    const scaled = expectOk(parseDecimal(input, decimals))
    assert.equal(formatDecimal(scaled, decimals), input, `round trip failed for ${input}`)
    assert.equal(expectOk(parseDecimal(formatDecimal(scaled, decimals), decimals)), scaled)
  }
})

test("countFractionDigits counts what formatDecimal rendered", () => {
  assert.equal(countFractionDigits("1"), 0)
  assert.equal(countFractionDigits("1.5"), 1)
  assert.equal(countFractionDigits("0.000000000000000001"), 18)
  assert.equal(countFractionDigits(formatDecimal(1n, 18)), 18)
})

// ---------- convertDecimals ----------

test("convertDecimals widens precision exactly", () => {
  const widened = expectOk(convertDecimals(1500000n, 6, 18))
  assert.equal(widened.value, 1500000000000000000n)
  assert.equal(widened.truncated, false)
  assert.equal(widened.remainder, 0n)
  assert.equal(widened.discardedDigits, 0)

  const same = expectOk(convertDecimals(42n, 9, 9))
  assert.equal(same.value, 42n)
  assert.equal(same.truncated, false)
  assert.equal(same.discardedDigits, 0)
})

test("convertDecimals reports the digits it had to discard when narrowing", () => {
  const lossy = expectOk(convertDecimals(1999999999999999999n, 18, 6))
  assert.equal(lossy.value, 1999999n)
  assert.equal(lossy.truncated, true)
  assert.equal(lossy.remainder, 999999999999n)
  assert.equal(lossy.discardedDigits, 12)

  const clean = expectOk(convertDecimals(1500000000000000000n, 18, 6))
  assert.equal(clean.value, 1500000n)
  assert.equal(clean.truncated, false)
  assert.equal(clean.remainder, 0n)

  // Everything below the target precision is lost, and that is reported.
  const vanishing = expectOk(convertDecimals(999999999999n, 18, 6))
  assert.equal(vanishing.value, 0n)
  assert.equal(vanishing.truncated, true)
})

test("convertDecimals truncates negative values towards zero", () => {
  const narrowed = expectOk(convertDecimals(-1999999999999999999n, 18, 6))
  assert.equal(narrowed.value, -1999999n)
  assert.equal(narrowed.truncated, true)
})

test("convertDecimals rejects an unsupported precision on either side", () => {
  assert.match(expectError(convertDecimals(1n, -1, 18)), /source decimals/)
  assert.match(expectError(convertDecimals(1n, 18, MAX_DECIMALS + 1)), /target decimals/)
})

// ---------- named units ----------

test("parseUnit interprets an amount in its unit and returns wei", () => {
  assert.equal(expectOk(parseUnit("1", "ether")), 10n ** 18n)
  assert.equal(expectOk(parseUnit("1.5", "gwei")), 1500000000n)
  assert.equal(expectOk(parseUnit("1", "wei")), 1n)
  assert.equal(expectOk(parseUnit("1", "kwei")), 1000n)
  assert.match(expectError(parseUnit("0.5", "wei")), /no decimal places/)
})

test("formatUnit renders a wei amount in its unit", () => {
  assert.equal(formatUnit(10n ** 18n, "ether"), "1")
  assert.equal(formatUnit(1500000000n, "gwei"), "1.5")
  assert.equal(formatUnit(1n, "wei"), "1")
  assert.equal(formatUnit(1n, "ether"), "0.000000000000000001")
})

test("convertUnits converts in both directions without losing wei", () => {
  const up = expectOk(convertUnits("1", "ether", "wei"))
  assert.equal(up.value, "1000000000000000000")
  assert.equal(up.wei, 10n ** 18n)
  assert.equal(up.truncated, false)

  const down = expectOk(convertUnits("1", "wei", "ether"))
  assert.equal(down.value, "0.000000000000000001")
  assert.equal(down.wei, 1n)
  assert.equal(down.truncated, false)

  assert.equal(expectOk(convertUnits("1.5", "gwei", "wei")).value, "1500000000")
  assert.equal(expectOk(convertUnits("1500000000", "wei", "gwei")).value, "1.5")
  assert.equal(expectOk(convertUnits("21000", "gwei", "ether")).value, "0.000021")
  assert.equal(expectOk(convertUnits("1", "szabo", "finney")).value, "0.001")
  assert.equal(expectOk(convertUnits("1", "finney", "szabo")).value, "1000")
})

test("convertUnits round-trips every preset pair through wei", () => {
  for (const from of UNIT_NAMES) {
    for (const to of UNIT_NAMES) {
      const forward = expectOk(convertUnits("1", from, to))
      const back = expectOk(convertUnits(forward.value, to, from))
      assert.equal(back.value, "1", `${from} -> ${to} -> ${from} lost precision`)
      assert.equal(back.wei, forward.wei)
    }
  }
})

test("convertUnits rejects an amount finer than one wei", () => {
  expectError(convertUnits("0.5", "wei", "ether"))
  expectError(convertUnits("0.0000000000000000001", "ether", "wei"))
})

test("convertUnits flags truncation forced by maxFractionDigits and keeps the exact string", () => {
  const clipped = expectOk(convertUnits("1", "wei", "ether", { maxFractionDigits: 9 }))
  assert.equal(clipped.value, "0")
  assert.equal(clipped.exact, "0.000000000000000001")
  assert.equal(clipped.wei, 1n)
  assert.equal(clipped.truncated, true)

  // 1.5 gwei is 0.0000000015 ether, which needs 10 fraction digits, so a
  // 9-digit ceiling must truncate downwards rather than round to ...002.
  const untouched = expectOk(convertUnits("1.5", "gwei", "ether", { maxFractionDigits: 9 }))
  assert.equal(untouched.value, "0.000000001")
  assert.equal(untouched.exact, "0.0000000015")
  assert.equal(untouched.truncated, true)

  const roomy = expectOk(convertUnits("1.5", "gwei", "ether", { maxFractionDigits: 18 }))
  assert.equal(roomy.value, "0.0000000015")
  assert.equal(roomy.truncated, false)
})

test("convertUnits propagates the parse failure message unchanged", () => {
  assert.match(expectError(convertUnits("", "ether", "wei")), /Enter an amount/)
  assert.match(expectError(convertUnits("-1", "ether", "wei")), /Negative/)
  assert.equal(expectOk(convertUnits("-1", "ether", "wei", { allowNegative: true })).value, "-1000000000000000000")
})
