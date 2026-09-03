import { test } from "node:test"
import assert from "node:assert/strict"

import {
  MAX_GAS_THRESHOLD_GWEI,
  MAX_PRICE_THRESHOLD_USD,
  evaluateGasAlert,
  evaluatePriceAlert,
  nextAlertId,
  validateGasThresholdGwei,
  validatePriceThresholdUsd,
  type GasAlert,
  type PriceAlert,
} from "../priceAlerts"

/**
 * Pure alert policy: when each kind fires, what reads as "no data", and which
 * thresholds the form accepts. No timers and no network exist in the module,
 * so every rule is exercised with plain numbers.
 */

function priceAlert(kind: "price-above" | "price-below", thresholdUsd: number): PriceAlert {
  return { id: "a1", kind, assetSymbol: "ETH", assetCoinId: "ethereum", thresholdUsd }
}

const gasAlert = (thresholdGwei: number): GasAlert => ({
  id: "g1",
  kind: "gas-below",
  thresholdGwei,
})

// ===== evaluatePriceAlert: price-above =====

test("price-above fires at exactly the threshold (an exact touch counts)", () => {
  const result = evaluatePriceAlert(priceAlert("price-above", 3000), 3000)
  assert.deepEqual(result, { fired: true, status: "fired" })
})

test("price-above fires just above the threshold", () => {
  const result = evaluatePriceAlert(priceAlert("price-above", 3000), 3000.000001)
  assert.deepEqual(result, { fired: true, status: "fired" })
})

test("price-above waits just below the threshold", () => {
  const result = evaluatePriceAlert(priceAlert("price-above", 3000), 2999.999999)
  assert.deepEqual(result, { fired: false, status: "waiting" })
})

// ===== evaluatePriceAlert: price-below =====

test("price-below fires at exactly the threshold", () => {
  const result = evaluatePriceAlert(priceAlert("price-below", 2000), 2000)
  assert.deepEqual(result, { fired: true, status: "fired" })
})

test("price-below fires just below the threshold", () => {
  const result = evaluatePriceAlert(priceAlert("price-below", 2000), 1999.999999)
  assert.deepEqual(result, { fired: true, status: "fired" })
})

test("price-below waits just above the threshold", () => {
  const result = evaluatePriceAlert(priceAlert("price-below", 2000), 2000.000001)
  assert.deepEqual(result, { fired: false, status: "waiting" })
})

// ===== evaluatePriceAlert: unusable inputs =====

test("a missing price reads as no-data, never as calm", () => {
  for (const spot of [null, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const result = evaluatePriceAlert(priceAlert("price-above", 1), spot)
    assert.deepEqual(
      result,
      { fired: false, status: "no-data" },
      `spot ${String(spot)} must be no-data`
    )
  }
})

test("a corrupt alert threshold never fires", () => {
  for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
    const result = evaluatePriceAlert(priceAlert("price-above", threshold), 3000)
    assert.deepEqual(
      result,
      { fired: false, status: "no-data" },
      `threshold ${String(threshold)} must be no-data`
    )
  }
})

// ===== evaluateGasAlert =====

test("gas-below fires at exactly the threshold", () => {
  const result = evaluateGasAlert(gasAlert(10), 10)
  assert.deepEqual(result, { fired: true, status: "fired" })
})

test("gas-below fires just below the threshold and waits just above", () => {
  assert.deepEqual(evaluateGasAlert(gasAlert(10), 9.999999), { fired: true, status: "fired" })
  assert.deepEqual(evaluateGasAlert(gasAlert(10), 10.000001), {
    fired: false,
    status: "waiting",
  })
})

test("a missing or corrupt gas reading reads as no-data", () => {
  for (const gwei of [null, Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
    assert.deepEqual(evaluateGasAlert(gasAlert(10), gwei), {
      fired: false,
      status: "no-data",
    })
  }
  for (const threshold of [Number.NaN, 0, -1]) {
    assert.deepEqual(evaluateGasAlert(gasAlert(threshold), 5), {
      fired: false,
      status: "no-data",
    })
  }
})

// ===== Threshold validation =====

test("a valid price threshold parses, with surrounding whitespace tolerated", () => {
  assert.deepEqual(validatePriceThresholdUsd("3000"), { ok: true, value: 3000 })
  assert.deepEqual(validatePriceThresholdUsd(" 2999.50 "), { ok: true, value: 2999.5 })
  assert.deepEqual(validatePriceThresholdUsd("0.01"), { ok: true, value: 0.01 })
})

test("price thresholds at or under zero, and non-plain-decimal forms, are rejected", () => {
  for (const bad of ["", "  ", "0", "0.00", "-5", "1e3", "3,000", "abc", "12.5.1", "٣٠٠٠"]) {
    assert.equal(
      validatePriceThresholdUsd(bad).ok,
      false,
      `input ${JSON.stringify(bad)} must be rejected`
    )
  }
})

test("the price cap rejects values past it and accepts the boundary", () => {
  assert.equal(validatePriceThresholdUsd(String(MAX_PRICE_THRESHOLD_USD)).ok, true)
  const over = validatePriceThresholdUsd(`${MAX_PRICE_THRESHOLD_USD + 1}`)
  assert.equal(over.ok, false)
  if (!over.ok) {
    assert.match(over.error, /\$/)
  }
})

test("gas thresholds validate with their own unit and cap", () => {
  assert.deepEqual(validateGasThresholdGwei("10"), { ok: true, value: 10 })
  assert.deepEqual(validateGasThresholdGwei("0.5"), { ok: true, value: 0.5 })
  assert.equal(validateGasThresholdGwei(String(MAX_GAS_THRESHOLD_GWEI)).ok, true)
  assert.equal(validateGasThresholdGwei(`${MAX_GAS_THRESHOLD_GWEI + 1}`).ok, false)
  for (const bad of ["", "0", "-1", "1e2", "fast"]) {
    assert.equal(validateGasThresholdGwei(bad).ok, false)
  }
})

// ===== Ids =====

test("nextAlertId returns unique non-empty strings", () => {
  const seen = new Set<string>()
  for (let index = 0; index < 50; index++) {
    const id = nextAlertId()
    assert.equal(typeof id, "string")
    assert.ok(id.length > 0)
    assert.equal(seen.has(id), false, `id ${id} must be unique`)
    seen.add(id)
  }
})
