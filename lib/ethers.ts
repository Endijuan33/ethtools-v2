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
} from "ethers"
import {
  RpcError,
  RpcPool,
  type EndpointHealthStatus,
  type PoolHealth,
  type RpcEndpoint,
} from "./multiRpc"
import { logger } from "./logger"
import { filterValidCustomNetworks } from "./schema"
import { readJson, writeJson, STORAGE_KEYS, type WriteResult } from "./storage"

export { RpcError }
export type { EndpointHealthStatus, PoolHealth }

// ===== Types =====

export interface CustomNetwork {
  name: string
  rpcUrls: string[]
  explorerUrl: string
  currency: string
  type: "mainnet" | "testnet"
  isCustom: true
  /** Native currency decimals. Defaults to 18 when absent. */
  decimals?: number
}

export interface BuiltInNetwork {
  name: string
  rpcUrls: string[]
  explorerUrl: string
  currency: string
  type: "mainnet" | "testnet"
  isCustom?: false
}

export type NetworkConfig = BuiltInNetwork | CustomNetwork

/**
 * A network key.
 *
 * Deliberately widened to `string` because custom networks are user-created at
 * runtime, so no closed union can describe every valid key. Use
 * {@link isBuiltInNetwork} when a built-in key is actually required — the
 * previous `keyof typeof NETWORKS | string` collapsed to plain `string` and gave
 * the false impression of being checked.
 */
export type Network = string

/** Keys of the built-in network table, as a literal union. */
export type BuiltInNetworkKey = keyof typeof NETWORKS

/**
 * Native currency decimals for chains that are not 18.
 *
 * Everything else defaults to 18. This exists because amount parsing previously
 * assumed 18 decimals for every chain, which is wrong for any chain whose native
 * unit differs and would misprice a transfer by orders of magnitude.
 *
 * Arc is deliberately absent: although its native unit is USDC, Arc mints that
 * USDC with 18 decimals (verified against live testnet transactions and the
 * official docs: docs.arc.io, "USDC uses 18 decimals natively (not 6)"). An
 * earlier 6-decimal override here mispriced Arc balances and fees by 12 orders
 * of magnitude.
 */
const NATIVE_DECIMALS_OVERRIDES: Readonly<Record<string, number>> = {}

/** Decimals of a network's native currency. Defaults to 18. */
export function getNativeDecimals(network: Network): number {
  const custom = getCustomNetworks()[network]
  if (custom?.decimals !== undefined) return custom.decimals
  return NATIVE_DECIMALS_OVERRIDES[network] ?? 18
}

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

  /*
   * Arc Mainnet is intentionally absent. Its only reachable endpoints today
   * are authenticated or Infura-based (both forbidden here — this app uses
   * public, keyless RPCs only), and Circle's own docs publish Arc mainnet
   * endpoints "separately when available" — Arc is documented as
   * testnet-only at the time of writing. Re-add it the moment a keyless
   * public endpoint exists; every other part of the app (USDC as the native
   * currency symbol, 18-decimal native unit, chain-id 5042) is already
   * supported.
   */

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

  /*
   * Arc's native unit is USDC — gas is paid in USDC, not ETH — but Arc mints
   * it with 18 decimals (confirmed against live testnet transactions and the
   * official EVM-differences doc), so the default in getNativeDecimals is
   * already correct and no override is needed.
   */
  "arc-testnet": {
    name: "Arc Testnet",
    rpcUrls: [
      "https://rpc.testnet.arc.io",
      "https://rpc.drpc.testnet.arc.io",
      "https://rpc.blockdaemon.testnet.arc.io",
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

/**
 * Read user-added networks, dropping any that fail validation.
 *
 * `localStorage` is writable by anything running on the origin, so this is a
 * trust boundary. Validation rejects non-`https:` RPC and explorer URLs, which is
 * what stops a tampered entry from routing requests through an attacker's node or
 * smuggling a `javascript:` URL into an explorer link.
 */
export function getCustomNetworks(): Record<string, CustomNetwork> {
  const validated = filterValidCustomNetworks(
    readJson<unknown>(STORAGE_KEYS.CUSTOM_NETWORKS, (value): value is unknown => true, {})
  )

  // Never let a stored entry shadow a built-in key: an override of "mainnet"
  // would silently repoint Ethereum Mainnet.
  const safe: Record<string, CustomNetwork> = {}
  for (const [key, config] of Object.entries(validated)) {
    if (key in NETWORKS) {
      logger.warn("Ignoring custom network that shadows a built-in key", { key })
      continue
    }
    safe[key] = { ...config, isCustom: true }
  }
  return safe
}

/**
 * Persist a user-added network.
 *
 * @param key - Slug identifying the network. Must not collide with a built-in.
 * @param network - Validated configuration.
 * @returns Whether the write succeeded; storage can be full or unavailable.
 */
export function saveCustomNetwork(key: string, network: CustomNetwork): WriteResult {
  if (key in NETWORKS) {
    return {
      ok: false,
      reason: "unavailable",
      error: `"${key}" is a built-in network and cannot be overridden.`,
    }
  }

  const existing = getCustomNetworks()
  const result = writeJson(STORAGE_KEYS.CUSTOM_NETWORKS, { ...existing, [key]: network })
  // Drop the pool so the next request picks up the new endpoints.
  if (result.ok) disposePool(key)
  return result
}

/**
 * Remove a user-added network.
 * @param key - Slug of the network to remove.
 */
export function removeCustomNetwork(key: string): WriteResult {
  const existing = getCustomNetworks()
  delete existing[key]
  const result = writeJson(STORAGE_KEYS.CUSTOM_NETWORKS, existing)
  if (result.ok) disposePool(key)
  return result
}

/** Built-in and custom networks merged, with built-ins taking precedence. */
export function getAllNetworks(): Record<string, NetworkConfig> {
  return { ...getCustomNetworks(), ...NETWORKS }
}

/** Whether a key names a built-in network. */
export function isBuiltInNetwork(network: Network): network is BuiltInNetworkKey {
  return network in NETWORKS
}

/** Whether a key resolves to any known network. */
export function isKnownNetwork(network: Network): boolean {
  return network in NETWORKS || network in getCustomNetworks()
}

// ===== RPC pools =====

const rpcPools = new Map<string, RpcPool>()

/** Destroy and forget one pool. */
function disposePool(network: string): void {
  const pool = rpcPools.get(network)
  if (pool) {
    pool.destroy()
    rpcPools.delete(network)
  }
}

/**
 * Get or create the pool for a network.
 *
 * @param network - Network key.
 * @throws {RpcError} If the network is unknown or has no usable endpoint.
 */
function poolFor(network: Network): RpcPool {
  const existing = rpcPools.get(network)
  if (existing && !existing.isDestroyed) return existing

  const config = getAllNetworks()[network]
  if (!config) {
    throw new RpcError("no-endpoints", `Network "${network}" is not configured.`)
  }
  if (!Array.isArray(config.rpcUrls) || config.rpcUrls.length === 0) {
    throw new RpcError("no-endpoints", `Network "${network}" has no RPC endpoints.`)
  }

  const endpoints: RpcEndpoint[] = config.rpcUrls.map((url, index) => ({
    url,
    // Preserve the configured order as a priority so the first listed endpoint
    // is preferred while all are still unmeasured.
    priority: index + 1,
  }))

  const pool = new RpcPool(endpoints)
  rpcPools.set(network, pool)
  return pool
}

/**
 * Run idempotent work against a network, with retry and failover.
 *
 * This replaces the old `getProvider()`, which handed back a bare single-URL
 * provider and therefore gave no failover on any actual request.
 *
 * @param network - Network key.
 * @param work - Idempotent operation. May run more than once, on different
 *   endpoints, so it must not broadcast a transaction.
 * @param signal - Optional cancellation signal.
 * @throws {RpcError} On exhaustion, timeout, or cancellation.
 */
export async function withProvider<T>(
  network: Network,
  work: (provider: JsonRpcProvider) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return poolFor(network).execute(work, signal)
}

/**
 * Run non-idempotent work against a single endpoint, with no retry.
 *
 * Use for broadcasting a signed transaction: retrying after an ambiguous timeout
 * risks submitting the same transaction twice.
 *
 * @param network - Network key.
 * @param work - Operation that must run at most once.
 * @param signal - Optional cancellation signal.
 */
export async function withProviderOnce<T>(
  network: Network,
  work: (provider: JsonRpcProvider) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return poolFor(network).executeOnce(work, signal)
}

/**
 * Health of every pool that has been used, for a status indicator.
 *
 * Health is derived from real request outcomes rather than a polling loop, so
 * this is a pure read with no network cost.
 *
 * @param network - Optional single network to report on.
 */
export function getRpcHealthStatus(network?: Network): Map<string, PoolHealth> {
  const result = new Map<string, PoolHealth>()
  if (network !== undefined) {
    const pool = rpcPools.get(network)
    if (pool && !pool.isDestroyed) result.set(network, pool.getHealth())
    return result
  }
  for (const [key, pool] of rpcPools) {
    if (!pool.isDestroyed) result.set(key, pool.getHealth())
  }
  return result
}

/** Health of one network, or null if it has not been contacted yet. */
export function getNetworkHealth(network: Network): PoolHealth | null {
  const pool = rpcPools.get(network)
  return pool && !pool.isDestroyed ? pool.getHealth() : null
}

/**
 * Destroy every pool.
 *
 * Call on logout and on unmount. An ethers provider holds an internal event loop,
 * so dropping the reference without destroying it leaks.
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
 * Native balance in base units.
 *
 * Returns `bigint` because that is the only lossless representation. Formatting
 * for display belongs in `lib/format.ts`; a spendability decision must be made on
 * this value, never on a rounded display string.
 *
 * @param address - Address to query.
 * @param network - Network key.
 * @param signal - Optional cancellation signal.
 * @throws {Error} If the address is invalid.
 * @throws {RpcError} If every endpoint fails.
 */
export async function getBalanceWei(
  address: string,
  network: Network,
  signal?: AbortSignal
): Promise<bigint> {
  if (!isAddress(address)) throw new Error("Invalid address.")
  return withProvider(network, (provider) => provider.getBalance(address), signal)
}

/**
 * Native balance as a display string.
 *
 * Retained for existing call sites. Truncates toward zero rather than rounding,
 * because rounding a balance up shows funds the user does not have.
 *
 * @param address - Address to query.
 * @param network - Network key.
 * @param signal - Optional cancellation signal.
 */
export async function getBalance(
  address: string,
  network: Network,
  signal?: AbortSignal
): Promise<string> {
  const wei = await getBalanceWei(address, network, signal)
  const decimals = getNativeDecimals(network)
  const full = formatUnits(wei, decimals)

  const dot = full.indexOf(".")
  if (dot === -1) return full
  const truncated = full.slice(0, dot + 6)
  return truncated.endsWith(".") ? truncated.slice(0, -1) : truncated
}

/**
 * ERC-20 balance in base units, together with the token's decimals.
 *
 * Both values are returned so the caller can format without a second round trip;
 * the previous version fetched `decimals` separately on every balance read.
 *
 * @param contractAddress - Token contract.
 * @param userAddress - Holder address.
 * @param network - Network key.
 * @param signal - Optional cancellation signal.
 */
export async function getTokenBalanceRaw(
  contractAddress: string,
  userAddress: string,
  network: Network,
  signal?: AbortSignal
): Promise<{ value: bigint; decimals: number }> {
  if (!isAddress(contractAddress) || !isAddress(userAddress)) {
    throw new Error("Invalid address.")
  }

  return withProvider(
    network,
    async (provider) => {
      const contract = new Contract(contractAddress, ERC20_ABI, provider)
      // Parallel rather than sequential: two round trips became one.
      const [value, decimals] = await Promise.all([
        contract.balanceOf(userAddress) as Promise<bigint>,
        contract.decimals() as Promise<bigint>,
      ])
      return { value, decimals: Number(decimals) }
    },
    signal
  )
}

/**
 * ERC-20 balance as a display string.
 *
 * @param contractAddress - Token contract.
 * @param userAddress - Holder address.
 * @param network - Network key.
 * @param signal - Optional cancellation signal.
 */
export async function getTokenBalance(
  contractAddress: string,
  userAddress: string,
  network: Network,
  signal?: AbortSignal
): Promise<string> {
  const { value, decimals } = await getTokenBalanceRaw(
    contractAddress,
    userAddress,
    network,
    signal
  )
  const full = formatUnits(value, decimals)
  const dot = full.indexOf(".")
  if (dot === -1) return full
  const truncated = full.slice(0, dot + 5)
  return truncated.endsWith(".") ? truncated.slice(0, -1) : truncated
}

/**
 * ERC-20 metadata.
 *
 * @param contractAddress - Token contract.
 * @param network - Network key.
 * @param signal - Optional cancellation signal.
 */
export async function getTokenDetails(
  contractAddress: string,
  network: Network,
  signal?: AbortSignal
): Promise<{ name: string; symbol: string; decimals: number }> {
  if (!isAddress(contractAddress)) throw new Error("Invalid contract address.")

  try {
    return await withProvider(
      network,
      async (provider) => {
        const contract = new Contract(contractAddress, ERC20_ABI, provider)
        const [name, symbol, decimals] = await Promise.all([
          contract.name() as Promise<string>,
          contract.symbol() as Promise<string>,
          contract.decimals() as Promise<bigint>,
        ])
        return { name, symbol, decimals: Number(decimals) }
      },
      signal
    )
  } catch (error) {
    if (error instanceof RpcError) throw error
    logger.warn("Token metadata lookup failed", { network, error })
    throw new Error(
      "Could not read token details. Check that this is an ERC-20 contract on the selected network."
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

/**
 * Probe a candidate RPC URL before a user adds it.
 *
 * Three defects in the previous version are fixed: the provider was never
 * destroyed (leaking a polling connection per probe), there was no timeout (a
 * black-holing URL hung the dialog indefinitely), and `http:` was accepted even
 * though it is blocked as mixed content on an HTTPS page.
 *
 * @param rpcUrl - Candidate endpoint.
 * @param timeoutMs - Deadline. Defaults to 8000.
 */
export async function validateRpcUrl(
  rpcUrl: string,
  timeoutMs = 8_000
): Promise<{ valid: boolean; chainId?: number; error?: string }> {
  let parsed: URL
  try {
    parsed = new URL(rpcUrl)
  } catch {
    return { valid: false, error: "That is not a valid URL." }
  }
  if (parsed.protocol !== "https:") {
    return { valid: false, error: "Only https:// endpoints are accepted." }
  }

  const provider = new JsonRpcProvider(rpcUrl)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const network = await Promise.race([
      provider.getNetwork(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
      }),
    ])
    return { valid: true, chainId: Number(network.chainId) }
  } catch (error) {
    logger.debug("RPC validation failed", { error })
    const timedOut = error instanceof Error && error.message === "timeout"
    return {
      valid: false,
      // Never surface the library message: it embeds the URL, which may carry a key.
      error: timedOut
        ? `No response within ${Math.round(timeoutMs / 1000)}s.`
        : "Could not reach that endpoint.",
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Always release the connection, success or failure.
    provider.destroy()
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
