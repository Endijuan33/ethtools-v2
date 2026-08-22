import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DUST_MARKER,
  formatBalanceForDisplay,
  formatFiat,
  formatRelativeTime,
  formatTokenAmount,
  isNonZeroAmount,
  parseAmount,
  toFiatValue,
  truncateHex,
  UNKNOWN_VALUE,
} from "../format"

const ETH = 18

test("formats whole and fractional amounts", () => {
  assert.equal(formatTokenAmount(10n ** 18n, ETH), "1.0")
  assert.equal(formatTokenAmount(0n, ETH), "0.0")
  assert.equal(formatTokenAmount(1_500_000_000_000_000_000n, ETH, 2), "1.5")
})

test("truncates toward zero and never rounds up", () => {
  // 0.999999999999999999 must not display as 1.0 — that would overstate funds.
  const almostOne = 10n ** 18n - 1n
  assert.equal(formatTokenAmount(almostOne, ETH, 5), "0.99999")
  assert.equal(formatTokenAmount(almostOne, ETH, 0), "0")

  // 0.000006 at 5 digits must floor to 0.00000, not round to 0.00001.
  assert.equal(formatTokenAmount(6_000_000_000_000n, ETH, 5), "0.00000")
})

test("keeps full precision when no digit limit is given", () => {
  const dust = 123_456_789_012_345_678n
  assert.equal(formatTokenAmount(dust, ETH), "0.123456789012345678")
})

test("handles non-18-decimal assets", () => {
  assert.equal(formatTokenAmount(1_000_000n, 6), "1.0")
  assert.equal(formatTokenAmount(1n, 6), "0.000001")
  assert.equal(formatTokenAmount(5n, 0), "5")
})

test("display balance distinguishes true zero from dust", () => {
  assert.equal(formatBalanceForDisplay(0n, ETH), "0")

  // Below 8 decimals of precision but genuinely non-zero: must not read as 0.
  assert.equal(formatBalanceForDisplay(1n, ETH), DUST_MARKER)
  assert.equal(formatBalanceForDisplay(10n ** 9n, ETH), DUST_MARKER)

  // At or above the display precision, show the real digits.
  assert.equal(formatBalanceForDisplay(10n ** 10n, ETH), "0.00000001")
  assert.equal(formatBalanceForDisplay(10n ** 18n, ETH), "1.0")

  // A 6-decimal asset never loses digits at this precision.
  assert.equal(formatBalanceForDisplay(1n, 6), "0.000001")
})

test("spendability is decided on base units, not the display string", () => {
  // A balance that renders as "0.00000" is still spendable.
  const dust = 6_000_000_000_000n
  assert.equal(formatTokenAmount(dust, ETH, 5), "0.00000")
  assert.equal(isNonZeroAmount(dust), true)
  assert.equal(isNonZeroAmount(0n), false)
})

test("parses valid amounts", () => {
  const a = parseAmount("1.5", ETH)
  assert.equal(a.ok, true)
  if (a.ok) assert.equal(a.value, 1_500_000_000_000_000_000n)

  const b = parseAmount("  0.000001  ", 6)
  assert.equal(b.ok, true)
  if (b.ok) assert.equal(b.value, 1n)
})

test("rejects malformed and out-of-precision amounts", () => {
  for (const bad of ["", ".", "abc", "1.2.3", "-1", "1e18", "1,5"]) {
    assert.equal(parseAmount(bad, ETH).ok, false, `should reject ${JSON.stringify(bad)}`)
  }

  // More decimals than the asset supports is an error, not a silent zero.
  const tooPrecise = parseAmount("0.0000001", 6)
  assert.equal(tooPrecise.ok, false)
  if (!tooPrecise.ok) assert.match(tooPrecise.error, /at most 6 decimal places/)
})

test("rejects zero as a send amount", () => {
  assert.equal(parseAmount("0", ETH).ok, false)
  assert.equal(parseAmount("0.0", ETH).ok, false)
})

test("formats fiat and marks unknown prices distinctly from zero", () => {
  assert.equal(formatFiat(null), UNKNOWN_VALUE)
  assert.match(formatFiat(1234.5), /1,234\.5/)
  assert.match(formatFiat(0), /0\.00/)

  // A sub-cent value must keep enough digits to stay visible.
  const subCent = formatFiat(0.000123)
  assert.ok(
    /0\.000123/.test(subCent),
    `sub-cent value collapsed to "${subCent}"; it must not round to 0.00`
  )
})

test("converts a balance to fiat", () => {
  assert.equal(toFiatValue(10n ** 18n, ETH, 2000), 2000)
  assert.equal(toFiatValue(0n, ETH, 2000), 0)
  assert.equal(toFiatValue(10n ** 18n, ETH, null), null)
})

test("fiat conversion does not overflow on an absurd balance", () => {
  const huge = 10n ** 40n
  const result = toFiatValue(huge, ETH, 2000)
  assert.ok(result === null || Number.isFinite(result))
})

test("truncates hex for display", () => {
  const address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  assert.equal(truncateHex(address), "0xf39F…2266")
  assert.equal(truncateHex("0x1234"), "0x1234", "short values are returned unchanged")
})

test("formats relative time deterministically", () => {
  const now = 1_700_000_000_000
  assert.equal(formatRelativeTime(now - 5_000, now), "5s ago")
  assert.equal(formatRelativeTime(now - 120_000, now), "2m ago")
  assert.equal(formatRelativeTime(now - 7_200_000, now), "2h ago")
  assert.equal(formatRelativeTime(now - 172_800_000, now), "2d ago")
  assert.equal(formatRelativeTime(now + 5_000, now), "just now")
  assert.equal(formatRelativeTime(0, now), UNKNOWN_VALUE)
})
