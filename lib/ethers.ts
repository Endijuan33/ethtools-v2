"use client"
import { Mnemonic, HDNodeWallet, Wallet, isAddress, JsonRpcProvider, formatEther, Contract, formatUnits } from "ethers"

export interface CustomNetwork {
  name: string
  rpcUrl: string
  explorerUrl: string
  currency: string
  type: "mainnet" | "testnet"
  isCustom: true
}

export interface BuiltInNetwork {
  name: string
  rpcUrl: string
  explorerUrl: string
  currency: string
  type: "mainnet" | "testnet"
  isCustom?: false
}

export type NetworkConfig = BuiltInNetwork | CustomNetwork

// Add a 'type' property to classify networks and remove deprecated ones
export const NETWORKS: Record<string, BuiltInNetwork> = {
  // Mainnet Network
  mainnet: {
    name: "Ethereum Mainnet",
    rpcUrl: "https://eth-mainnet.public.blastapi.io",
    explorerUrl: "https://etherscan.io",
    currency: "ETH",
    type: "mainnet" as const,
  },

  optimism: {
    name: "Optimism",
    rpcUrl: "https://mainnet.optimism.io",
    explorerUrl: "https://optimistic.etherscan.io",
    currency: "ETH",
    type: "mainnet" as const,
  },

  arbitrum: {
    name: "Arbitrum One",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
    currency: "ETH",
    type: "mainnet" as const,
  },

  polygon: {
    name: "Polygon Mainnet",
    rpcUrl: "https://polygon-rpc.com",
    explorerUrl: "https://polygonscan.com",
    currency: "MATIC",
    type: "mainnet" as const,
  },

  bsc: {
    name: "BNB Smart Chain",
    rpcUrl: "https://binance.llamarpc.com",
    explorerUrl: "https://bscscan.com",
    currency: "BNB",
    type: "mainnet" as const,
  },

  base: {
    name: "Base",
    rpcUrl: "https://base.llamarpc.com",
    explorerUrl: "https://basescan.org",
    currency: "ETH",
    type: "mainnet" as const,
  },

  avalanche: {
    name: "Avalanche C-Chain Mainnet",
    rpcUrl: "https://avalanche-c-chain-rpc.publicnode.com",
    explorerUrl: "https://snowtrace.io",
    currency: "AVAX",
    type: "mainnet" as const,
  },

  fantom: {
    name: "Fantom Opera Mainnet",
    rpcUrl: "https://rpc.fantom.network",
    explorerUrl: "https://explorer.fantom.network",
    currency: "FTM",
    type: "mainnet" as const,
  },

  celo: {
    name: "Celo Mainnet",
    rpcUrl: "https://rpc.ankr.com/celo",
    explorerUrl: "https://celoscan.io",
    currency: "CELO",
    type: "mainnet" as const,
  },

  scroll: {
    name: "Scroll Mainnet",
    rpcUrl: "https://scroll-rpc.publicnode.com",
    explorerUrl: "https://scrollscan.com",
    currency: "ETH",
    type: "mainnet" as const,
  },

  zksyncera: {
    name: "zkSync Era Mainnet",
    rpcUrl: "https://rpc.ankr.com/zksync_era",
    explorerUrl: "https://era.zksync.network",
    currency: "ETH",
    type: "mainnet" as const,
  },

  gnosis: {
    name: "Gnosis Chain (xDai) Mainnet",
    rpcUrl: "https://gnosis-rpc.publicnode.com",
    explorerUrl: "https://gnosisscan.io",
    currency: "XDAI",
    type: "mainnet" as const,
  },
  "arc-mainnet": {
    name: "Arc Mainnet",
    rpcUrl: "https://rpc.blockdaemon.mainnet.arc.io",
    explorerUrl: "https://arc-mainnet.cloud.blockscout.com/",
    currency: "USDC",
    type: 'mainnet' as const,
  },

  mantle: {
    name: "Mantle Mainnet",
    rpcUrl: "https://mantle-rpc.publicnode.com",
    explorerUrl: "https://mantlescan.xyz",
    currency: "MNT",
    type: "mainnet" as const,
  },

  metis: {
    name: "Metis Andromeda Mainnet",
    rpcUrl: "https://metis-rpc.publicnode.com",
    explorerUrl: "https://metisscan.info",
    currency: "METIS",
    type: "mainnet" as const,
  },

  moonbeam: {
    name: "Moonbeam Mainnet",
    rpcUrl: "https://moonbeam-rpc.publicnode.com",
    explorerUrl: "https://moonscan.io",
    currency: "GLMR",
    type: "mainnet" as const,
  },

  zetachain: {
    name: "ZetaChain Mainnet",
    rpcUrl: "https://zetachain-evm.blockpi.network/v1/rpc/public",
    explorerUrl: "https://zetascan.com",
    currency: "ZETA",
    type: "mainnet" as const,
  },

  kaia: {
    name: "KAIA Mainnet",
    rpcUrl: "https://rpc.ankr.com/kaia",
    explorerUrl: "https://kaiascan.io",
    currency: "KAIA",
    type: "mainnet" as const,
  },

  berachain: {
    name: "Berachain Mainnet",
    rpcUrl: "https://berachain-rpc.publicnode.com",
    explorerUrl: "https://berascan.com",
    currency: "BERA",
    type: "mainnet" as const,
  },

  somnia: {
    name: "Somnia Mainnet",
    rpcUrl: "https://somnia-rpc.publicnode.com",
    explorerUrl: "https://explorer.somnia.network",
    currency: "SOMI",
    type: "mainnet" as const,
  },

  // Testnet Network

  sepolia: {
    name: "Sepolia Testnet",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorerUrl: "https://sepolia.etherscan.io",
    currency: "ETH",
    type: "testnet" as const,
  },
  "base-sepolia": {
    name: "Base Sepolia",
    rpcUrl: "https://base-sepolia-rpc.publicnode.com",
    explorerUrl: "https://sepolia.basescan.org/",
    currency: "ETH",
    type: "testnet" as const,
  },
  "mode-sepolia": {
    name: "Mode Sepolia",
    rpcUrl: "https://sepolia.mode.network",
    explorerUrl: "https://testnet.modescan.io/",
    currency: "ETH",
    type: "testnet" as const,
  },
  "optimism-sepolia": {
    name: "Optimism Sepolia",
    rpcUrl: "https://sepolia.optimism.io",
    explorerUrl: "https://sepolia-optimism.etherscan.io",
    currency: "ETH",
    type: "testnet" as const,
  },
  "arbitrum-sepolia": {
    name: "Arbitrum Sepolia",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerUrl: "https://sepolia.arbiscan.io",
    currency: "ETH",
    type: "testnet" as const,
  },
  hoodi: {
    name: "Hoodi Testnet",
    rpcUrl: "https://0xrpc.io/hoodi",
    explorerUrl: "https://hoodi.etherscan.io",
    currency: "ETH",
    type: "testnet" as const,
  },
  megaeth: {
    name: "MegaETH Testnet",
    rpcUrl: "https://carrot.megaeth.com/rpc",
    explorerUrl: "https://megaeth-testnet.blockscout.com",
    currency: "ETH",
    type: "testnet" as const,
  },
  "arc-testnet": {
    name: "Arc Testnet",
    rpcUrl: "https://arc-testnet.drpc.org",
    explorerUrl: "https://testnet.arcscan.app",
    currency: "USDC",
    type: 'testnet' as const,
  },
  "giwa-sepolia": {
    name: "GIWA Sepolia",
    rpcUrl: "https://sepolia-rpc.giwa.io/",
    explorerUrl: "https://sepolia-explorer.giwa.io",
    currency: "ETH",
    type: "testnet" as const,
  },
  unichain: {
    name: "Unichain Testnet",
    rpcUrl: "https://unichain-sepolia-rpc.publicnode.com",
    explorerUrl: "https://unichain-sepolia.blockscout.com/",
    currency: "ETH",
    type: "testnet" as const,
  },
}

export type Network = keyof typeof NETWORKS | string

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
}

export function removeCustomNetwork(key: string): void {
  const existing = getCustomNetworks()
  delete existing[key]
  localStorage.setItem(CUSTOM_NETWORKS_KEY, JSON.stringify(existing))
}

export function getAllNetworks(): Record<string, NetworkConfig> {
  return { ...NETWORKS, ...getCustomNetworks() }
}

export const getProvider = (network: Network) => {
  const allNetworks = getAllNetworks()
  const networkConfig = allNetworks[network]
  if (!networkConfig?.rpcUrl) throw new Error(`RPC URL not found for network: ${network}`)
  return new JsonRpcProvider(networkConfig.rpcUrl)
}

export async function validateRpcUrl(rpcUrl: string): Promise<{ valid: boolean; chainId?: number; error?: string }> {
  try {
    const provider = new JsonRpcProvider(rpcUrl)
    const network = await provider.getNetwork()
    return { valid: true, chainId: Number(network.chainId) }
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "Invalid RPC URL" }
  }
}

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint)",
]

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

export function getRoutescanUrl(addressOrTxHash: string, network: Network): string {
  const allNetworks = getAllNetworks()
  const networkConfig = allNetworks[network]
  if (!networkConfig?.explorerUrl) return ""
  const path = addressOrTxHash.length === 42 ? "address" : "tx"
  return `${networkConfig.explorerUrl}/${path}/${addressOrTxHash}`
}

export async function getBalance(address: string, network: Network): Promise<string> {
  if (!isAddress(address)) throw new Error("Invalid address.")
  const allNetworks = getAllNetworks()
  const networkConfig = allNetworks[network]
  if (!networkConfig) throw new Error(`Network not found: ${network}`)
  const provider = getProvider(network)
  try {
    const balanceWei = await provider.getBalance(address)
    return Number.parseFloat(formatEther(balanceWei)).toFixed(5)
  } catch (error) {
    throw new Error(`Could not fetch ETH balance on ${networkConfig.name}.`)
  }
}

export async function getTokenDetails(contractAddress: string, network: Network) {
  if (!isAddress(contractAddress)) throw new Error("Invalid contract address.")
  const provider = getProvider(network)
  const contract = new Contract(contractAddress, ERC20_ABI, provider)
  try {
    const [name, symbol, decimals] = await Promise.all([contract.name(), contract.symbol(), contract.decimals()])
    return { name, symbol, decimals: Number(decimals) }
  } catch {
    throw new Error(
      "Failed to fetch token details. Make sure the address is a valid ERC20 contract on the selected network.",
    )
  }
}

export async function getTokenBalance(contractAddress: string, userAddress: string, network: Network) {
  if (!isAddress(contractAddress) || !isAddress(userAddress)) throw new Error("Invalid address.")
  const provider = getProvider(network)
  const contract = new Contract(contractAddress, ERC20_ABI, provider)
  try {
    const balance = await contract.balanceOf(userAddress)
    const decimals = await contract.decimals()
    return Number.parseFloat(formatUnits(balance, decimals)).toFixed(4)
  } catch {
    throw new Error("Failed to fetch token balance.")
  }
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
