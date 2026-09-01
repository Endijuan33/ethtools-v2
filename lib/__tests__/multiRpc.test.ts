import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEGRADED_POOL_LATENCY_MS,
  RpcError,
  RpcPool,
  summarizePoolHealth,
  type EndpointHealthStatus,
  type PoolHealth,
} from "../multiRpc"
import { setLogSink } from "../logger"

/**
 * These tests exercise pool behaviour with fake work rather than a real provider.
 * `execute` hands a provider to a callback, so the callback can ignore it and
 * simulate whatever outcome the case needs.
 */

// The pool logs a warning per endpoint failure; silence it for readable output.
setLogSink(() => {})

const A = "https://a.example.com"
const B = "https://b.example.com"
const C = "https://c.example.com"

/** Fast options so retry paths do not add real delay. */
const FAST = { retryBackoffMs: 1, maxBackoffMs: 2, requestTimeoutMs: 200 } as const

function pool(urls: string[], options: Record<string, unknown> = {}): RpcPool {
  return new RpcPool(
    urls.map((url) => ({ url })),
    { ...FAST, ...options }
  )
}

test("rejects non-https endpoints at construction", () => {
  assert.throws(() => pool(["http://insecure.example.com"]), RpcError)
  assert.throws(() => pool(["not a url"]), RpcError)
  assert.throws(() => pool([]), RpcError)

  // A mixed list keeps only the secure entries.
  const mixed = new RpcPool([{ url: "http://bad.example.com" }, { url: A }], FAST)
  assert.equal(mixed.size, 1)
  mixed.destroy()
})

test("does not mutate the caller's endpoint array", () => {
  const input = [{ url: B, priority: 2 }, { url: A, priority: 1 }]
  const snapshot = [...input]
  const instance = new RpcPool(input, FAST)
  assert.deepEqual(input, snapshot, "constructor must not sort in place")
  instance.destroy()
})

test("returns the result when the first endpoint works", async () => {
  const instance = pool([A, B])
  try {
    const value = await instance.execute(async () => 42)
    assert.equal(value, 42)
  } finally {
    instance.destroy()
  }
})

test("fails over to another endpoint on a retryable error", async () => {
  const instance = pool([A, B, C], { attemptsPerEndpoint: 1 })
  try {
    let calls = 0
    const value = await instance.execute(async () => {
      calls++
      // Fail the first two attempts, succeed on the third.
      if (calls < 3) throw new Error("connection reset")
      return "ok"
    })

    assert.equal(value, "ok")
    assert.equal(calls, 3, "each endpoint should be tried once before succeeding")
  } finally {
    instance.destroy()
  }
})

test("retries the same endpoint before moving on", async () => {
  const instance = pool([A], { attemptsPerEndpoint: 3 })
  try {
    let calls = 0
    const value = await instance.execute(async () => {
      calls++
      if (calls < 3) throw new Error("timeout reading response")
      return "ok"
    })
    assert.equal(value, "ok")
    // attemptsPerEndpoint is honoured — it was dead configuration before.
    assert.equal(calls, 3)
  } finally {
    instance.destroy()
  }
})

test("throws RpcError with attempt count when every endpoint fails", async () => {
  const instance = pool([A, B], { attemptsPerEndpoint: 2 })
  try {
    await assert.rejects(
      () => instance.execute(async () => { throw new Error("network unreachable") }),
      (error: unknown) => {
        assert.ok(error instanceof RpcError)
        assert.equal(error.kind, "all-endpoints-failed")
        assert.equal(error.attempted, 4, "2 endpoints x 2 attempts")
        assert.ok(error.userMessage.length > 0)
        return true
      }
    )
  } finally {
    instance.destroy()
  }
})

test("surfaces a deterministic failure immediately without failing over", async () => {
  const instance = pool([A, B, C])
  try {
    let calls = 0
    await assert.rejects(
      () =>
        instance.execute(async () => {
          calls++
          // A revert returns the same answer everywhere, so retrying is pointless.
          throw new Error("execution reverted (CALL_EXCEPTION)")
        }),
      /reverted/
    )
    assert.equal(calls, 1, "a revert must not be retried across endpoints")
  } finally {
    instance.destroy()
  }
})

test("reports rate limiting distinctly so the UI can advise waiting", async () => {
  const instance = pool([A, B], { attemptsPerEndpoint: 1 })
  try {
    await assert.rejects(
      () => instance.execute(async () => { throw new Error("429 Too Many Requests") }),
      (error: unknown) => {
        assert.ok(error instanceof RpcError)
        assert.equal(error.kind, "rate-limited")
        assert.match(error.userMessage, /rate limiting/i)
        return true
      }
    )
  } finally {
    instance.destroy()
  }
})

test("times out slow work and reports it as a timeout", async () => {
  const instance = pool([A], { attemptsPerEndpoint: 1, requestTimeoutMs: 30 })
  try {
    await assert.rejects(
      () => instance.execute(() => new Promise(() => {})),
      (error: unknown) => {
        assert.ok(error instanceof RpcError)
        // The final error is the aggregate; the timeout is what drove it.
        assert.ok(error.kind === "timeout" || error.kind === "all-endpoints-failed")
        return true
      }
    )
  } finally {
    instance.destroy()
  }
})

test("honours an abort signal", async () => {
  const instance = pool([A, B])
  try {
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      () => instance.execute(async () => "never", controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof RpcError)
        assert.equal(error.kind, "aborted")
        return true
      }
    )
  } finally {
    instance.destroy()
  }
})

test("benches an endpoint after repeated failure and reports it unhealthy", async () => {
  const instance = pool([A, B], { attemptsPerEndpoint: 2, failureThreshold: 2 })
  try {
    await instance.execute(async () => { throw new Error("boom") }).catch(() => undefined)

    const health = instance.getHealth()
    assert.equal(health.totalEndpoints, 2)
    // Both endpoints failed twice, so both should now be benched.
    assert.equal(health.healthyEndpoints, 0)
    assert.equal(health.usable, false)
    assert.ok(health.endpoints.every((endpoint) => endpoint.cooldownRemainingMs > 0))
  } finally {
    instance.destroy()
  }
})

test("a benched endpoint is not revived early", async () => {
  // The previous implementation set healthy=false then immediately reverted it to
  // true in the same catch block, so nothing was ever actually benched.
  const instance = pool([A], { attemptsPerEndpoint: 1, failureThreshold: 1, cooldownMs: 60_000 })
  try {
    await instance.execute(async () => { throw new Error("boom") }).catch(() => undefined)
    const health = instance.getHealth()
    assert.equal(health.endpoints[0].healthy, false)
    assert.ok(health.endpoints[0].cooldownRemainingMs > 50_000)
  } finally {
    instance.destroy()
  }
})

test("still attempts work when every endpoint is benched", async () => {
  // A blanket cooldown must degrade, not hard-fail: the least recently benched
  // endpoint gets one more chance.
  const instance = pool([A], { attemptsPerEndpoint: 1, failureThreshold: 1, cooldownMs: 60_000 })
  try {
    await instance.execute(async () => { throw new Error("boom") }).catch(() => undefined)
    assert.equal(instance.getHealth().usable, false)

    const value = await instance.execute(async () => "recovered")
    assert.equal(value, "recovered")
    assert.equal(instance.getHealth().usable, true, "success must clear the bench")
  } finally {
    instance.destroy()
  }
})

test("success records latency and resets the failure counter", async () => {
  const instance = pool([A])
  try {
    await instance.execute(async () => "ok")
    const endpoint = instance.getHealth().endpoints[0]
    assert.equal(endpoint.consecutiveFailures, 0)
    assert.equal(endpoint.successes, 1)
    assert.ok(endpoint.latencyMs !== null && endpoint.latencyMs >= 0)
  } finally {
    instance.destroy()
  }
})

test("latency is null until measured", () => {
  const instance = pool([A])
  try {
    // Rendering an unmeasured endpoint as 0 ms would imply a perfect connection.
    assert.equal(instance.getHealth().endpoints[0].latencyMs, null)
    assert.equal(instance.getHealth().bestLatencyMs, null)
  } finally {
    instance.destroy()
  }
})

test("executeOnce does not fail over", async () => {
  const instance = pool([A, B, C])
  try {
    let calls = 0
    await assert.rejects(
      () =>
        instance.executeOnce(async () => {
          calls++
          throw new Error("connection reset")
        })
    )
    // Broadcasting must never be retried: a retry could submit twice.
    assert.equal(calls, 1)
  } finally {
    instance.destroy()
  }
})

test("a destroyed pool refuses further work", async () => {
  const instance = pool([A])
  instance.destroy()

  assert.equal(instance.isDestroyed, true)
  await assert.rejects(
    () => instance.execute(async () => "nope"),
    (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.kind, "destroyed")
      return true
    }
  )
})

test("destroy is idempotent", () => {
  const instance = pool([A])
  instance.destroy()
  assert.doesNotThrow(() => instance.destroy())
})

test("spreads load across endpoints rather than pinning one", async () => {
  const instance = pool([A, B, C])
  try {
    // The rotation cursor should not hand back the same ordering every time.
    const firsts = new Set<string>()
    for (let i = 0; i < 6; i++) {
      await instance.execute(async (provider) => {
        firsts.add(provider._getConnection().url)
        return true
      })
    }
    assert.ok(firsts.size > 1, "requests should not all target one endpoint")
  } finally {
    instance.destroy()
  }
})

// ===== Failover counting =====

test("counts one failover each time work moves to another endpoint", async () => {
  const instance = pool([A, B, C], { attemptsPerEndpoint: 1 })
  try {
    let calls = 0
    const value = await instance.execute(async () => {
      calls++
      // Two endpoints fail out, the third answers.
      if (calls < 3) throw new Error("connection reset")
      return "ok"
    })

    assert.equal(value, "ok")
    assert.equal(instance.getHealth().failovers, 2)
  } finally {
    instance.destroy()
  }
})

test("does not count a failover when the final endpoint fails", async () => {
  const instance = pool([A], { attemptsPerEndpoint: 2 })
  try {
    await instance.execute(async () => { throw new Error("network unreachable") }).catch(() => undefined)
    // Nowhere was left to move to, so the failure is an error, not a failover.
    assert.equal(instance.getHealth().failovers, 0)
  } finally {
    instance.destroy()
  }
})

test("does not count a failover for a deterministic failure", async () => {
  const instance = pool([A, B], { attemptsPerEndpoint: 1 })
  try {
    await instance
      .execute(async () => { throw new Error("execution reverted (CALL_EXCEPTION)") })
      .catch(() => undefined)
    // A revert is surfaced immediately; no other endpoint is ever contacted.
    assert.equal(instance.getHealth().failovers, 0)
  } finally {
    instance.destroy()
  }
})

// ===== Health tier classification =====

/** Endpoint literal with defaults, so each case states only what it varies. */
function ep(partial: Partial<EndpointHealthStatus> = {}): EndpointHealthStatus {
  return {
    url: A,
    healthy: true,
    cooldownRemainingMs: 0,
    latencyMs: 120,
    consecutiveFailures: 0,
    successes: 3,
    failures: 0,
    ...partial,
  }
}

/** Pool literal that mirrors the derivation `getHealth` performs. */
function ph(endpoints: EndpointHealthStatus[], extra: Partial<PoolHealth> = {}): PoolHealth {
  const healthy = endpoints.filter((endpoint) => endpoint.healthy)
  const latencies = healthy
    .map((endpoint) => endpoint.latencyMs)
    .filter((value): value is number => value !== null)
  return {
    usable: healthy.length > 0,
    totalEndpoints: endpoints.length,
    healthyEndpoints: healthy.length,
    bestLatencyMs: latencies.length > 0 ? Math.min(...latencies) : null,
    failovers: 0,
    endpoints,
    ...extra,
  }
}

test("classifies an absent pool as idle", () => {
  // Claiming an uncontacted network is healthy would assert the unobserved.
  assert.equal(summarizePoolHealth(null).tier, "idle")
})

test("classifies an unmeasured pool as idle, not healthy", () => {
  const health = ph([ep({ successes: 0, failures: 0, latencyMs: null })])
  assert.equal(summarizePoolHealth(health).tier, "idle")
})

test("classifies a fully working pool as healthy", () => {
  const summary = summarizePoolHealth(ph([ep(), ep({ url: B, latencyMs: 200 })]))
  assert.equal(summary.tier, "healthy")
  assert.match(summary.reason, /2 endpoints responding/)
})

test("classifies a pool with every endpoint benched as down", () => {
  const benched = { healthy: false, cooldownRemainingMs: 40_000, consecutiveFailures: 2, failures: 2 }
  const summary = summarizePoolHealth(ph([ep(benched), ep({ url: B, ...benched })]))
  assert.equal(summary.tier, "down")
  assert.match(summary.reason, /cooldown/)
})

test("classifies a pool with a benched endpoint as degraded", () => {
  const summary = summarizePoolHealth(
    ph([ep(), ep({ url: B, healthy: false, cooldownRemainingMs: 40_000, consecutiveFailures: 2, failures: 2 })])
  )
  assert.equal(summary.tier, "degraded")
  assert.match(summary.reason, /1 of 2 endpoints in cooldown/)
})

test("classifies a wobbling endpoint as degraded before it is benched", () => {
  // A single failure stays under the benching threshold, but "healthy" must
  // still mean "no failures", not "not bad enough to bench yet".
  const summary = summarizePoolHealth(ph([ep({ consecutiveFailures: 1, failures: 1 })]))
  assert.equal(summary.tier, "degraded")
  assert.match(summary.reason, /1 endpoint is failing/)
})

test("classifies a slow-but-working pool as degraded", () => {
  const summary = summarizePoolHealth(ph([ep({ latencyMs: DEGRADED_POOL_LATENCY_MS })]))
  assert.equal(summary.tier, "degraded")
  // Just under the threshold stays healthy, so the boundary is exact.
  assert.equal(summarizePoolHealth(ph([ep({ latencyMs: DEGRADED_POOL_LATENCY_MS - 1 })])).tier, "healthy")
})
