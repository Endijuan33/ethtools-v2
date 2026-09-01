import { test } from "node:test"
import assert from "node:assert/strict"

import { aggregatePortfolio, type PortfolioEntry } from "../portfolio"

/**
 * These tests cover the pure aggregator only. `aggregatePortfolio` takes
 * balance-and-price entries and returns totals and breakdowns, so summation,
 * truncation, missing-price degradation, and display ordering are all exercised
 * with plain fixtures — no network and no mocks.
 */

const ETH = 18

/** One whole unit of an 18-decimal asset. */
const ONE = 10n ** 18n

/**
 * A native-style entry. Fields that matter to the assertion are parameters;
 * everything else gets a boring default so each test states only its point.
 */
function entry(
  networkKey: string,
  balance: bigint,
  priceUsd: number | null,
  overrides: Partial<PortfolioEntry> = {}
): PortfolioEntry {
  return {
    networkKey,
    networkName: networkKey,
    symbol: "ETH",
    balance,
    decimals: ETH,
    priceUsd,
    ...overrides,
  }
}

test("an empty portfolio aggregates to zero without throwing", () => {
  const portfolio = aggregatePortfolio([])
  assert.equal(portfolio.netUsd, 0)
  assert.deepEqual(portfolio.byNetwork, [])
  assert.deepEqual(portfolio.byAsset, [])
  assert.equal(portfolio.unpricedCount, 0)
  assert.equal(portfolio.entryCount, 0)
})

test("totals and shares sum across networks", () => {
  const portfolio = aggregatePortfolio([
    entry("mainnet", 15n * 10n ** 17n, 2000, { networkName: "Ethereum Mainnet" }),
    entry("base", 5n * 10n ** 17n, 2000),
  ])

  assert.equal(portfolio.netUsd, 4000)
  assert.equal(portfolio.byNetwork.length, 2)
  assert.equal(portfolio.byNetwork[0].networkKey, "mainnet")
  assert.equal(portfolio.byNetwork[0].usd, 3000)
  assert.equal(portfolio.byNetwork[0].share, 0.75)
  assert.equal(portfolio.byNetwork[1].networkKey, "base")
  assert.equal(portfolio.byNetwork[1].usd, 1000)
  assert.equal(portfolio.byNetwork[1].share, 0.25)
})

test("a single holding takes the full share", () => {
  const portfolio = aggregatePortfolio([entry("mainnet", ONE, 123.45)])
  assert.equal(portfolio.byNetwork[0].share, 1)
})

test("byAsset combines the same symbol across networks", () => {
  const portfolio = aggregatePortfolio([
    entry("mainnet", ONE, 1500),
    entry("base", 2n * ONE, 1500),
    entry("bsc", 2n * ONE, 300, { symbol: "BNB" }),
  ])

  assert.equal(portfolio.byAsset.length, 2)

  // ETH is worth more than BNB here, so it sorts first.
  const eth = portfolio.byAsset[0]
  assert.equal(eth.symbol, "ETH")
  assert.equal(eth.balance, 3n * ONE)
  assert.equal(eth.decimals, ETH)
  assert.equal(eth.usd, 4500)
  assert.equal(eth.networkCount, 2)

  const bnb = portfolio.byAsset[1]
  assert.equal(bnb.symbol, "BNB")
  assert.equal(bnb.usd, 600)
})

test("byAsset refuses to sum balances across mismatched decimals", () => {
  const portfolio = aggregatePortfolio([
    entry("mainnet", ONE, 2000),
    entry("arc", 1_000_000n, 1, { decimals: 6 }),
  ])

  const eth = portfolio.byAsset[0]
  assert.equal(eth.balance, null, "wei at different scales must not be summed")
  assert.equal(eth.decimals, null)
  // The USD value still sums: pricing does not depend on combining balances.
  assert.equal(eth.usd, 2001)
})

test("byAsset groups symbols case-insensitively", () => {
  const portfolio = aggregatePortfolio([
    entry("mainnet", ONE, 2000),
    entry("base", ONE, 2000, { symbol: "eth" }),
  ])

  assert.equal(portfolio.byAsset.length, 1)
  assert.equal(portfolio.byAsset[0].symbol, "ETH")
  assert.equal(portfolio.byAsset[0].networkCount, 2)
})

test("byAsset ignores zero-balance networks when counting coverage", () => {
  const portfolio = aggregatePortfolio([
    entry("mainnet", ONE, 2000),
    entry("base", 0n, 2000),
  ])

  assert.equal(portfolio.byAsset[0].networkCount, 1)
})

test("zero-balance networks price to exactly zero and sort last", () => {
  const portfolio = aggregatePortfolio([
    entry("mainnet", 0n, 2000),
    entry("base", ONE, 2000),
  ])

  assert.equal(portfolio.netUsd, 2000)
  assert.equal(portfolio.byNetwork[0].networkKey, "base")

  const zero = portfolio.byNetwork[1]
  assert.equal(zero.networkKey, "mainnet")
  assert.equal(zero.usd, 0)
  assert.equal(zero.share, 0)
})

test("a zero balance is worth zero even when its price is missing", () => {
  // An empty network is worth exactly nothing whatever the quote says, so it
  // must count as priced — "unknown" is reserved for holdings that exist.
  const portfolio = aggregatePortfolio([entry("mainnet", 0n, null)])

  assert.equal(portfolio.unpricedCount, 0)
  assert.equal(portfolio.byNetwork[0].usd, 0)
  assert.equal(portfolio.netUsd, 0)
})

test("entries without prices stay visible but leave the total alone", () => {
  const portfolio = aggregatePortfolio([
    entry("mainnet", ONE, 2000),
    entry("base", ONE, null),
  ])

  assert.equal(portfolio.netUsd, 2000)
  assert.equal(portfolio.unpricedCount, 1)
  assert.equal(portfolio.entryCount, 2)

  const unpriced = portfolio.byNetwork[1]
  assert.equal(unpriced.networkKey, "base")
  assert.equal(unpriced.usd, null)
  assert.equal(unpriced.balance, ONE)
  assert.equal(unpriced.share, 0)
})

test("a portfolio where every price is missing reports zero with all entries unpriced", () => {
  const portfolio = aggregatePortfolio([entry("mainnet", ONE, null), entry("base", ONE, null)])

  assert.equal(portfolio.netUsd, 0)
  assert.equal(portfolio.unpricedCount, 2)
  assert.equal(portfolio.entryCount, 2)
  // Rows keep their balances so the UI can degrade to a balances-only view.
  assert.equal(portfolio.byNetwork.length, 2)
  assert.ok(portfolio.byNetwork.every((row) => row.balance === ONE))
})

test("malformed prices count as missing rather than being clamped", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const portfolio = aggregatePortfolio([entry("mainnet", ONE, bad)])
    assert.equal(portfolio.unpricedCount, 1, `price ${bad} must count as unpriced`)
    assert.equal(portfolio.netUsd, 0)
  }
})

test("values smaller than one whole unit survive by multiplying before dividing", () => {
  // 0.003 ETH at $1,000 is exactly $3. Dividing the balance by 1e18 before
  // multiplying would truncate it to zero and report a $3 holding as $0.
  const portfolio = aggregatePortfolio([entry("mainnet", 3n * 10n ** 15n, 1000)])
  assert.equal(portfolio.netUsd, 3)
})

test("totals sum exactly instead of accumulating float error", () => {
  // Three × $0.07 is exactly 0.21 in scaled integer math; repeated float
  // addition produces 0.21000000000000002.
  const portfolio = aggregatePortfolio([
    entry("mainnet", ONE, 0.07),
    entry("base", ONE, 0.07),
    entry("arbitrum", ONE, 0.07),
  ])
  assert.equal(portfolio.netUsd, 0.21)
})

test("usd conversion truncates toward zero and never rounds up", () => {
  // 1 wei at $5,000 is $0.000000000000005 — it must floor to zero, not round.
  assert.equal(aggregatePortfolio([entry("mainnet", 1n, 5000)]).netUsd, 0)

  // 1.000000000000000005 ETH at $1 is $1 plus dust; the dust is dropped.
  assert.equal(aggregatePortfolio([entry("mainnet", ONE + 5n, 1)]).netUsd, 1)
})

test("prices non-18-decimal assets correctly", () => {
  // Arc-style native USDC: 2.5 units at 6 decimals, worth $1 each.
  const portfolio = aggregatePortfolio([
    entry("arc-mainnet", 2_500_000n, 1, { decimals: 6, symbol: "USDC" }),
  ])
  assert.equal(portfolio.netUsd, 2.5)
  assert.equal(portfolio.byNetwork[0].usd, 2.5)
})

test("an entry with unusable decimals is treated as unpriced, not misvalued", () => {
  const portfolio = aggregatePortfolio([entry("mainnet", ONE, 2000, { decimals: -1 })])
  assert.equal(portfolio.unpricedCount, 1)
  assert.equal(portfolio.netUsd, 0)
})

test("rows order by value, with unpriced and zero rows last", () => {
  const portfolio = aggregatePortfolio([
    entry("zksync", ONE, 10),
    entry("polygon", 0n, 2000),
    entry("mainnet", 2n * ONE, 2000),
    entry("fantom", ONE, null),
  ])

  assert.deepEqual(
    portfolio.byNetwork.map((row) => row.networkKey),
    ["mainnet", "zksync", "fantom", "polygon"]
  )
})

test("a duplicate network+symbol entry replaces the earlier one", () => {
  const portfolio = aggregatePortfolio([
    entry("mainnet", ONE, 2000),
    entry("mainnet", 2n * ONE, 1000),
  ])

  // Totals are computed over the collapsed list, so rows and totals agree.
  assert.equal(portfolio.entryCount, 1)
  assert.equal(portfolio.byNetwork.length, 1)
  assert.equal(portfolio.byNetwork[0].balance, 2n * ONE)
  assert.equal(portfolio.netUsd, 2000)
})
