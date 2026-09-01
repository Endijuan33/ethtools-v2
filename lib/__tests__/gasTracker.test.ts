import { test } from "node:test"
import assert from "node:assert/strict"

import type { GasResult } from "../gasTracker"
import { estimateGasLevels } from "../gasTracker"

/**
 * These tests cover the pure estimator only. `estimateGasLevels` takes raw
 * JSON-RPC output and returns numbers, so percentile behaviour, the pre-1559
 * fallback, and the defensive parsing of hostile endpoint output are all
 * exercised with plain fixtures — no network and no mocks.
 */

const GWEI = 1_000_000_000n

/** Encode a wei amount as a JSON-RPC hex quantity. */
function hex(wei: bigint): string {
  return `0x${wei.toString(16)}`
}

/** An eth_feeHistory result with the given gwei base fee and reward rows. */
function feeHistory(baseFeeGwei: bigint, rewardsPerBlockGwei: bigint[][]): {
  baseFeePerGas: string[]
  reward: string[][]
} {
  const baseFee = hex(baseFeeGwei * GWEI)
  return {
    // The real response repeats the base fee for each block plus one predicted
    // next-block entry; only the last value matters to the estimator.
    baseFeePerGas: [baseFee, baseFee],
    reward: rewardsPerBlockGwei.map((row) => row.map((gwei) => hex(gwei * GWEI))),
  }
}

/**
 * Unwrap a successful result, failing the test with the error message otherwise.
 */
function expectOk<T>(result: GasResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected a success but got: ${result.error}`)
  }
  return result.value
}

/**
 * Unwrap a failed result, failing the test when the operation unexpectedly succeeded.
 */
function expectError<T>(result: GasResult<T>): string {
  if (result.ok) {
    assert.fail("expected a failure but the operation succeeded")
  }
  return result.error
}

// ---------- EIP-1559 path ----------

test("prices each tier at its reward percentile plus the latest base fee", () => {
  const history = feeHistory(10n, [
    [1n, 2n, 3n],
    [1n, 2n, 3n],
    [1n, 2n, 5n],
  ])
  const estimate = expectOk(estimateGasLevels(history))

  // Per-column medians are 1 / 2 / 3 gwei; base fee 10 gwei.
  assert.equal(estimate.isEip1559, true)
  assert.equal(estimate.slow, 11n * GWEI)
  assert.equal(estimate.standard, 12n * GWEI)
  assert.equal(estimate.fast, 13n * GWEI)
})

test("uses the last valid base fee, the node's prediction for the next block", () => {
  const history = feeHistory(10n, [[1n, 2n, 3n]])
  history.baseFeePerGas = [hex(5n * GWEI), hex(7n * GWEI), hex(9n * GWEI)]
  const estimate = expectOk(estimateGasLevels(history))

  assert.equal(estimate.slow, 10n * GWEI)
  assert.equal(estimate.standard, 11n * GWEI)
  assert.equal(estimate.fast, 12n * GWEI)
})

test("aggregates each percentile column with the median, staying on observed values", () => {
  const history = feeHistory(0n, [
    [1n, 10n, 100n],
    [3n, 30n, 300n],
  ])
  const estimate = expectOk(estimateGasLevels(history))

  // Two blocks: nearest-rank 50 is the first (lower) of the two middles, so a
  // single anomalous block can never pull the estimate toward itself.
  assert.equal(estimate.slow, 1n * GWEI)
  assert.equal(estimate.standard, 10n * GWEI)
  assert.equal(estimate.fast, 100n * GWEI)
})

test("ignores extra percentile columns beyond the three it prices", () => {
  const history = {
    baseFeePerGas: [hex(10n * GWEI)],
    reward: [[hex(1n * GWEI), hex(2n * GWEI), hex(3n * GWEI), hex(4n * GWEI), hex(5n * GWEI)]],
  }
  const estimate = expectOk(estimateGasLevels(history))

  assert.equal(estimate.slow, 11n * GWEI)
  assert.equal(estimate.standard, 12n * GWEI)
  assert.equal(estimate.fast, 13n * GWEI)
})

test("enforces slow ≤ standard ≤ fast even when an endpoint emits unsorted percentiles", () => {
  const history = feeHistory(10n, [[3n, 2n, 1n]])
  const estimate = expectOk(estimateGasLevels(history))

  // All three collapse onto the standard tier rather than inverting the rows.
  assert.equal(estimate.slow, 12n * GWEI)
  assert.equal(estimate.standard, 12n * GWEI)
  assert.equal(estimate.fast, 12n * GWEI)
})

test("carries wei exactly with no floating-point rounding", () => {
  const base = 0xde0b6b3a7640000n // 1 ether in wei
  const history = {
    baseFeePerGas: [hex(base)],
    reward: [[hex(123456789n), hex(987654321n), hex(1234567898n)]],
  }
  const estimate = expectOk(estimateGasLevels(history))

  assert.equal(estimate.slow, base + 123456789n)
  assert.equal(estimate.standard, base + 987654321n)
  assert.equal(estimate.fast, base + 1234567898n)
})

// ---------- Legacy fallback ----------

test("falls back to gasPrice with margins when fee history is unusable", () => {
  const estimate = expectOk(estimateGasLevels(null, hex(20n * GWEI)))

  assert.equal(estimate.isEip1559, false)
  assert.equal(estimate.slow, 18n * GWEI)
  assert.equal(estimate.standard, 20n * GWEI)
  assert.equal(estimate.fast, 25n * GWEI)
})

test("legacy margins truncate toward zero rather than rounding up", () => {
  // 19 wei: 90% is 17.1 wei and 125% is 23.75 wei; both must land on the
  // whole wei below, never on the nearest one above.
  const estimate = expectOk(estimateGasLevels(null, "0x13"))

  assert.equal(estimate.slow, 17n)
  assert.equal(estimate.standard, 19n)
  assert.equal(estimate.fast, 23n)
})

test("accepts gasPrice as hex, decimal string, number, or bigint", () => {
  const wei = 2_000_000_000n
  for (const form of [hex(wei), wei.toString(), Number(wei), wei]) {
    const estimate = expectOk(estimateGasLevels(null, form))
    assert.equal(estimate.standard, wei, `form: ${String(form)}`)
  }
})

test("keeps a zero gas price zero and never rounds a non-zero price down to free", () => {
  const zero = expectOk(estimateGasLevels(null, "0x0"))
  assert.equal(zero.slow, 0n)
  assert.equal(zero.standard, 0n)
  assert.equal(zero.fast, 0n)

  // 90% of 1 wei truncates to 0, which would read as a free transaction.
  const tiny = expectOk(estimateGasLevels(null, "0x1"))
  assert.equal(tiny.slow, 1n)
  assert.equal(tiny.standard, 1n)
  assert.equal(tiny.fast, 1n)
})

// ---------- Defensive parsing ----------

test("malformed fee history degrades to the gasPrice fallback instead of throwing", () => {
  const unusable: unknown[] = [
    null,
    undefined,
    {},
    "a string",
    { baseFeePerGas: "0x1", reward: [[hex(1n)]] },
    { baseFeePerGas: [], reward: [] },
    { baseFeePerGas: [hex(1n)], reward: [[hex(1n)]] },
    { baseFeePerGas: [hex(1n)] },
    { reward: [[hex(1n), hex(2n), hex(3n)]] },
    { baseFeePerGas: ["junk", null, "-0x2"], reward: [[hex(1n), hex(2n), hex(3n)]] },
  ]

  for (const history of unusable) {
    const estimate = expectOk(estimateGasLevels(history, hex(10n * GWEI)))
    assert.equal(estimate.isEip1559, false, `history: ${JSON.stringify(history)}`)
    assert.equal(estimate.standard, 10n * GWEI)
  }
})

test("skips unusable reward cells, rows, and base-fee entries instead of failing", () => {
  const history = {
    baseFeePerGas: [null, hex(10n * GWEI)],
    reward: [
      ["not-hex", hex(2n * GWEI), hex(3n * GWEI)],
      null,
      [hex(1n * GWEI), hex(2n * GWEI), hex(9n * GWEI)],
    ],
  }
  const estimate = expectOk(estimateGasLevels(history))

  // Column 0 keeps its one valid value; column 2 keeps [3, 9] whose rank-50
  // median is the lower middle, 3.
  assert.equal(estimate.slow, 11n * GWEI)
  assert.equal(estimate.standard, 12n * GWEI)
  assert.equal(estimate.fast, 13n * GWEI)
})

test("fails with a user-presentable error when no source is usable", () => {
  const cases: [unknown, unknown][] = [
    [null, undefined],
    [{}, null],
    [{ baseFeePerGas: [], reward: [] }, "junk"],
    ["a string", 12.5],
    [null, -5n],
    [null, "0x"],
    [null, "  "],
  ]

  for (const [history, gasPrice] of cases) {
    const error = expectError(estimateGasLevels(history, gasPrice))
    assert.equal(error.length > 0, true, `no message for ${JSON.stringify(history)}`)
  }
})
