import { JsonRpcProvider } from "ethers"

/**
 * Represents a single RPC endpoint configuration.
 */
export interface RpcEndpoint {
  /** The RPC URL (e.g., https://eth-mainnet.g.alchemy.com/v2/...) */
  url: string
  /** Priority (lower = higher priority); defaults to 1 if not set */
  priority?: number
  /** Timeout in milliseconds for requests to this endpoint; default 15000ms */
  timeout?: number
}

/**
 * Configuration options for the RpcPool.
 */
export interface RpcPoolOptions {
  /** Number of retry attempts per endpoint before failing over; default 3 */
  retryCount?: number
  /** Initial delay in ms between retries; default 1000ms */
  retryDelay?: number
  /** Strategy for selecting the next endpoint: 'sequential' (round-robin), 'random', or 'weighted' (by response time); default 'sequential' */
  failoverStrategy?: "sequential" | "random" | "weighted"
  /** Interval in ms for periodic health checks; default 60000ms (1 minute) */
  healthCheckInterval?: number
  /** Timeout in ms for individual RPC requests; default 15000ms */
  requestTimeout?: number
  /** Maximum backoff delay in ms; default 30000ms */
  maxBackoffDelay?: number
}

/** Internal health status for an endpoint */
interface EndpointHealth {
  healthy: boolean
  lastCheck: number
  consecutiveFailures: number
  responseTime: number // in ms, used for weighted strategy
}

/** Public health status for UI monitoring */
export interface EndpointHealthStatus {
  url: string
  healthy: boolean
  responseTime: number
  lastCheck: number
  consecutiveFailures: number
}

/**
 * RpcPool manages a pool of RPC endpoints for a single blockchain network.
 * It provides automatic failover, health checks, exponential backoff, and request load balancing.
 */
export class RpcPool {
  private endpoints: RpcEndpoint[]
  private options: Required<RpcPoolOptions>
  private health: Map<string, EndpointHealth> = new Map()
  private currentIndex: number = 0
  private healthCheckTimer: NodeJS.Timeout | null = null
  private isHealthChecking: boolean = false
  private isDestroyed: boolean = false

  /**
   * Create a new RpcPool.
   * @param endpoints - List of RPC endpoints (at least one required)
   * @param options - Optional configuration
   * @throws {Error} If endpoints array is empty
   */
  constructor(endpoints: RpcEndpoint[], options: RpcPoolOptions = {}) {
    if (endpoints.length === 0) {
      throw new Error("RpcPool requires at least one endpoint")
    }
    // Sort by priority (lowest number first)
    this.endpoints = endpoints.sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1))
    this.options = {
      retryCount: options.retryCount ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      failoverStrategy: options.failoverStrategy ?? "sequential",
      healthCheckInterval: options.healthCheckInterval ?? 60000,
      requestTimeout: options.requestTimeout ?? 15000,
      maxBackoffDelay: options.maxBackoffDelay ?? 30000,
    }

    // Initialize health status for all endpoints
    for (const endpoint of this.endpoints) {
      this.health.set(endpoint.url, {
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        responseTime: 0,
      })
    }

    // Start periodic health checks
    this.startHealthCheck()
  }

  /**
   * Get a JsonRpcProvider that automatically handles failover with exponential backoff.
   * The provider will try endpoints in order, retrying on failure with increasing delays.
   * @returns Promise that resolves to a working JsonRpcProvider
   * @throws {Error} If no healthy endpoint is available after all retries
   */
  async getProvider(): Promise<JsonRpcProvider> {
    if (this.isDestroyed) {
      throw new Error("RpcPool has been destroyed")
    }

    const maxAttempts = this.options.retryCount * this.endpoints.length
    let attempts = 0
    const triedEndpoints = new Set<string>()

    while (attempts < maxAttempts) {
      const endpoint = this.selectEndpoint(triedEndpoints)
      if (!endpoint) {
        throw new Error("No healthy RPC endpoints available")
      }

      try {
        const provider = new JsonRpcProvider(endpoint.url)
        await this.testProvider(provider)
        this.markHealthy(endpoint.url)
        return provider
      } catch (error) {
        console.warn(`RPC ${endpoint.url} failed on attempt ${attempts + 1}:`,
          error instanceof Error ? error.message : error)
        this.markUnhealthy(endpoint.url, error)
        triedEndpoints.add(endpoint.url)
        attempts++
        // Use exponential backoff before retrying
        await this.delayWithBackoff(attempts)
      }
    }

    throw new Error("All RPC endpoints failed after maximum retries")
  }

  /**
   * Perform an immediate health check on all endpoints and update status.
   * @returns A report with the health status of each endpoint
   */
  async healthCheck(): Promise<Record<string, boolean>> {
    if (this.isDestroyed) {
      return {}
    }

    const results: Record<string, boolean> = {}
    for (const endpoint of this.endpoints) {
      try {
        const provider = new JsonRpcProvider(endpoint.url)
        await this.testProvider(provider)
        this.markHealthy(endpoint.url)
        results[endpoint.url] = true
      } catch (error) {
        console.warn(`Health check failed for ${endpoint.url}:`, error)
        this.markUnhealthy(endpoint.url, error)
        results[endpoint.url] = false
      }
    }
    return results
  }

  /**
   * Get the current health status of all endpoints for UI monitoring.
   * @returns Array of endpoint health status objects
   */
  getHealthStatus(): EndpointHealthStatus[] {
    return this.endpoints.map((endpoint) => {
      const health = this.health.get(endpoint.url)
      return {
        url: endpoint.url,
        healthy: health?.healthy ?? false,
        responseTime: health?.responseTime ?? 0,
        lastCheck: health?.lastCheck ?? 0,
        consecutiveFailures: health?.consecutiveFailures ?? 0,
      }
    })
  }

  /**
   * Check if the pool has been destroyed.
   */
  isDestroyedPool(): boolean {
    return this.isDestroyed
  }

  /**
   * Stop all periodic health checks and clean up resources.
   */
  destroy(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
    this.isDestroyed = true
  }

  // ---------- Private helper methods ----------

  /**
   * Select an endpoint based on the current failover strategy, excluding already tried endpoints.
   */
  private selectEndpoint(tried: Set<string>): RpcEndpoint | null {
    const healthyEndpoints = this.endpoints.filter(
      (e) => this.health.get(e.url)?.healthy !== false && !tried.has(e.url)
    )
    if (healthyEndpoints.length === 0) return null

    switch (this.options.failoverStrategy) {
      case "sequential":
        return this.selectSequential(healthyEndpoints)
      case "random":
        return healthyEndpoints[Math.floor(Math.random() * healthyEndpoints.length)]
      case "weighted":
        return this.selectWeighted(healthyEndpoints)
      default:
        return healthyEndpoints[0]
    }
  }

  /**
   * Round-robin selection from the healthy endpoints.
   */
  private selectSequential(endpoints: RpcEndpoint[]): RpcEndpoint {
    const idx = this.currentIndex % endpoints.length
    this.currentIndex++
    return endpoints[idx]
  }

  /**
   * Weighted selection based on response time (faster endpoints get higher weight).
   */
  private selectWeighted(endpoints: RpcEndpoint[]): RpcEndpoint {
    const totalWeight = endpoints.reduce((sum, e) => {
      const health = this.health.get(e.url)!
      // Use a base weight of 1 if responseTime is 0 (unknown)
      const weight = health.responseTime > 0 ? 1000 / health.responseTime : 1
      return sum + weight
    }, 0)

    let random = Math.random() * totalWeight
    for (const endpoint of endpoints) {
      const health = this.health.get(endpoint.url)!
      const weight = health.responseTime > 0 ? 1000 / health.responseTime : 1
      random -= weight
      if (random <= 0) return endpoint
    }
    return endpoints[0]
  }

  /**
   * Test a provider by fetching the latest block number with a timeout.
   */
  private async testProvider(provider: JsonRpcProvider): Promise<void> {
    const startTime = Date.now()
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("RPC request timeout")), this.options.requestTimeout)
    })

    try {
      await Promise.race([
        provider.getBlockNumber(),
        timeoutPromise,
      ])
      const responseTime = Date.now() - startTime
      const health = this.health.get(provider._getConnection().url)
      if (health) {
        health.responseTime = responseTime
        health.lastCheck = Date.now()
      }
    } catch (error) {
      console.error(`testProvider failed for ${provider._getConnection().url}:`, error)
      throw error
    }
  }

  /**
   * Mark an endpoint as healthy (reset failure counter).
   */
  private markHealthy(url: string): void {
    const health = this.health.get(url)
    if (health) {
      health.healthy = true
      health.consecutiveFailures = 0
    }
  }

  /**
   * Mark an endpoint as unhealthy if it has consecutive failures.
   */
  private markUnhealthy(url: string, _error: unknown): void {
    const health = this.health.get(url)
    if (health) {
      health.consecutiveFailures++
      // Mark unhealthy after 2 consecutive failures (reduced from 3 for faster failover)
      if (health.consecutiveFailures >= 2) {
        health.healthy = false
        health.lastCheck = Date.now()
      }
    }
  }

  /**
   * Start periodic health checks.
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
    }
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck()
    }, this.options.healthCheckInterval)
  }

  /**
   * Perform a health check on all endpoints, attempting to revive unhealthy ones after a cooldown.
   */
  private async performHealthCheck(): Promise<void> {
    if (this.isHealthChecking || this.isDestroyed) return
    this.isHealthChecking = true

    for (const endpoint of this.endpoints) {
      const health = this.health.get(endpoint.url)
      if (!health) continue

      try {
        const provider = new JsonRpcProvider(endpoint.url)
        await this.testProvider(provider)
        health.healthy = true
        health.consecutiveFailures = 0
      } catch {
        health.consecutiveFailures++
        if (health.consecutiveFailures >= 2) {
          health.healthy = false
        }
        // Attempt to revive after 30 seconds cooldown
        if (!health.healthy && Date.now() - health.lastCheck > 30000) {
          health.healthy = true // give it another chance
        }
      }
    }

    this.isHealthChecking = false
  }

  /**
   * Delay with exponential backoff.
   * @param attempt - Current attempt number (starts from 1)
   * @returns Promise that resolves after the calculated delay
   */
  private delayWithBackoff(attempt: number): Promise<void> {
    // Calculate delay: initialDelay * 2^(attempt-1), capped at maxBackoffDelay
    const delay = Math.min(
      this.options.retryDelay * Math.pow(2, attempt - 1),
      this.options.maxBackoffDelay
    )
    return new Promise((resolve) => setTimeout(resolve, delay))
  }

  /**
   * Simple delay helper (kept for backward compatibility).
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
