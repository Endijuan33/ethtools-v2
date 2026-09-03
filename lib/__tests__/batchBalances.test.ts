
import { test } from "node:test"
import assert from "node:assert/strict"

import { getAddress } from "ethers"

import {
  MAX_BATCH_ADDRESSES,
  parseAddressList,
  sumBalancesBySymbol,
  type NetworkBalanceResult,
} from "../batchBalances"

/** Two real, distinct addresses used across the fixtures. */
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
const RECIPIENT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72"

function balance(
  symbol: string,
  value: bigint | null,
  decimals = 18
): NetworkBalanceResult {
  return {
    network: symbol.toLowerCase(),
    name: symbol,
    symbol,
    decimals,
    value,
    error: value === null ? "lookup failed" : null,
  }
}

// ---------- parseAddressList ----------

test("parseAddressList accepts valid lines and skips blank ones", () => {
  const parsed = parseAddressList(`\n${VITALIK}\n\n   ${RECIPIENT}  \n\n`)
  assert.deepEqual(parsed.addresses, [getAddress(VITALIK), getAddress(RECIPIENT)])
  assert.deepEqual(parsed.invalidLines, [])
  assert.equal(parsed.error, undefined)
})

test("parseAddressList deduplicates case-insensitively, keeping the first spelling", () => {
  const upperSpelled = `0x${VITALIK.slice(2).toUpperCase()}`
  const parsed = parseAddressList([VITALIK, VITALIK.toLowerCase(), upperSpelled, RECIPIENT].join("\n"))
  assert.deepEqual(parsed.addresses, [getAddress(VITALIK), getAddress(RECIPIENT)])
  assert.deepEqual(parsed.invalidLines, [])
})

test("parseAddressList reports each invalid line with its 1-based line number", () => {
  const parsed = parseAddressList(
    [VITALIK, "not-an-address", "", "0x1234", RECIPIENT].join("\n")
  )
  assert.equal(parsed.addresses.length, 2)
  assert.deepEqual(
    parsed.invalidLines.map((invalid) => invalid.line),
    [2, 4]
  )
  assert.match(parsed.invalidLines[0].reason, /not a valid Ethereum address/)
})

test("parseAddressList rejects an empty or whitespace-only text with nothing", () => {
  assert.deepEqual(parseAddressList(""), { addresses: [], invalidLines: [] })
  assert.deepEqual(parseAddressList(" \n\t\n"), { addresses: [], invalidLines: [] })
})

test("parseAddressList fails honestly when the unique count exceeds the cap", () => {
  const many = Array.from(
    { length: MAX_BATCH_ADDRESSES + 2 },
    (_, index) => getAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`)
  )
  const parsed = parseAddressList(many.join("\n"))
  assert.equal(parsed.addresses.length, MAX_BATCH_ADDRESSES)
  assert.match(parsed.error ?? "", new RegExp(`At most ${MAX_BATCH_ADDRESSES}`))
  assert.match(parsed.error ?? "", /27/)
})

test("parseAddressList honours a custom cap and does not count duplicates against it", () => {
  const twice = `${VITALIK}\n${VITALIK}`
  assert.equal(parseAddressList(twice, 1).error, undefined)

  const parsed = parseAddressList(`${VITALIK}\n${RECIPIENT}`, 1)
  assert.equal(parsed.addresses.length, 1)
  assert.match(parsed.error ?? "", /At most 1/)
})

test("parseAddressList truncates a hostile oversized line in the echoed reason", () => {
  const hostile = `${"A".repeat(500)}`
  const parsed = parseAddressList(hostile)
  assert.equal(parsed.addresses.length, 0)
  assert.equal(parsed.invalidLines.length, 1)
  // The echo is bounded: a snippet plus ellipsis, never the whole 500 chars.
  assert.ok(parsed.invalidLines[0].reason.length < 120)
  assert.match(parsed.invalidLines[0].reason, /…" is not a valid Ethereum address/)
})

test("parseAddressList checksums accepted addresses", () => {
  const parsed = parseAddressList(VITALIK.toLowerCase())
  assert.equal(parsed.addresses[0], getAddress(VITALIK))
  assert.notEqual(parsed.addresses[0], VITALIK.toLowerCase())
})

// ---------- sumBalancesBySymbol ----------

test("sumBalancesBySymbol groups only same-symbol balances", () => {
  const totals = sumBalancesBySymbol([
    balance("ETH", 1_000_000_000_000_000_000n),
    balance("ETH", 500_000_000_000_000_000n),
    balance("BNB", 2n),
    balance("MATIC", 7n),
  ])
  assert.deepEqual(
    totals.map((total) => [total.symbol, total.total]),
    [
      ["ETH", 1_500_000_000_000_000_000n],
      ["BNB", 2n],
      ["MATIC", 7n],
    ]
  )
})

test("sumBalancesBySymbol lists ETH first regardless of input order", () => {
  const totals = sumBalancesBySymbol([balance("MATIC", 1n), balance("ETH", 2n), balance("BNB", 3n)])
  assert.deepEqual(
    totals.map((total) => total.symbol),
    ["ETH", "BNB", "MATIC"]
  )
})

test("sumBalancesBySymbol excludes failed lookups rather than counting them as zero", () => {
  const totals = sumBalancesBySymbol([balance("ETH", 5n), balance("ETH", null)])
  assert.equal(totals.length, 1)
  assert.equal(totals[0].total, 5n)
})

test("sumBalancesBySymbol keeps same-symbol different-decimals totals apart", () => {
  const totals = sumBalancesBySymbol([balance("ETH", 5n, 18), balance("ETH", 5n, 6)])
  assert.equal(totals.length, 2)
})

test("sumBalancesBySymbol returns nothing when every lookup failed", () => {
  assert.deepEqual(sumBalancesBySymbol([balance("ETH", null), balance("BNB", null)]), [])
})
