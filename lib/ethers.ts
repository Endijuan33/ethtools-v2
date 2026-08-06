// lib/ethers.ts
// Ethers.js utilities with multi-RPC support for all blockchain networks.
// Provides balance fetching, token management, and validation.

"use client"

import {
  Mnemonic,
  HDNodeWallet,
  Wallet,
  isAddress,
  JsonRpcProvider,
  formatEther,
  Contract,
  formatUnits,
  isError,
} from "ethers"
import { RpcPool, type RpcEndpoint } from "./multiRpc"

// ===== Types =====

export interface CustomNetwork {
  name: string
  rpcUrls: string[] // Now supports multiple RPC URLs
  explorerUrl: string
  currency: string
  type: "mainnet" | "testnet"
  isCustom: true
}

export interface BuiltInNetwork {
  name: string
  rpcUrls: string[] // Now supports multiple RPC URLs
  explorerUrl: string
  currency: string
  type: "mainnet" | "testnet"
  isCustom?: false
}

export type NetworkConfig = BuiltInNetwork | CustomNetwork

export type Network = keyof typeof NETWORKS | string

// ===== Built-in Networks with Multiple RPCs =====

export const NETWORKS: Record<string, BuiltInNetwork> = {
  // Mainnet Network
  mainnet: {
    name: "Ethereum Mainnet",
    rpcUrls: [
      "https://eth-mainnet.public.blastapi.io",
      "https://rpc.ankr.com/eth",
      "https://cloudflare-eth.com",
      "https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161",
    ],
    explorerUrl: "https://etherscan.io",
    currency: "ETH",
    type: "mainnet",
  },

  optimism: {
    name: "Optimism",
    rpcUrls: [
      "https://mainnet.optimism.io",
      "https://rpc.ankr.com/optimism",
      "https://optimism-mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161",
    ],
    explorerUrl: "https://optimistic.etherscan.io",
    currency: "ETH",
    type: "mainnet",
  },

  arbitrum: {
    name: "Arbitrum One",
    rpcUrls: [
      "https://arb1.arbitrum.io/rpc",
      "https://rpc.ankr.com/arbitrum",
      "https://arbitrum-mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161",
    ],
    explorerUrl: "https://arbiscan.io",
    currency: "ETH",
    type: "mainnet",
  },

  polygon: {
    name: "Polygon Mainnet",
    rpcUrls: [
      "https://polygon-rpc.com",
      "https://rpc-mainnet.matic.network",
      "https://rpc-mainnet.matic.quiknode.pro",
    ],
    explorerUrl: "https://polygonscan.com",
    currency: "MATIC",
    type: "mainnet",
  },

  bsc: {
    name: "BNB Smart Chain",
    rpcUrls: [
      "https://bsc-dataseed1.binance.org",
      "https://bsc-dataseed2.binance.org",
      "https://rpc.ankr.com/bsc",
    ],
    explorerUrl: "https://bscscan.com",
    currency: "BNB",
    type: "mainnet",
  },

  base: {
    name: "Base",
    rpcUrls: [
      "https://mainnet.base.org",
      "https://base.llamarpc.com",
      "https://rpc.notadegen.com/base",
    ],
    explorerUrl: "https://basescan.org",
    currency: "ETH",
    type: "mainnet",
  },

  avalanche: {
    name: "Avalanche C-Chain Mainnet",
    rpcUrls: [
      "https://api.avax.network/ext/bc/C/rpc",
      "https://rpc.ankr.com/avalanche",
      "https://avalanche-mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161",
    ],
    explorerUrl: "https://snowtrace.io",
    currency: "AVAX",
    type: "mainnet",
  },

  fantom: {
    name: "Fantom Opera Mainnet",
    rpcUrls: [
      "https://rpc.fantom.network",
      "https://fantom-mainnet.public.blastapi.io",
      "https://rpc.ankr.com/fantom",
    ],
    explorerUrl: "https://explorer.fantom.network",
    currency: "FTM",
    type: "mainnet",
  },

  celo: {
    name: "Celo Mainnet",
    rpcUrls: [
      "https://rpc.ankr.com/celo",
      "https://celo-mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161",
    ],
    explorerUrl: "https://celoscan.io",
    currency: "CELO",
    type: "mainnet",
  },

  scroll: {
    name: "Scroll Mainnet",
    rpcUrls: [
      "https://scroll-rpc.publicnode.com",
      "https://rpc.ankr.com/scroll",
    ],
    explorerUrl: "https://scrollscan.com",
    currency: "ETH",
    type: "mainnet",
  },

  zksyncera: {
    name: "zkSync Era Mainnet",
    rpcUrls: [
      "https://rpc.ankr.com/zksync_era",
      "https://zksync-era-mainnet.publicnode.com",
    ],
    explorerUrl: "https://era.zksync.network",
    currency: "ETH",
    type: "mainnet",
  },

  gnosis: {
    name: "Gnosis Chain (xDai) Mainnet",
    rpcUrls: [
      "https://gnosis-rpc.publicnode.com",
      "https://rpc.ankr.com/gnosis",
    ],
    explorerUrl: "https://gnosisscan.io",
    currency: "XDAI",
    type: "mainnet",
  },

  "arc-mainnet": {
    name: "Arc Mainnet",
    rpcUrls: [
      "https://arc-mainnet.infura.io/v3/b6bf7d3508c941499b10025c0776eaf8",
    ],
    explorerUrl: "https://arc-mainnet.cloud.blockscout.com/",
    currency: "USDC",
    type: "mainnet",
  },

  mantle: {
    name: "Mantle Mainnet",
    rpcUrls: [
      "https://mantle-rpc.publicnode.com",
      "https://rpc.ankr.com/mantle",
    ],
    explorerUrl: "https://mantlescan.xyz",
    currency: "MNT",
    type: "mainnet",
  },

  metis: {
    name: "Metis Andromeda Mainnet",
    rpcUrls: [
      "https://metis-rpc.publicnode.com",
      "https://rpc-metis.rockx.com",
    ],
    explorerUrl: "https://metisscan.info",
    currency: "METIS",
    type: "mainnet",
  },

  moonbeam: {
    name: "Moonbeam Mainnet",
    rpcUrls: [
      "https://moonbeam-rpc.publicnode.com",
      "https://rpc.api.moonbeam.network",
    ],
    explorerUrl: "https://moonscan.io",
    currency: "GLMR",
    type: "mainnet",
  },

  zetachain: {
    name: "ZetaChain Mainnet",
    rpcUrls: [
      "https://zetachain-evm.blockpi.network/v1/rpc/public",
      "https://zetachain-mainnet.publicnode.com",
    ],
    explorerUrl: "https://zetascan.com",
    currency: "ZETA",
    type: "mainnet",
  },

  kaia: {
    name: "KAIA Mainnet",
    rpcUrls: [
      "https://rpc.ankr.com/kaia",
      "https://kaia-mainnet.publicnode.com",
    ],
    explorerUrl: "https://kaiascan.io",
    currency: "KAIA",
    type: "mainnet",
  },

  berachain: {
    name: "Berachain Mainnet",
    rpcUrls: [
      "https://berachain-rpc.publicnode.com",
      "https://rpc.berachain.io",
    ],
    explorerUrl: "https://berascan.com",
    currency: "BERA",
    type: "mainnet",
  },

  somnia: {
    name: "Somnia Mainnet",
    rpcUrls: [
      "https://somnia-rpc.publicnode.com",
      "https://rpc.somnia.network",
    ],
    explorerUrl: "https://explorer.somnia.network",
    currency: "SOMI",
    type: "mainnet",
  },

  // --- Testnets ---

  sepolia: {
    name: "Sepolia Testnet",
    rpcUrls: [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://rpc.sepolia.org",
      "https://sepolia.gateway.tenderly.co",
    ],
    explorerUrl: "https://sepolia.etherscan.io",
    currency: "ETH",
    type: "testnet",
  },

  "base-sepolia": {
    name: "Base Sepolia",
    rpcUrls: [
      "https://base-sepolia-rpc.publicnode.com",
      "https://sepolia.base.org",
    ],
    explorerUrl: "https://sepolia.basescan.org/",
    currency: "ETH",
    type: "testnet",
  },

  "mode-sepolia": {
    name: "Mode Sepolia",
    rpcUrls: [
      "https://sepolia.mode.network",
      "https://mode-sepolia.publicnode.com",
    ],
    explorerUrl: "https://testnet.modescan.io/",
    currency: "ETH",
    type: "testnet",
  },

  "optimism-sepolia": {
    name: "Optimism Sepolia",
    rpcUrls: [
      "https://sepolia.optimism.io",
      "https://optimism-sepolia.publicnode.com",
    ],
    explorerUrl: "https://sepolia-optimism.etherscan.io",
    currency: "ETH",
    type: "testnet",
  },

  "arbitrum-sepolia": {
    name: "Arbitrum Sepolia",
    rpcUrls: [
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia.publicnode.com",
    ],
    explorerUrl: "https://sepolia.arbiscan.io",
    currency: "ETH",
    type: "testnet",
  },

  hoodi: {
    name: "Hoodi Testnet",
    rpcUrls: [
      "https://0xrpc.io/hoodi",
      "https://hoodi.publicnode.com",
    ],
    explorerUrl: "https://hoodi.etherscan.io",
    currency: "ETH",
    type: "testnet",
  },

  megaeth: {
    name: "MegaETH Testnet",
    rpcUrls: [
      "https://carrot.megaeth.com/rpc",
      "https://megaeth-testnet.publicnode.com",
    ],
    explorerUrl: "https://megaeth-testnet.blockscout.com",
    currency: "ETH",
    type: "testnet",
  },

  "arc-testnet": {
    name: "Arc Testnet",
    rpcUrls: [
      "https://arc-testnet.drpc.org",
      "https://testnet-arc.publicnode.com",
    ],
    explorerUrl: "https://testnet.arcscan.app",
    currency: "USDC",
    type: "testnet",
  },

  "giwa-sepolia": {
    name: "GIWA Sepolia",
    rpcUrls: [
      "https://sepolia-rpc.giwa.io/",
      "https://giwa-sepolia.publicnode.com",
    ],
    explorerUrl: "https://sepolia-explorer.giwa.io",
    currency: "ETH",
    type: "testnet",
  },

  unichain: {
    name: "Unichain Testnet",
    rpcUrls: [
      "https://unichain-sepolia-rpc.publicnode.com",
      "https://sepolia.unichain.org",
    ],
    explorerUrl: "https://unichain-sepolia.blockscout.com/",
    currency: "ETH",
    type: "testnet",
  },
}

// ===== Custom Networks Storage =====

const CUSTOM_NETWORKS_KEY = "ethtools_custom_networks"

export function getCustomNetworks(): Record<string, CustomNetwork> {
  if (typeof window === "undefined") return {}
  try {
    const stored = localStorage.getItem(CUSTOM_NETWORKS_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

export function saveCustomNetwork(key: string, network: CustomNetwork): void {
  const existing = getCustomNetworks()
  existing[key] = network
  localStorage.setItem(CUSTOM_NETWORKS_KEY, JSON.stringify(existing))
  // Clear RPC pools so they are recreated with new network
  rpcPools.delete(key)
}

export function removeCustomNetwork(key: string): void {
  const existing = getCustomNetworks()
  delete existing[key]
  localStorage.setItem(CUSTOM_NETWORKS_KEY, JSON.stringify(existing))
  rpcPools.delete(key)
}

export function getAllNetworks(): Record<string, NetworkConfig> {
  return { ...NETWORKS, ...getCustomNetworks() }
}

// ===== RPC Pool Cache =====

const rpcPools = new Map<string, RpcPool>()

/**
 * Get a JsonRpcProvider for the specified network with automatic multi-RPC failover.
 * @param network - Network key (e.g., "mainnet", "sepolia")
 * @returns Promise resolving to a JsonRpcProvider
 * @throws {Error} If network is not configured or no RPC endpoints available
 */
export async function getProvider(network: Network): Promise<JsonRpcProvider> {
  const allNetworks = getAllNetworks()
  const config = allNetworks[network]
  if (!config) {
    throw new Error(`Network "${network}" not found`)
  }

  let rpcEndpoints: RpcEndpoint[] = []
  if (Array.isArray(config.rpcUrls)) {
    if (config.rpcUrls.length === 0) {
      throw new Error(`No RPC URLs configured for network "${network}"`)
    }
    // Convert string URLs to RpcEndpoint objects if needed
    rpcEndpoints = config.rpcUrls.map((item) =>
      typeof item === "string" ? { url: item, priority: 1 } : item
    )
  } else {
    // Fallback for legacy single-string rpcUrl
    const url = (config as any).rpcUrl
    if (typeof url === "string" && url) {
      rpcEndpoints = [{ url, priority: 1 }]
    } else {
      throw new Error(`Invalid rpcUrls format for network "${network}"`)
    }
  }

  // Reuse or create a pool for this network
  if (!rpcPools.has(network)) {
    const pool = new RpcPool(rpcEndpoints, {
      retryCount: 3,
      failoverStrategy: "sequential",
      healthCheckInterval: 60000,
      requestTimeout: 20000,
    })
    rpcPools.set(network, pool)
  }

  return rpcPools.get(network)!.getProvider()
}

/**
 * Clean up all RPC pools (e.g., on logout or app unmount).
 */
export function cleanupRpcPools(): void {
  for (const pool of rpcPools.values()) {
    pool.destroy()
  }
  rpcPools.clear()
}

// ===== Balance and Token Functions =====

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint)",
]

/**
 * Get the native balance of an address on a given network.
 * @param address - Ethereum address
 * @param network - Network key
 * @returns Promise resolving to formatted balance string (with 5 decimals)
 * @throws {Error} If address is invalid or RPC fails
 */
export async function getBalance(address: string, network: Network): Promise<string> {
  if (!isAddress(address)) {
    throw new Error("Invalid address.")
  }
  const provider = await getProvider(network)
  try {
    const balanceWei = await provider.getBalance(address)
    return Number.parseFloat(formatEther(balanceWei)).toFixed(5)
  } catch (error) {
    console.error(`Error fetching balance on ${network}:`, error)
    throw new Error(`Failed to fetch balance on ${network}`)
  }
}

/**
 * Get the balance of an ERC-20 token for a given address.
 * @param contractAddress - Token contract address
 * @param userAddress - Wallet address
 * @param network - Network key
 * @returns Promise resolving to formatted token balance string
 * @throws {Error} If address is invalid or token fetch fails
 */
export async function getTokenBalance(
  contractAddress: string,
  userAddress: string,
  network: Network
): Promise<string> {
  if (!isAddress(contractAddress) || !isAddress(userAddress)) {
    throw new Error("Invalid address.")
  }
  const provider = await getProvider(network)
  const contract = new Contract(contractAddress, ERC20_ABI, provider)
  try {
    const balance = await contract.balanceOf(userAddress)
    const decimals = await contract.decimals()
    return Number.parseFloat(formatUnits(balance, decimals)).toFixed(4)
  } catch (error) {
    console.error(`Error fetching token balance on ${network}:`, error)
    throw new Error("Failed to fetch token balance.")
  }
}

/**
 * Get ERC-20 token details (name, symbol, decimals).
 */
export async function getTokenDetails(contractAddress: string, network: Network): Promise<{
  name: string
  symbol: string
  decimals: number
}> {
  if (!isAddress(contractAddress)) {
    throw new Error("Invalid contract address.")
  }
  const provider = await getProvider(network)
  const contract = new Contract(contractAddress, ERC20_ABI, provider)
  try {
    const [name, symbol, decimals] = await Promise.all([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
    ])
    return { name, symbol, decimals: Number(decimals) }
  } catch (error) {
    console.error(`Error fetching token details on ${network}:`, error)
    throw new Error(
      "Failed to fetch token details. Make sure the address is a valid ERC20 contract on the selected network."
    )
  }
}

// ===== Address Derivation =====

export function getAddressFromMnemonic(mnemonic: string): string {
  try {
    const mnemonicInstance = Mnemonic.fromPhrase(mnemonic)
    const node = HDNodeWallet.fromMnemonic(mnemonicInstance, `m/44'/60'/0'/0/0`)
    return node.address
  } catch {
    throw new Error("Invalid mnemonic phrase.")
  }
}

export function getAddressFromPrivateKey(privateKey: string): string {
  try {
    const wallet = new Wallet(privateKey)
    return wallet.address
  } catch {
    throw new Error("Invalid private key.")
  }
}

// ===== Validation =====

export async function validateRpcUrl(rpcUrl: string): Promise<{
  valid: boolean
  chainId?: number
  error?: string
}> {
  try {
    const provider = new JsonRpcProvider(rpcUrl)
    const network = await provider.getNetwork()
    return { valid: true, chainId: Number(network.chainId) }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid RPC URL",
    }
  }
}

// ===== Explorer Links =====

export function getRoutescanUrl(addressOrTxHash: string, network: Network): string {
  const allNetworks = getAllNetworks()
  const networkConfig = allNetworks[network]
  if (!networkConfig?.explorerUrl) return ""
  const path = addressOrTxHash.length === 42 ? "address" : "tx"
  return `${networkConfig.explorerUrl}/${path}/${addressOrTxHash}`
}

/**
 * Generates an explorer link specifically for the Converter and Generator pages.
 * This function is isolated from the wallet's network configuration and uses environment variables.
 * @param hash The address hash.
 * @param network The network context ('mainnet' or 'sepolia').
 * @returns The full URL to the Routescan explorer for the address.
 */
export function getConverterExplorerUrl(hash: string, network: "mainnet" | "sepolia"): string {
  const type = "address"
  let baseUrl: string

  if (network === "mainnet") {
    baseUrl = process.env.NEXT_PUBLIC_ROUTESCAN_MAINNET_URL || "https://routescan.io"
  } else {
    // 'sepolia'
    baseUrl = process.env.NEXT_PUBLIC_ROUTESCAN_TESTNET_URL || "https://testnet.routescan.io"
  }

  return `${baseUrl}/${type}/${hash}`
}
