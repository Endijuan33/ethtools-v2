import { after, before, beforeEach, test } from "node:test"
import assert from "node:assert/strict"

import {
  clearPriceHistoryCache,
  fetchPriceHistory,
  getPriceHistoryCacheStats,
  parsePriceSeries,
  summarizePriceSeries,
  SERIES_CACHE_TTL_MS,
  type PriceHistoryRange,
  type PricePoint,
} from "../priceHistory"
import { setLogSink } from "../logger"

/**
 * These tests cover the pure series math and the cache, never the network:
 * `fetchPriceHistory`'s outbound call is pointed at a stubbed `globalThis.fetch`
 * (auto-restored by the test context), so rate-limit, offline, and
 * cache-expiry behaviour are all exercised deterministically.
 */

// The failure-path tests intentionally trip warn-level logs; silence them so
// the test output stays about assertions.
before(() => setLogSink(() => undefined))
after(() => setLogSink(null))

// The cache is module state; every test starts from an empty one.
beforeEach(() => clearPriceHistoryCache())

/** Unwrap a successful result, failing the test with the error otherwise. */
function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) assert.fail(`expected a success but got: ${result.error}`)
  return result.value
}

/** Unwrap a failed result, failing the test when it unexpectedly succeeded. */
function expectError<T>(result: { ok: true; value: T } | { ok: false; error: string }): string {
  if (result.ok) assert.fail("expected a failure but the operation succeeded")
  return result.error
}

/** A `market_chart` body shaped the way CoinGecko documents it. */
function marketChartBody(points: ReadonlyArray<[number, number]>): unknown {
  return { prices: points.map(([timestamp, price]) => [timestamp, price]) }
}

/** A successful JSON fetch response carrying `body`. */
function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// ---------- summarizePriceSeries ----------

test("summarizes an ascending series", () => {
  const summary = summarizePriceSeries([
    { timestamp: 0, price: 100 },
    { timestamp: 1, price: 150 },
    { timestamp: 2, price: 120 },
    { timestamp: 3, price: 200 },
  ])

  assert.ok(summary !== null)
  assert.equal(summary.first, 100)
  assert.equal(summary.last, 200)
  assert.equal(summary.high, 200)
  assert.equal(summary.low, 100)
  assert.equal(summary.changePct, 100)
})

test("derives first and last from timestamps, not input order", () => {
  const summary = summarizePriceSeries([
    { timestamp: 3_000, price: 50 },
    { timestamp: 1_000, price: 100 },
    { timestamp: 2_000, price: 75 },
  ])

  // Sorted: 100 → 75 → 50, so the trend is down despite the array order.
  assert.equal(summary?.first, 100)
  assert.equal(summary?.last, 50)
  assert.equal(summary?.changePct, -50)
  assert.equal(summary?.high, 100)
  assert.equal(summary?.low, 50)
})

test("drops malformed points instead of letting one poison the statistics", () => {
  const summary = summarizePriceSeries([
    { timestamp: 1, price: 10 },
    null,
    undefined,
    { timestamp: 2, price: Number.NaN },
    { timestamp: 3, price: Number.POSITIVE_INFINITY },
    // A zero or negative price is not a quote, and must not become the low.
    { timestamp: 4, price: 0 },
    { timestamp: 5, price: -3 },
    { timestamp: Number.NaN, price: 12 },
    { timestamp: 6, price: 20 },
  ] as unknown as readonly PricePoint[])

  assert.equal(summary?.first, 10)
  assert.equal(summary?.last, 20)
  assert.equal(summary?.high, 20)
  assert.equal(summary?.low, 10)
  assert.equal(summary?.changePct, 100)
})

test("returns null for an empty or wholly unusable series", () => {
  assert.equal(summarizePriceSeries([]), null)
  assert.equal(
    summarizePriceSeries([null, { timestamp: 1, price: Number.NaN }] as unknown as readonly PricePoint[]),
    null
  )
})

test("a single point is a flat window: first equals last and change is zero", () => {
  const summary = summarizePriceSeries([{ timestamp: 5, price: 42 }])

  assert.equal(summary?.first, 42)
  assert.equal(summary?.last, 42)
  assert.equal(summary?.changePct, 0)
  assert.equal(summary?.high, 42)
  assert.equal(summary?.low, 42)
})

test("change is measured against the first price, not the window length", () => {
  const summary = summarizePriceSeries([
    { timestamp: 1, price: 4 },
    { timestamp: 2, price: 5 },
  ])

  assert.equal(summary?.changePct, 25)
})

// ---------- parsePriceSeries ----------

test("parses the documented market_chart shape", () => {
  const points = parsePriceSeries({ prices: [[1000, 3.5], [2000, 4], [3000, 3.75]] })

  assert.deepEqual(points, [
    { timestamp: 1000, price: 3.5 },
    { timestamp: 2000, price: 4 },
    { timestamp: 3000, price: 3.75 },
  ])
})

test("sorts an unsorted response into ascending order", () => {
  const points = parsePriceSeries({ prices: [[3000, 3.75], [1000, 3.5], [2000, 4]] })

  assert.deepEqual(
    points.map((point) => point.timestamp),
    [1000, 2000, 3000]
  )
})

test("rejects payloads that are not an object with a prices array", () => {
  const unusable: unknown[] = [
    null,
    undefined,
    42,
    "prices",
    {},
    { prices: "nope" },
    { prices: 7 },
    [],
  ]

  for (const payload of unusable) {
    assert.deepEqual(parsePriceSeries(payload), [], `payload: ${JSON.stringify(payload)}`)
  }
})

test("skips malformed entries rather than failing the whole series", () => {
  const points = parsePriceSeries({
    prices: [
      [1000, 3.5],
      null,
      "junk",
      [2000],
      [2100, 4, "extra"],
      [Number.NaN, 5],
      [2200, Number.NaN],
      [2300, -1],
      [2400, 0],
      [2500, "6"],
      { timestamp: 2600, price: 7 },
      [3000, 4.25],
    ],
  })

  assert.deepEqual(points, [
    { timestamp: 1000, price: 3.5 },
    { timestamp: 2100, price: 4 },
    { timestamp: 3000, price: 4.25 },
  ])
})

// ---------- fetchPriceHistory (stubbed network) ----------

test("requests the documented endpoint and parses the response", async (t) => {
  const stub = t.mock.method(
    globalThis,
    "fetch",
    async (): Promise<Response> => okResponse(marketChartBody([[1000, 10], [2000, 12]]))
  )

  const result = await fetchPriceHistory("ethereum", 7)

  assert.deepEqual(expectOk(result), [
    { timestamp: 1000, price: 10 },
    { timestamp: 2000, price: 12 },
  ])
  assert.equal(stub.mock.callCount(), 1)

  const calledUrl = stub.mock.calls[0].arguments[0] as URL
  assert.ok(calledUrl instanceof URL)
  assert.equal(calledUrl.pathname, "/api/v3/coins/ethereum/market_chart")
  assert.equal(calledUrl.searchParams.get("vs_currency"), "usd")
  assert.equal(calledUrl.searchParams.get("days"), "7")
})

test("serves a cached series without refetching inside the TTL window", async (t) => {
  let clock = 1_000_000
  const realNow = Date.now
  Date.now = () => clock
  try {
    const stub = t.mock.method(
      globalThis,
      "fetch",
      async (): Promise<Response> => okResponse(marketChartBody([[1, 2]]))
    )

    const first = await fetchPriceHistory("ethereum", 7)
    const second = await fetchPriceHistory("ethereum", 7)
    assert.equal(expectOk(first).length, 1)
    assert.equal(expectOk(second).length, 1)
    assert.equal(stub.mock.callCount(), 1)

    clock += SERIES_CACHE_TTL_MS + 1
    const third = await fetchPriceHistory("ethereum", 7)
    assert.equal(expectOk(third).length, 1)
    assert.equal(stub.mock.callCount(), 2)
  } finally {
    Date.now = realNow
  }
})

test("caches per coin and per range", async (t) => {
  const stub = t.mock.method(
    globalThis,
    "fetch",
    async (): Promise<Response> => okResponse(marketChartBody([[1, 2]]))
  )

  await fetchPriceHistory("ethereum", 7)
  await fetchPriceHistory("ethereum", 30)
  await fetchPriceHistory("matic-network", 7)
  // Repeat reads inside the TTL: all served from the cache.
  await fetchPriceHistory("ethereum", 7)
  await fetchPriceHistory("matic-network", 7)

  assert.equal(stub.mock.callCount(), 3)
  assert.equal(getPriceHistoryCacheStats().entries, 3)
})

test("a rate-limited response is remembered for the TTL window", async (t) => {
  let clock = 5_000_000
  const realNow = Date.now
  Date.now = () => clock
  try {
    const stub = t.mock.method(
      globalThis,
      "fetch",
      async (): Promise<Response> => new Response("rate limited", { status: 429 })
    )

    const first = expectError(await fetchPriceHistory("ethereum", 7))
    assert.match(first, /rate limited/i)

    // A retry inside the window is served from the negative cache: no request.
    const second = expectError(await fetchPriceHistory("ethereum", 7))
    assert.match(second, /rate limited/i)
    assert.equal(stub.mock.callCount(), 1)

    // After the window, the request goes back out.
    clock += SERIES_CACHE_TTL_MS + 1
    expectError(await fetchPriceHistory("ethereum", 7))
    assert.equal(stub.mock.callCount(), 2)
  } finally {
    Date.now = realNow
  }
})

test("a non-429 failure is not cached, so a retry goes back out", async (t) => {
  const stub = t.mock.method(
    globalThis,
    "fetch",
    async (): Promise<Response> => new Response("unavailable", { status: 503 })
  )

  expectError(await fetchPriceHistory("ethereum", 7))
  expectError(await fetchPriceHistory("ethereum", 7))

  assert.equal(stub.mock.callCount(), 2)
  assert.equal(getPriceHistoryCacheStats().entries, 0)
})

test("a network failure returns an error sentence instead of throwing", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (): Promise<Response> => {
      throw new TypeError("fetch failed")
    }
  )

  const error = expectError(await fetchPriceHistory("ethereum", 7))
  assert.equal(error.length > 0, true)
  assert.equal(getPriceHistoryCacheStats().entries, 0)
})

test("a well-formed response with no usable points is an error, not an empty chart", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (): Promise<Response> => okResponse({ prices: [] })
  )

  const error = expectError(await fetchPriceHistory("ethereum", 7))
  assert.equal(error.length > 0, true)
})

test("an aborted request reports cancellation and caches nothing", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      // Behave like the real fetch: reject when the abort signal fires.
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"))
        })
      })
  )

  const controller = new AbortController()
  const pending = fetchPriceHistory("ethereum", 7, controller.signal)
  controller.abort()
  const error = expectError(await pending)
  assert.match(error, /cancel/i)

  assert.equal(getPriceHistoryCacheStats().entries, 0)
})

test("rejects an empty coin id and an unsupported range without a request", async (t) => {
  const stub = t.mock.method(
    globalThis,
    "fetch",
    async (): Promise<Response> => okResponse(marketChartBody([[1, 1]]))
  )

  expectError(await fetchPriceHistory("", 7))
  expectError(await fetchPriceHistory("ethereum", 14 as unknown as PriceHistoryRange))

  assert.equal(stub.mock.callCount(), 0)
})
