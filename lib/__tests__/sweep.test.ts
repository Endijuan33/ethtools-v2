import { test } from "node:test"
import assert from "node:assert/strict"
import { planSweep, MAX_SWEEP_TOKENS, type PlanSweepInput, type SweepTokenInput } from "../sweep"

const FROM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const DESTINATION = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const TOKEN_A = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const TOKEN_B = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

const ETH = 10n ** 18n
const GWEI = 10n ** 9n

/** A valid input with overridable fields. */
function baseInput(overrides: Partial<PlanSweepInput> = {}): PlanSweepInput {
  return {
    from: FROM,
    destination: DESTINATION,
    nativeBalance: ETH,
    nativeDecimals: 18,
    nativeSymbol: "ETH",
    nativeGasLimit: 21_000n,
    tokens: [],
    feePerGas: 20n * GWEI,
    ...overrides,
  }
}

function token(overrides: Partial<SweepTokenInput> = {}): SweepTokenInput {
  return {
    contractAddress: TOKEN_A,
    symbol: "DAI",
    decimals: 18,
    balance: 100n * ETH,
    gasLimit: 65_000n,
    ...overrides,
  }
}

/** Unwrap a successful plan or fail the test with its error. */
function expectPlan(input: PlanSweepInput) {
  const result = planSweep(input)
  assert.equal(result.ok, true, result.ok ? "" : result.error)
  if (!result.ok) throw new Error("unreachable")
  return result.value
}

/** Unwrap a failed plan's error or fail the test. */
function expectError(input: PlanSweepInput): string {
  const result = planSweep(input)
  assert.equal(result.ok, false, "the plan must be rejected")
  if (result.ok) throw new Error("unreachable")
  return result.error
}

// ===== Ordering =====

test("token transfers come first and the native transfer comes last", () => {
  const plan = expectPlan(
    baseInput({
      tokens: [token({ symbol: "DAI" }), token({ contractAddress: TOKEN_B, symbol: "USDC", decimals: 6 })],
    })
  )

  assert.equal(plan.transfers.length, 3)
  assert.deepEqual(
    plan.transfers.map((transfer) => transfer.kind),
    ["token", "token", "native"],
    "native must be the final transfer so earlier legs keep gas available"
  )
  assert.equal(plan.transfers[2].to, DESTINATION)
  assert.equal(plan.transfers[2].symbol, "ETH")
})

// ===== Native amount and reserve =====

test("the native amount is the balance minus a gas reserve covering every transfer, plus headroom", () => {
  // Two token legs at 65k gas plus the native 21k: 151k gas total.
  const plan = expectPlan(
    baseInput({
      tokens: [token(), token({ contractAddress: TOKEN_B, symbol: "USDC", decimals: 6 })],
    })
  )

  const totalGas = 65_000n + 65_000n + 21_000n
  const totalFee = totalGas * 20n * GWEI
  const reserve = totalFee + totalFee / 2n

  assert.equal(plan.totalGasLimit, totalGas)
  assert.equal(plan.reserveWei, reserve)
  assert.equal(plan.nativeAmount, ETH - reserve)
  assert.equal(plan.transfers[2].amount, ETH - reserve)
})

test("the native transfer is omitted when the balance only covers the reserve", () => {
  const totalGas = 65_000n + 21_000n
  const totalFee = totalGas * 20n * GWEI
  const reserve = totalFee + totalFee / 2n

  const plan = expectPlan(
    baseInput({
      nativeBalance: reserve, // exactly the reserve: nothing spendable
      tokens: [token()],
    })
  )

  assert.equal(plan.nativeAmount, 0n)
  assert.equal(plan.transfers.length, 1, "only the token transfer is planned")
  assert.equal(plan.transfers[0].kind, "token")
})

test("an unknown fee yields no fee figures and no reserve", () => {
  const plan = expectPlan(baseInput({ feePerGas: null }))

  assert.equal(plan.totalEstimatedFeeWei, null)
  assert.equal(plan.reserveWei, 0n)
  assert.equal(plan.nativeAmount, ETH, "the whole balance is planned when fees are unknown")
  assert.equal(plan.transfers[0].estimatedFeeWei, null)
})

// ===== Empty plans =====

test("a zero native balance and zero token balances plan nothing", () => {
  const plan = expectPlan(
    baseInput({ nativeBalance: 0n, tokens: [token({ balance: 0n })] })
  )
  assert.equal(plan.transfers.length, 0)
  assert.equal(plan.nativeAmount, 0n)
})

// ===== Hostile input rejection =====

test("a destination equal to the swept account is rejected", () => {
  assert.match(expectError(baseInput({ destination: FROM })), /account being swept/i)
  // Case-insensitive: a differently-cased same address is still self-sweeping.
  assert.match(expectError(baseInput({ destination: FROM.toLowerCase() })), /account being swept/i)
})

test("invalid addresses are rejected, not normalized into a plan", () => {
  assert.match(expectError(baseInput({ destination: "0xdeadbeef" })), /destination/i)
  assert.match(expectError(baseInput({ from: "not an address" })), /account being swept/i)
  assert.match(expectError(baseInput({ destination: "" })), /destination/i)
})

test("structurally invalid token entries reject the whole plan", () => {
  const wrongs: Array<[string, SweepTokenInput]> = [
    ["invalid contract", token({ contractAddress: "0x1234" })],
    ["negative balance", token({ balance: -1n })],
    ["zero gas limit", token({ gasLimit: 0n })],
    ["negative gas limit", token({ gasLimit: -65_000n })],
    ["decimals too large", token({ decimals: 37 })],
    ["fractional decimals", token({ decimals: 18.5 })],
    ["negative decimals", token({ decimals: -1 })],
    ["empty symbol", token({ symbol: "" })],
  ]

  for (const [label, entry] of wrongs) {
    const error = expectError(baseInput({ tokens: [entry] }))
    assert.ok(error.length > 0, `${label} must be rejected`)
  }
})

test("zero-balance tokens are skipped, not errors", () => {
  const plan = expectPlan(
    baseInput({ tokens: [token({ balance: 0n }), token({ contractAddress: TOKEN_B, symbol: "USDC", decimals: 6 })] })
  )
  assert.equal(plan.transfers.length, 2, "one token leg plus the native leg")
  assert.equal(plan.transfers[0].symbol, "USDC")
})

test("duplicate token contracts are planned once", () => {
  const plan = expectPlan(
    baseInput({
      tokens: [token(), token({ contractAddress: TOKEN_A.toLowerCase(), symbol: "DAI-copy" })],
    })
  )
  const tokenLegs = plan.transfers.filter((transfer) => transfer.kind === "token")
  assert.equal(tokenLegs.length, 1, "the same contract must not be transferred twice")
})

test("more tokens than the cap rejects the plan", () => {
  const tokens = Array.from({ length: MAX_SWEEP_TOKENS + 1 }, (_, i) =>
    token({ contractAddress: `0x${(i + 1).toString(16).padStart(40, "0")}`, symbol: `T${i}` })
  )
  assert.match(expectError(baseInput({ tokens })), /at most 50 tokens/i)
})

test("invalid native-side inputs are rejected", () => {
  assert.match(expectError(baseInput({ nativeBalance: -1n })), /native balance/i)
  assert.match(expectError(baseInput({ nativeDecimals: 40 })), /decimals/i)
  assert.match(expectError(baseInput({ nativeDecimals: 18.5 })), /decimals/i)
  assert.match(expectError(baseInput({ nativeSymbol: "" })), /symbol/i)
  assert.match(expectError(baseInput({ feePerGas: -1n })), /fee estimate/i)
  assert.match(
    expectError(baseInput({ nativeGasLimit: 0n })),
    /native transfer/i,
    "a zero native gas estimate with a positive balance is unusable"
  )
})

// ===== Totals =====

test("per-transfer fee estimates sum to the total", () => {
  const plan = expectPlan(baseInput({ tokens: [token()] }))
  const knownFees = plan.transfers
    .map((transfer) => transfer.estimatedFeeWei)
    .filter((fee): fee is bigint => fee !== null)
  assert.equal(plan.totalEstimatedFeeWei, knownFees.reduce((sum, fee) => sum + fee, 0n))
  assert.equal(plan.transfers[0].estimatedFeeWei, 65_000n * 20n * GWEI)
  assert.equal(plan.transfers[1].estimatedFeeWei, 21_000n * 20n * GWEI)
})

test("the destination is normalized to EIP-55 checksum form", () => {
  const plan = expectPlan(baseInput({ destination: DESTINATION.toLowerCase() }))
  assert.equal(plan.destination, DESTINATION)
  assert.equal(plan.transfers[0].to, DESTINATION)
})
