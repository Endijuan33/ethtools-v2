import { JsonRpcProvider } from "ethers"

export interface RpcEndpoint {
  url: string
  priority?: number
  timeout?: number
}

export interface RpcPoolOptions {
  retryCount?: number
  retryDelay?: number
  failoverStrategy?: "sequential" | "random" | "weighted"
  healthCheckInterval?: number
  requestTimeout?: number
}

interface EndpointHealth {
  healthy: boolean
  lastCheck: number
  consecutiveFailures: number
  responseTime: number
}

export class RpcPool {
  private endpoints: RpcEndpoint[]
  private options: Required<RpcPoolOptions>
  private health: Map<string, EndpointHealth> = new Map()
  private currentIndex: number = 0
  private healthCheckTimer: NodeJS.Timeout | null = null
  private isHealthChecking: boolean = false

  constructor(endpoints: RpcEndpoint[], options: RpcPoolOptions = {}) {
    if (endpoints.length === 0) {
      throw new Error("RpcPool requires at least one endpoint")
    }
    this.endpoints = endpoints.sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1))
    this.options = {
      retryCount: options.retryCount ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      failoverStrategy: options.failoverStrategy ?? "sequential",
      healthCheckInterval: options.healthCheckInterval ?? 60000,
      requestTimeout: options.requestTimeout ?? 15000, // increased from 10000
    }

    for (const endpoint of this.endpoints) {
      this.health.set(endpoint.url, {
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        responseTime: 0,
      })
    }

    this.startHealthCheck()
  }

  async getProvider(): Promise<JsonRpcProvider> {
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
        console.warn(`RPC ${endpoint.url} failed:`, error instanceof Error ? error.message : error)
        this.markUnhealthy(endpoint.url, error)
        triedEndpoints.add(endpoint.url)
        attempts++
        await this.delay(this.options.retryDelay)
      }
    }

    throw new Error("All RPC endpoints failed after maximum retries")
  }

  async healthCheck(): Promise<Record<string, boolean>> {
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

  destroy(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  // ---------- Private ----------

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

  private selectSequential(endpoints: RpcEndpoint[]): RpcEndpoint {
    const idx = this.currentIndex % endpoints.length
    this.currentIndex++
    return endpoints[idx]
  }

  private selectWeighted(endpoints: RpcEndpoint[]): RpcEndpoint {
    const totalWeight = endpoints.reduce((sum, e) => {
      const health = this.health.get(e.url)!
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
      // Log the error but re-throw so the caller can handle it
      console.error(`testProvider failed for ${provider._getConnection().url}:`, error)
      throw error
    }
  }

  private markHealthy(url: string): void {
    const health = this.health.get(url)
    if (health) {
      health.healthy = true
      health.consecutiveFailures = 0
    }
  }

  private markUnhealthy(url: string, _error: unknown): void {
    const health = this.health.get(url)
    if (health) {
      health.consecutiveFailures++
      if (health.consecutiveFailures >= 3) {
        health.healthy = false
        health.lastCheck = Date.now()
      }
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
    }
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck()
    }, this.options.healthCheckInterval)
  }

  private async performHealthCheck(): Promise<void> {
    if (this.isHealthChecking) return
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
        if (health.consecutiveFailures >= 3) {
          health.healthy = false
        }
        if (!health.healthy && Date.now() - health.lastCheck > 30000) {
          health.healthy = true
        }
      }
    }

    this.isHealthChecking = false
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
