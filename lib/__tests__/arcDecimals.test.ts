/**
 * Regression tests for Arc native-currency decimals (S11).
 *
 * Arc's native currency is USDC, but Arc mints it with 18 decimals - not
 * the 6 decimals of ERC-20 USDC. An earlier 6-decimal override mispriced
 * Arc balances and fees by 12 orders of magnitude; these tests pin the
 * corrected configuration so a future "helpful" override cannot silently
 * reintroduce it.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { formatUnits, parseUnits } from "ethers"
import { getNativeDecimals, NETWORKS } from "../ethers"

test("Arc Mainnet and Arc Testnet use 18 native decimals", () => {
  assert.equal(NETWORKS["arc"].currency, "USDC")
  assert.equal(NETWORKS["arc-testnet"].currency, "USDC")
  assert.equal(getNativeDecimals("arc"), 18)
  assert.equal(getNativeDecimals("arc-testnet"), 18)
})

test("Arc amounts format and parse at 18 decimals, never 6", () => {
  const decimals = getNativeDecimals("arc")
  // One micro-USDC at ERC-20 precision would read as a full unit at 6
  // decimals; at Arc's native 18 it is 0.000000000001.
  assert.equal(formatUnits(1_000_000n, decimals), "0.000000000001")
  // A one-unit send amount must be 10^18 base units.
  assert.equal(parseUnits("1", decimals), 10n ** 18n)
  assert.equal(parseUnits("1", decimals) === 10n ** 6n, false)
})

test("other built-in networks keep the 18-decimal default", () => {
  assert.equal(getNativeDecimals("ethereum"), 18)
  assert.equal(getNativeDecimals("base"), 18)
})
