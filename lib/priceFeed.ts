import { Network } from "./ethers"

/** Cache entry for price data */
interface PriceCache {
  prices: Record<string, number> // coinId -> price
  timestamp: number
  ttl: number
}

/** Mapping from network to CoinGecko coin ID */
const NETWORK_COIN_IDS: Record<string, string> = {
  // Mainnets
  mainnet: "ethereum",
  optimism: "optimism",
  arbitrum: "arbitrum",
  polygon: "matic-network",
  bsc: "binancecoin",
  base: "base",
  avalanche: "avalanche-2",
  fantom: "fantom",
  celo: "celo",
  scroll: "scroll",
  zksyncera: "zksync",
  gnosis: "gnosis",
  "arc-mainnet": "usd-coin", // USDC
  mantle: "mantle",
  metis: "metis-token",
  moonbeam: "moonbeam",
  zetachain: "zetachain",
  kaia: "kaia-chain",
  berachain: "berachain",
  somnia: "somnia",
  // Testnets (fallback to mainnet counterpart or use a generic)
  sepolia: "ethereum",
  "base-sepolia": "base",
  "mode-sepolia": "ethereum",
  "optimism-sepolia": "optimism",
  "arbitrum-sepolia": "arbitrum",
  hoodi: "ethereum",
  megaeth: "ethereum",
  "arc-testnet": "usd-coin",
  "giwa-sepolia": "ethereum",
  unichain: "ethereum",
}

/** Default cache TTL: 5 minutes */
const DEFAULT_TTL = 5 * 60 * 1000

/** In-memory cache for price data (batch) */
let batchCache: PriceCache | null = null

/**
 * Get the CoinGecko coin ID for a given network.
 * @param network - Network key
 * @returns CoinGecko coin ID or null if not found
 */
export function getCoinIdForNetwork(network: string): string | null {
  return NETWORK_COIN_IDS[network] || null
}

/**
 * Fetch prices for multiple coin IDs in a single batch request.
 * @param coinIds - Array of CoinGecko coin IDs
 * @param currency - Target currency (default: "usd")
 * @returns Map of coinId to price, or null for failed fetches
 */
export async function fetchPricesBatch(
  coinIds: string[],
  currency: string = "usd"
): Promise<Map<string, number | null>> {
  // Remove duplicates
  const uniqueIds = [...new Set(coinIds)]
  if (uniqueIds.length === 0) return new Map()

  const currentCache = batchCache;

  // Check cache first
  if (currentCache && Date.now() - currentCache.timestamp < currentCache.ttl) {
    // Check if all requested coinIds are in cache
    const missing = uniqueIds.filter((id) => !(id in currentCache.prices))
    if (missing.length === 0) {
      // All prices are cached
      const result = new Map<string, number | null>()
      for (const id of uniqueIds) {
        result.set(id, currentCache.prices[id] ?? null)
      }
      return result
    }
  }

  try {
    // Build URL with all coin IDs
    const idsParam = uniqueIds.join(",")
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${idsParam}&vs_currencies=${currency}`

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
      },
    })

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error("Rate limit exceeded. Please try again later.")
      }
      throw new Error(`HTTP error ${response.status}`)
    }

    const data = await response.json()

    // Build result map
    const priceMap = new Map<string, number | null>()
    for (const id of uniqueIds) {
      const price = data[id]?.[currency]
      if (typeof price === "number") {
        priceMap.set(id, price)
      } else {
        priceMap.set(id, null)
      }
    }

    // Update cache
    const pricesObj: Record<string, number> = {}
    for (const [id, price] of priceMap) {
      if (price !== null) {
        pricesObj[id] = price
      }
    }
    batchCache = {
      prices: pricesObj,
      timestamp: Date.now(),
      ttl: DEFAULT_TTL,
    }

    return priceMap
  } catch (error) {
    console.error("Failed to fetch prices batch:", error)
    // If cache exists, return stale data as fallback
    if (batchCache) {
      console.warn("Using stale cache for prices")
      const result = new Map<string, number | null>()
      for (const id of uniqueIds) {
        result.set(id, batchCache.prices[id] ?? null)
      }
      return result
    }
    // Return null for all
    const result = new Map<string, number | null>()
    for (const id of uniqueIds) {
      result.set(id, null)
    }
    return result
  }
}

/**
 * Get the price for a specific network (uses batch internally).
 * @param network - Network key
 * @param currency - Target currency (default: "usd")
 * @returns Price in USD as a number, or null if not available
 */
export async function getPriceForNetwork(
  network: string,
  currency: string = "usd"
): Promise<number | null> {
  const coinId = getCoinIdForNetwork(network)
  if (!coinId) return null
  const result = await fetchPricesBatch([coinId], currency)
  return result.get(coinId) ?? null
}

/**
 * Batch fetch prices for multiple networks.
 * @param networks - Array of network keys
 * @param currency - Target currency (default: "usd")
 * @returns Map of network to price
 */
export async function getPricesForNetworks(
  networks: string[],
  currency: string = "usd"
): Promise<Map<string, number | null>> {
  // Collect unique coin IDs
  const networkToCoinId: Record<string, string> = {}
  const coinIds: string[] = []
  for (const network of networks) {
    const coinId = getCoinIdForNetwork(network)
    if (coinId) {
      networkToCoinId[network] = coinId
      coinIds.push(coinId)
    }
  }

  if (coinIds.length === 0) {
    return new Map()
  }

  // Fetch all prices in one batch
  const priceMap = await fetchPricesBatch(coinIds, currency)

  // Map back to networks
  const result = new Map<string, number | null>()
  for (const [network, coinId] of Object.entries(networkToCoinId)) {
    result.set(network, priceMap.get(coinId) ?? null)
  }

  return result
}

/**
 * Clear the price cache.
 */
export function clearPriceCache(): void {
  batchCache = null
}

/**
 * Get cache status for debugging.
 */
export function getCacheStatus(): {
  hasCache: boolean
  age: number | null
  coinCount: number
} {
  if (!batchCache) {
    return { hasCache: false, age: null, coinCount: 0 }
  }
  return {
    hasCache: true,
    age: Date.now() - batchCache.timestamp,
    coinCount: Object.keys(batchCache.prices).length,
  }
}
