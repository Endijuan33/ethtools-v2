import { test } from "node:test"
import assert from "node:assert/strict"

import {
  MAX_TOKENS_PER_NETWORK,
  normalizeTokenBalances,
  EXPLORER_APIS,
} from "../tokenDetection"

/**
 * These tests cover the pure normalizer only. `normalizeTokenBalances` is the
 * security boundary between the explorer and the UI, so every filtering,
 * ranking, and capping rule is exercised with plain fixtures — no network and
 * no mocks. The explorer payload is hostile input by assumption: real samples
 * from Blockscout carry spam reputation flags, string decimals, null values,
 * and thousands of dust entries on popular addresses.
 */

const ETH = 18

/** A distinct valid address per index, so dedupe and tiebreak assertions stay unambiguous. */
function addr(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`
}

/** One whole unit of an 18-decimal asset. */
const ONE = 10n ** 18n

/**
 * A boring valid ERC-20 entry. `token` and `value` are overridable so each test
 * states only its point.
 */
function entry(
  index: number,
  overrides: {
    token?: Record<string, unknown>
    value?: unknown
  } = {}
): Record<string, unknown> {
  return {
    token: {
      address_hash: addr(index),
      decimals: String(ETH),
      exchange_rate: null,
      holders_count: "1",
      name: `Token ${index}`,
      reputation: "ok",
      symbol: `T${index}`,
      type: "ERC-20",
      ...overrides.token,
    },
    value: "1000000000000000000",
    ...("value" in overrides ? { value: overrides.value } : {}),
  }
}

test("an empty payload normalizes to an empty list", () => {
  const result = normalizeTokenBalances([], "mainnet")
  assert.deepEqual(result.tokens, [])
  assert.equal(result.moreCount, 0)
})

test("a non-array payload normalizes to an empty list without throwing", () => {
  for (const payload of [null, undefined, {}, "nope", 42, { items: [] }]) {
    const result = normalizeTokenBalances(payload, "mainnet")
    assert.deepEqual(result.tokens, [], `payload ${String(payload)} must yield no tokens`)
    assert.equal(result.moreCount, 0)
  }
})

test("only ERC-20 entries are kept", () => {
  const result = normalizeTokenBalances(
    [
      entry(1),
      entry(2, { token: { type: "ERC-721" } }),
      entry(3, { token: { type: "ERC-1155" } }),
      entry(4, { token: { type: "ERC-404" } }),
    ],
    "mainnet"
  )

  assert.equal(result.tokens.length, 1)
  assert.equal(result.tokens[0].address, addr(1))
})

test("spam-reputation entries are excluded", () => {
  const result = normalizeTokenBalances(
    [entry(1), entry(2, { token: { reputation: "spam" } })],
    "mainnet"
  )

  assert.equal(result.tokens.length, 1)
  assert.equal(result.tokens[0].address, addr(1))
})

test("null, zero, negative, fractional, and non-string values are excluded", () => {
  const result = normalizeTokenBalances(
    [
      entry(1, { value: null }),
      entry(2, { value: "0" }),
      entry(3, { value: "-5" }),
      entry(4, { value: "1.5" }),
      entry(5, { value: 0 }),
      entry(6, { value: 12.5 }),
      entry(7, { value: {} }),
      entry(8, { value: undefined }),
      entry(9, { value: "0x10" }),
    ],
    "mainnet"
  )

  assert.deepEqual(result.tokens, [])
})

test("priced tokens rank by USD value descending", () => {
  const result = normalizeTokenBalances(
    [
      entry(1, { token: { exchange_rate: "2" }, value: "1000000000000000000" }), // $2
      entry(2, { token: { exchange_rate: "5000" }, value: "3000000000000000000" }), // $15000
      entry(3, { token: { exchange_rate: "0.5" }, value: "1000000000000000000" }), // $0.50
    ],
    "mainnet"
  )

  assert.deepEqual(
    result.tokens.map((token) => token.address),
    [addr(2), addr(1), addr(3)]
  )
  assert.equal(result.tokens[0].usdValue, 15000)
  assert.equal(result.tokens[1].usdValue, 2)
  assert.equal(result.tokens[2].usdValue, 0.5)
})

test("unpriced tokens sort after priced ones, by raw balance magnitude", () => {
  const result = normalizeTokenBalances(
    [
      // A huge unpriced balance must not outrank even a small priced one.
      entry(1, { token: { exchange_rate: null }, value: (10n ** 30n).toString() }),
      entry(2, { token: { exchange_rate: "0.01" }, value: "1000000000000000000" }), // $0.01
      entry(3, { token: { exchange_rate: null }, value: (10n ** 24n).toString() }),
    ],
    "mainnet"
  )

  assert.deepEqual(
    result.tokens.map((token) => token.address),
    [addr(2), addr(1), addr(3)]
  )
  assert.equal(result.tokens[0].usdValue, 0.01)
  assert.equal(result.tokens[1].usdValue, null)
  assert.equal(result.tokens[2].usdValue, null)
})

test("a garbage exchange rate degrades to unpriced, not to a dropped or bogus value", () => {
  const result = normalizeTokenBalances(
    [
      entry(1, { token: { exchange_rate: "not-a-number" } }),
      entry(2, { token: { exchange_rate: "-3" } }),
      entry(3, { token: { exchange_rate: "1e999" } }),
      entry(4, { token: { exchange_rate: {} } }),
    ],
    "mainnet"
  )

  assert.equal(result.tokens.length, 4)
  for (const token of result.tokens) {
    assert.equal(token.usdValue, null)
    assert.equal(token.exchangeRate, null)
  }
})

test("the list is capped at the per-network maximum with an honest remainder count", () => {
  assert.equal(MAX_TOKENS_PER_NETWORK, 15)

  // Distinct prices so the ranking is unambiguous: token n is worth $n.
  const payload = Array.from({ length: 23 }, (_, index) =>
    entry(index + 1, { token: { exchange_rate: String(index + 1) } })
  )
  const result = normalizeTokenBalances(payload, "mainnet")

  assert.equal(result.tokens.length, 15)
  assert.equal(result.moreCount, 8)
  // The cap must keep the top of the ranking ($23 down to $9), not an
  // arbitrary prefix. (Addresses are re-checksummed, so compare lowercased.)
  assert.deepEqual(
    result.tokens.map((token) => token.address.toLowerCase()),
    Array.from({ length: 15 }, (_, index) => addr(23 - index))
  )
})

test("exactly at the cap there is no remainder", () => {
  const payload = Array.from({ length: 15 }, (_, index) => entry(index + 1))
  const result = normalizeTokenBalances(payload, "mainnet")

  assert.equal(result.tokens.length, 15)
  assert.equal(result.moreCount, 0)
})

test("hostile entries are discarded safely while valid siblings survive", () => {
  const result = normalizeTokenBalances(
    [
      entry(1, { token: { decimals: null } }),
      entry(2, { token: { address_hash: "not-an-address" } }),
      entry(3, { token: { address_hash: "0xzzzz" } }),
      entry(4, { token: { decimals: "abc" } }),
      entry(5, { token: { decimals: "-1" } }),
      entry(6, { token: { decimals: "1.5" } }),
      entry(7, { token: { symbol: null } }),
      entry(8, { token: { name: null } }),
      entry(9, { token: { name: "" } }),
      entry(10, { token: { symbol: "   " } }),
      // Not a record at all.
      "just a string",
      42,
      null,
      { token: null, value: "1" },
      {},
      // The valid sibling that must survive all of the above.
      entry(99),
    ],
    "mainnet"
  )

  assert.equal(result.tokens.length, 1)
  assert.equal(result.tokens[0].address, addr(99))
})

test("a 300-character symbol is clamped, not rendered whole and not dropped", () => {
  const longSymbol = "A".repeat(300)
  const longName = "B".repeat(300)
  const result = normalizeTokenBalances(
    [entry(1, { token: { symbol: longSymbol, name: longName } })],
    "mainnet"
  )

  assert.equal(result.tokens.length, 1)
  const token = result.tokens[0]
  assert.ok(token.symbol.length <= 17, "symbol must be clamped")
  assert.ok(token.symbol.endsWith("…"))
  assert.ok(token.name.length <= 65, "name must be clamped")
  assert.ok(token.name.endsWith("…"))
})

test("control characters in free text are neutralized", () => {
  const result = normalizeTokenBalances(
    [entry(1, { token: { name: "Evil\nName\tHere", symbol: "E\rV" } })],
    "mainnet"
  )

  assert.equal(result.tokens.length, 1)
  assert.equal(result.tokens[0].name, "Evil Name Here")
  assert.equal(result.tokens[0].symbol, "E V")
})

test("numeric decimals and exchange_rate fields are accepted", () => {
  // One whole unit at 6 decimals, priced at $1.25.
  const result = normalizeTokenBalances(
    [entry(1, { token: { decimals: 6, exchange_rate: 1.25 }, value: "1000000" })],
    "mainnet"
  )

  assert.equal(result.tokens[0].decimals, 6)
  assert.equal(result.tokens[0].exchangeRate, 1.25)
  assert.equal(result.tokens[0].usdValue, 1.25)
})

test("balances stay exact bigint base units until display", () => {
  const raw = "10000000000000000000000000000"
  const result = normalizeTokenBalances([entry(1, { value: raw })], "mainnet")

  assert.equal(result.tokens[0].value, BigInt(raw))
})

test("tokens are stamped with the network key and a checksummed address", () => {
  // A 40-hex-character all-lowercase address; the normalizer must return the
  // EIP-55 checksum form, which differs from the input casing.
  const lower = `0x${"ab".repeat(20)}`
  const result = normalizeTokenBalances(
    [entry(1, { token: { address_hash: lower } })],
    "base-sepolia"
  )

  assert.equal(result.tokens[0].networkKey, "base-sepolia")
  // EIP-55 checksum form, which differs from the all-lowercase input.
  assert.notEqual(result.tokens[0].address, lower)
})

test("a duplicate contract keeps only the larger claimed balance", () => {
  const result = normalizeTokenBalances(
    [
      entry(1, { value: "100" }),
      entry(1, { value: "999" }),
      entry(1, { value: "500" }),
    ],
    "mainnet"
  )

  assert.equal(result.tokens.length, 1)
  assert.equal(result.tokens[0].value, 999n)
})

test("the explorer registry covers exactly the seven verified networks", () => {
  assert.deepEqual(Object.keys(EXPLORER_APIS), [
    "mainnet",
    "polygon",
    "arbitrum",
    "optimism",
    "sepolia",
    "base-sepolia",
    "optimism-sepolia",
  ])
  for (const { base } of Object.values(EXPLORER_APIS)) {
    assert.ok(base.startsWith("https://"), "every explorer base must be https")
  }
})
