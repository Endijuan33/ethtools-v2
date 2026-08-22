/**
 * Multi-endpoint RPC access with real failover.
 *
 * The previous implementation had a structural flaw: `getProvider()` tested one
 * endpoint, then returned a bare single-URL `JsonRpcProvider`. Every subsequent
 * call on that object — `getBalance`, `estimateGas`, `sendTransaction` — went to
 * that one URL with no retry and no failover. Only the initial handshake was
 * protected, which is the part that matters least.
 *
 * This version inverts the model. Callers do not hold a provider; they hand a
 * unit of work to {@link RpcPool.execute}, which runs it against a healthy
 * endpoint and re-runs it elsewhere on failure. Failover therefore applies to
 * every request, which is the only place it is useful.
 *
 * Three further defects are fixed:
 * - The old health checker could never mark an endpoint unhealthy: it set
 *   `healthy = false` and then, in the same `catch`, reverted it to `true`,
 *   because the revive cooldown compared against a `lastCheck` that was only
 *   refreshed on success.
 * - `retryCount` was dead configuration; the tried-endpoint set was exhausted
 *   before the attempt budget could be reached, so each endpoint was tried once.
 * - Providers were constructed at three sites and never destroyed, leaking a
 *   polling provider per health check, per minute, indefinitely.
 */

import { JsonRpcProvider, type Networkish } from "ethers"
import { logger } from "./logger"

/** A single RPC endpoint. */
export interface RpcEndpoint {
  /** Endpoint URL. Must be `https:`. */
  url: string
  /** Lower sorts first. Defaults to 1. */
  priority?: number
}

/** Tuning for a pool. */
export interface RpcPoolOptions {
  /** Attempts per endpoint before moving on. Default 2. */
  attemptsPerEndpoint?: number
  /** Per-request timeout in ms. Default 12000. */
  requestTimeoutMs?: number
  /** Base backoff in ms; doubles per attempt. Default 400. */
  retryBackoffMs?: number
  /** Backoff ceiling in ms. Default 4000. */
  maxBackoffMs?: number
  /** How long an endpoint stays benched after tripping. Default 60000. */
  cooldownMs?: number
  /** Consecutive failures that bench an endpoint. Default 2. */
  failureThreshold?: number
  /** Chain id assertion passed to ethers, when known. */
  network?: Networkish
}

type ResolvedOptions = Required<Omit<RpcPoolOptions, "network">> &
  Pick<RpcPoolOptions, "network">

/** Live state for one endpoint. */
interface EndpointState {
  url: string
  priority: number
  consecutiveFailures: number
  /** Epoch ms until which the endpoint is benched. 0 means available. */
  benchedUntil: number
  /** Last observed round-trip in ms, or null if never measured. */
  latencyMs: number | null
  successes: number
  failures: number
}

/** Endpoint health for display. */
export interface EndpointHealthStatus {
  url: string
  healthy: boolean
  /** Milliseconds until the endpoint leaves the bench. 0 when available. */
  cooldownRemainingMs: number
  latencyMs: number | null
  consecutiveFailures: number
  successes: number
  failures: number
}

/** Aggregate health for one network, shaped for a status indicator. */
export interface PoolHealth {
  /** True when at least one endpoint is currently usable. */
  usable: boolean
  totalEndpoints: number
  healthyEndpoints: number
  /** Best observed latency across healthy endpoints, or null. */
  bestLatencyMs: number | null
  endpoints: EndpointHealthStatus[]
}

/** Why a pool operation ultimately failed. */
export type RpcFailureKind =
  | "no-endpoints"
  | "all-endpoints-failed"
  | "timeout"
  | "rate-limited"
  | "aborted"
  | "destroyed"

/** Error carrying enough detail for the UI to say something useful. */
export class RpcError extends Error {
  readonly kind: RpcFailureKind
  /** Number of endpoint attempts made before giving up. */
  readonly attempted: number

  constructor(kind: RpcFailureKind, message: string, attempted = 0) {
    super(message)
    this.name = "RpcError"
    this.kind = kind
    this.attempted = attempted
  }

  /** A sentence safe to show a user; never embeds a URL or an argument value. */
  get userMessage(): string {
    switch (this.kind) {
      case "no-endpoints":
        return "This network has no usable RPC endpoints configured."
      case "rate-limited":
        return "The network is rate limiting requests. Wait a moment and try again."
      case "timeout":
        return "The network did not respond in time. It may be congested."
      case "aborted":
        return "The request was cancelled."
      case "destroyed":
        return "The connection was closed."
      case "all-endpoints-failed":
      default:
        return "Could not reach this network. Every configured endpoint failed."
    }
  }
}

const DEFAULTS: Omit<ResolvedOptions, "network"> = {
  attemptsPerEndpoint: 2,
  requestTimeoutMs: 12_000,
  retryBackoffMs: 400,
  maxBackoffMs: 4_000,
  cooldownMs: 60_000,
  failureThreshold: 2,
}

/**
 * Classify a provider rejection so retry behaviour can differ by cause.
 *
 * @param error - Value thrown by a provider call.
 */
function classifyError(error: unknown): { rateLimited: boolean; retryable: boolean } {
  const text = error instanceof Error ? `${error.message} ${error.name}` : String(error)
  const lowered = text.toLowerCase()

  if (
    lowered.includes("429") ||
    lowered.includes("rate limit") ||
    lowered.includes("too many requests") ||
    lowered.includes("quota")
  ) {
    return { rateLimited: true, retryable: true }
  }

  // A revert, a bad argument, or a nonce conflict is deterministic: retrying
  // elsewhere returns the same answer and only wastes the user's time.
  if (
    lowered.includes("call_exception") ||
    lowered.includes("invalid_argument") ||
    lowered.includes("insufficient funds") ||
    lowered.includes("nonce too low") ||
    lowered.includes("already known") ||
    lowered.includes("replacement transaction underpriced")
  ) {
    return { rateLimited: false, retryable: false }
  }

  return { rateLimited: false, retryable: true }
}

/** Sleep that rejects promptly if the signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RpcError("aborted", "Aborted"))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new RpcError("aborted", "Aborted"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Race work against a timeout, always clearing the timer.
 *
 * The previous implementation left its `setTimeout` pending after the work won
 * the race, holding the closure alive for the full timeout window on every call.
 *
 * @param work - Receives a signal that aborts when the timeout fires.
 * @param timeoutMs - Deadline in milliseconds.
 * @param outer - Optional caller signal that also aborts the work.
 */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  outer?.addEventListener("abort", onOuterAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new RpcError("timeout", `Request exceeded ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outer?.removeEventListener("abort", onOuterAbort)
  }
}

/**
 * A pool of interchangeable RPC endpoints for one network.
 *
 * Work is submitted through {@link execute}. Providers are created lazily, cached
 * per endpoint, and destroyed together in {@link destroy}.
 */
export class RpcPool {
  private readonly endpoints: EndpointState[]
  private readonly options: ResolvedOptions
  private readonly providers = new Map<string, JsonRpcProvider>()
  private cursor = 0
  private destroyed = false

  /**
   * @param endpoints - At least one endpoint. Non-`https:` entries are dropped.
   * @param options - Optional tuning.
   * @throws {RpcError} If no usable endpoint remains after filtering.
   */
  constructor(endpoints: readonly RpcEndpoint[], options: RpcPoolOptions = {}) {
    const usable = endpoints.filter((endpoint) => {
      try {
        // Reject non-https: an http endpoint is blocked as mixed content on an
        // HTTPS page, and would expose RPC traffic in cleartext regardless.
        return new URL(endpoint.url).protocol === "https:"
      } catch {
        return false
      }
    })

    if (usable.length === 0) {
      throw new RpcError("no-endpoints", "RpcPool requires at least one https endpoint")
    }

    // Copy before sorting: the old constructor sorted the caller's array in place.
    this.endpoints = usable
      .map((endpoint) => ({
        url: endpoint.url,
        priority: endpoint.priority ?? 1,
        consecutiveFailures: 0,
        benchedUntil: 0,
        latencyMs: null,
        successes: 0,
        failures: 0,
      }))
      .sort((a, b) => a.priority - b.priority)

    this.options = { ...DEFAULTS, ...options }
  }

  /** Whether the pool has been torn down. */
  get isDestroyed(): boolean {
    return this.destroyed
  }

  /** Number of endpoints retained after https filtering. */
  get size(): number {
    return this.endpoints.length
  }

  /**
   * Run a unit of work against a healthy endpoint, failing over on error.
   *
   * The callback may be invoked more than once, against different endpoints, so
   * it must be **idempotent**. Use it for reads and gas estimation, never to
   * broadcast a transaction — a retry could submit twice. Use {@link executeOnce}
   * for anything that mutates chain state.
   *
   * @param work - Idempotent operation to perform.
   * @param signal - Optional cancellation signal.
   * @returns The operation's result.
   * @throws {RpcError} When every endpoint fails, or on cancellation.
   */
  async execute<T>(
    work: (provider: JsonRpcProvider) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.destroyed) throw new RpcError("destroyed", "Pool has been destroyed")

    const order = this.selectionOrder()
    if (order.length === 0) {
      // Everything is benched. Give the endpoint whose cooldown expires soonest
      // one chance: a blanket cooldown must not hard-fail the application.
      const revived = this.leastRecentlyBenched()
      if (!revived) throw new RpcError("no-endpoints", "No endpoints available")
      order.push(revived)
    }

    let lastError: unknown
    let sawRateLimit = false
    let attempted = 0

    for (const endpoint of order) {
      for (let attempt = 0; attempt < this.options.attemptsPerEndpoint; attempt++) {
        if (signal?.aborted) throw new RpcError("aborted", "Request cancelled")
        if (this.destroyed) throw new RpcError("destroyed", "Pool has been destroyed")

        attempted++
        const started = Date.now()

        try {
          const provider = this.providerFor(endpoint.url)
          const result = await withTimeout(
            () => work(provider),
            this.options.requestTimeoutMs,
            signal
          )
          this.recordSuccess(endpoint, Date.now() - started)
          return result
        } catch (error) {
          if (error instanceof RpcError && error.kind === "aborted") throw error

          lastError = error
          const { rateLimited, retryable } = classifyError(error)
          if (rateLimited) sawRateLimit = true

          // A deterministic failure is the real answer; surfacing it immediately
          // beats walking every endpoint to receive it twenty more times.
          if (!retryable) throw error

          this.recordFailure(endpoint)
          logger.warn("RPC endpoint failed", {
            // May embed an API key; the logger redacts it.
            url: endpoint.url,
            attempt: attempt + 1,
            error,
          })

          const isLastAttemptHere = attempt === this.options.attemptsPerEndpoint - 1
          if (!isLastAttemptHere) {
            const backoff = Math.min(
              this.options.retryBackoffMs * 2 ** attempt,
              this.options.maxBackoffMs
            )
            // Jitter stops every open tab retrying in lockstep.
            await delay(backoff + Math.random() * 100, signal)
          }
        }
      }
    }

    throw new RpcError(
      sawRateLimit ? "rate-limited" : "all-endpoints-failed",
      lastError instanceof Error ? lastError.message : "All RPC endpoints failed",
      attempted
    )
  }

  /**
   * Run work against exactly one endpoint, with no failover.
   *
   * Use for anything that must not be retried, above all broadcasting a signed
   * transaction: retrying after an ambiguous timeout risks submitting twice.
   *
   * @param work - Non-idempotent operation.
   * @param signal - Optional cancellation signal.
   */
  async executeOnce<T>(
    work: (provider: JsonRpcProvider) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.destroyed) throw new RpcError("destroyed", "Pool has been destroyed")

    const endpoint = this.selectionOrder()[0] ?? this.leastRecentlyBenched()
    if (!endpoint) throw new RpcError("no-endpoints", "No endpoints available")

    const started = Date.now()
    try {
      const result = await withTimeout(
        () => work(this.providerFor(endpoint.url)),
        this.options.requestTimeoutMs,
        signal
      )
      this.recordSuccess(endpoint, Date.now() - started)
      return result
    } catch (error) {
      if (!(error instanceof RpcError && error.kind === "aborted")) {
        this.recordFailure(endpoint)
      }
      throw error
    }
  }

  /**
   * Health snapshot for display.
   *
   * Derived entirely from observed request outcomes. There is deliberately no
   * background polling: a separate health loop is pure overhead when every real
   * request already reports whether its endpoint worked.
   */
  getHealth(): PoolHealth {
    const now = Date.now()
    const endpoints = this.endpoints.map<EndpointHealthStatus>((endpoint) => ({
      url: endpoint.url,
      healthy: endpoint.benchedUntil <= now,
      cooldownRemainingMs: Math.max(0, endpoint.benchedUntil - now),
      latencyMs: endpoint.latencyMs,
      consecutiveFailures: endpoint.consecutiveFailures,
      successes: endpoint.successes,
      failures: endpoint.failures,
    }))

    const healthy = endpoints.filter((endpoint) => endpoint.healthy)
    const latencies = healthy
      .map((endpoint) => endpoint.latencyMs)
      .filter((value): value is number => value !== null)

    return {
      usable: healthy.length > 0,
      totalEndpoints: endpoints.length,
      healthyEndpoints: healthy.length,
      bestLatencyMs: latencies.length > 0 ? Math.min(...latencies) : null,
      endpoints,
    }
  }

  /**
   * Destroy every cached provider and mark the pool unusable.
   *
   * Must be called when a pool is discarded. An ethers provider holds an internal
   * event loop, so dropping the reference without destroying it leaks.
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const provider of this.providers.values()) {
      try {
        provider.destroy()
      } catch (error) {
        logger.debug("Provider destroy failed", { error })
      }
    }
    this.providers.clear()
  }

  // ---------- internals ----------

  /**
   * Cache one provider per endpoint.
   *
   * `staticNetwork` suppresses ethers' periodic `eth_chainId` re-detection, which
   * would otherwise add a recurring background request per provider.
   */
  private providerFor(url: string): JsonRpcProvider {
    const existing = this.providers.get(url)
    if (existing) return existing

    const provider = new JsonRpcProvider(url, this.options.network, {
      staticNetwork: this.options.network !== undefined ? true : null,
    })
    this.providers.set(url, provider)
    return provider
  }

  /** Available endpoints, best first, rotated so load spreads. */
  private selectionOrder(): EndpointState[] {
    const now = Date.now()
    const available = this.endpoints.filter((endpoint) => endpoint.benchedUntil <= now)
    if (available.length === 0) return []

    const ranked = [...available].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      // An unmeasured endpoint sorts as average so it gets a fair first try.
      const aLatency = a.latencyMs ?? 500
      const bLatency = b.latencyMs ?? 500
      return aLatency - bLatency
    })

    // Rotate by a cursor so repeated calls do not always hammer the same host.
    const offset = this.cursor++ % ranked.length
    return [...ranked.slice(offset), ...ranked.slice(0, offset)]
  }

  /** The endpoint whose bench expires soonest, for last-resort use. */
  private leastRecentlyBenched(): EndpointState | undefined {
    return [...this.endpoints].sort((a, b) => a.benchedUntil - b.benchedUntil)[0]
  }

  private recordSuccess(endpoint: EndpointState, latencyMs: number): void {
    endpoint.consecutiveFailures = 0
    endpoint.benchedUntil = 0
    endpoint.successes++
    // Smooth the estimate so one slow response does not resort the whole pool.
    endpoint.latencyMs =
      endpoint.latencyMs === null
        ? latencyMs
        : Math.round(endpoint.latencyMs * 0.7 + latencyMs * 0.3)
  }

  private recordFailure(endpoint: EndpointState): void {
    endpoint.consecutiveFailures++
    endpoint.failures++
    if (endpoint.consecutiveFailures >= this.options.failureThreshold) {
      // Bench it. Unlike the previous implementation nothing revives it early:
      // the cooldown is the single source of truth for availability.
      endpoint.benchedUntil = Date.now() + this.options.cooldownMs
    }
  }
}
