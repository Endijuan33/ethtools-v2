import assert from "node:assert/strict"
import { test } from "node:test"

import {
  clearChainMetadataCache,
  fetchChainMetadata,
  normalizeChainEntry,
  parseChainList,
} from "../chainMetadata.js"

/**
 * Unit tests for the chain-metadata lookup that prefills the custom-RPC form.
 * The network fetch is stubbed at the globalThis.fetch boundary; the pure
 * normalisers are exercised directly with hostile shapes.
 */

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

test("normalizes a complete registry entry", () => {
  const meta = normalizeChainEntry({
    chainId: 8453,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorers: [{ url: "https://basescan.org" }, { url: "http://insecure.example" }],
  })
  assert.ok(meta)
  assert.equal(meta.name, "Base")
  assert.equal(meta.currencySymbol, "ETH")
  assert.equal(meta.currencyName, "Ether")
  assert.equal(meta.decimals, 18)
  // The http:// explorer must never be offered — only https survives.
  assert.equal(meta.explorerUrl, "https://basescan.org")
})

test("drops trailing slashes from the explorer url", () => {
  const meta = normalizeChainEntry({
    chainId: 1,
    name: "Ethereum",
    nativeCurrency: { symbol: "ETH" },
    explorers: [{ url: "https://etherscan.io///" }],
  })
  assert.ok(meta)
  assert.equal(meta.explorerUrl, "https://etherscan.io")
})

test("keeps partial entries: a missing optional field does not discard the rest", () => {
  const meta = normalizeChainEntry({
    chainId: 42,
    name: "Some Chain",
    nativeCurrency: { symbol: "XYZ" },
    // no explorers, no decimals, no currency name
  })
  assert.ok(meta)
  assert.equal(meta.name, "Some Chain")
  assert.equal(meta.currencySymbol, "XYZ")
  assert.equal(meta.currencyName, null)
  assert.equal(meta.decimals, null)
  assert.equal(meta.explorerUrl, "")
})

test("rejects hostile or unusable entries", () => {
  // No name and no symbol: nothing worth prefilling.
  assert.equal(normalizeChainEntry({ chainId: 7 }), null)
  // Non-integer chain id.
  assert.equal(normalizeChainEntry({ chainId: 1.5, name: "X" }), null)
  // Oversized name.
  assert.equal(
    normalizeChainEntry({ chainId: 1, name: "X".repeat(65) }),
    null
  )
  // Oversized symbol.
  const longSymbol = normalizeChainEntry({
    chainId: 1,
    nativeCurrency: { symbol: "X".repeat(17) },
  })
  assert.equal(longSymbol, null)
  // Out-of-range decimals is dropped, but the rest of the entry survives.
  const badDecimals = normalizeChainEntry({
    chainId: 1,
    name: "Chain",
    nativeCurrency: { symbol: "C", decimals: 99 },
  })
  assert.ok(badDecimals)
  assert.equal(badDecimals.decimals, null)
  // Non-integer decimals is dropped the same way.
  const floatDecimals = normalizeChainEntry({
    chainId: 1,
    nativeCurrency: { symbol: "C", decimals: 18.5 },
  })
  assert.ok(floatDecimals)
  assert.equal(floatDecimals.decimals, null)
})

test("parseChainList rejects non-arrays and oversized lists", () => {
  assert.equal(parseChainList(null), null)
  assert.equal(parseChainList("chains"), null)
  assert.equal(parseChainList({}), null)
  assert.equal(parseChainList(new Array(20_001).fill({ chainId: 1 })), null)
  // Non-object entries are filtered out, objects survive.
  const parsed = parseChainList([{ chainId: 1 }, "junk", null, { chainId: 2 }])
  assert.equal(parsed?.length, 2)
})

test("fetchChainMetadata validates the chain id before any request", async () => {
  const result = await fetchChainMetadata(-1)
  assert.equal(result.ok, false)
  const fractional = await fetchChainMetadata(1.5)
  assert.equal(fractional.ok, false)
})

test("fetchChainMetadata returns null for a chain absent from the registry", async (t) => {
  clearChainMetadataCache()
  t.mock.method(globalThis, "fetch", async (): Promise<Response> => okResponse([]))
  const result = await fetchChainMetadata(999999)
  assert.ok(result.ok)
  assert.equal(result.value, null)
})

test("fetchChainMetadata finds the first usable duplicate entry", async (t) => {
  clearChainMetadataCache()
  const stub = t.mock.method(
    globalThis,
    "fetch",
    async (): Promise<Response> =>
      okResponse([
        { chainId: 100, name: "First (no currency)" },
        { chainId: 100, name: "Second", nativeCurrency: { symbol: "SEC" } },
      ])
  )
  const result = await fetchChainMetadata(100)
  assert.ok(result.ok && result.value)
  // The first entry normalises fine (it has a name), so it wins.
  assert.equal(result.value.name, "First (no currency)")
  assert.equal(stub.mock.callCount(), 1)
})

test("the registry is fetched once and cached for the session", async (t) => {
  clearChainMetadataCache()
  const stub = t.mock.method(
    globalThis,
    "fetch",
    async (): Promise<Response> =>
      okResponse([{ chainId: 5, name: "Cached", nativeCurrency: { symbol: "CCH" } }])
  )
  await fetchChainMetadata(5)
  await fetchChainMetadata(5)
  await fetchChainMetadata(6)
  assert.equal(stub.mock.callCount(), 1)
})

test("a failed registry fetch is retried on the next call, not cached as failure forever", async (t) => {
  clearChainMetadataCache()
  let fail = true
  const stub = t.mock.method(globalThis, "fetch", async (): Promise<Response> => {
    if (fail) throw new Error("network down")
    return okResponse([{ chainId: 9, name: "Recovered" }])
  })

  const first = await fetchChainMetadata(9)
  assert.equal(first.ok, false)
  assert.match("error" in first ? first.error : "", /Could not reach the chain registry/)

  fail = false
  const second = await fetchChainMetadata(9)
  assert.ok(second.ok && second.value)
  assert.equal(second.value.name, "Recovered")
  assert.equal(stub.mock.callCount(), 2)
})

test("an oversized registry response is refused", async (t) => {
  clearChainMetadataCache()
  t.mock.method(globalThis, "fetch", async (): Promise<Response> => {
    const huge = [{ chainId: 1, name: "X".repeat(1024) }]
    const text = JSON.stringify(huge).padEnd(9 * 1024 * 1024, " ")
    return new Response(text, { status: 200 })
  })
  const result = await fetchChainMetadata(1)
  assert.equal(result.ok, false)
  assert.match(
    "error" in result ? result.error : "",
    /unexpectedly large/
  )
})
