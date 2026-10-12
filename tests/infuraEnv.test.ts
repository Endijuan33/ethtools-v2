// @vitest-environment node
/**
 * RA-13 closure: the built-in network table WITH an Infura id configured.
 *
 * `lib/ethers.ts` reads `NEXT_PUBLIC_INFURA_PROJECT_ID` at module load,
 * so the module is imported after the environment is stubbed (the same
 * pattern as the middleware suite). With an id set, an Infura endpoint
 * built from it joins each supported network's list in the final
 * position it occupied when a shared id was still embedded; networks
 * Infura does not serve are untouched.
 */
import { beforeAll, describe, expect, it, vi } from "vitest"
import type { NETWORKS as NetworksTable } from "@/lib/ethers"

const STUB_ID = "stubbed-project-id-for-tests"

let NETWORKS: typeof NetworksTable

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_INFURA_PROJECT_ID", STUB_ID)
  vi.resetModules()
  const mod = await import("@/lib/ethers")
  NETWORKS = mod.NETWORKS
})

describe("built-in networks with NEXT_PUBLIC_INFURA_PROJECT_ID set (RA-13)", () => {
  it("appends the configured Infura endpoint to each supported network, last", () => {
    expect(NETWORKS.mainnet.rpcUrls.at(-1)).toBe(`https://mainnet.infura.io/v3/${STUB_ID}`)
    expect(NETWORKS.optimism.rpcUrls.at(-1)).toBe(
      `https://optimism-mainnet.infura.io/v3/${STUB_ID}`
    )
    expect(NETWORKS.arbitrum.rpcUrls.at(-1)).toBe(
      `https://arbitrum-mainnet.infura.io/v3/${STUB_ID}`
    )
    expect(NETWORKS.avalanche.rpcUrls.at(-1)).toBe(
      `https://avalanche-mainnet.infura.io/v3/${STUB_ID}`
    )
    expect(NETWORKS.celo.rpcUrls.at(-1)).toBe(`https://celo-mainnet.infura.io/v3/${STUB_ID}`)
  })

  it("keeps the public endpoints ahead of Infura (failover priority unchanged)", () => {
    expect(NETWORKS.mainnet.rpcUrls.slice(0, 3)).toEqual([
      "https://eth-mainnet.public.blastapi.io",
      "https://rpc.ankr.com/eth",
      "https://cloudflare-eth.com",
    ])
    expect(NETWORKS.celo.rpcUrls.slice(0, 2)).toEqual([
      "https://forno.celo.org",
      "https://rpc.ankr.com/celo",
    ])
  })

  it("leaves networks Infura does not serve untouched", () => {
    for (const key of ["polygon", "bsc", "base", "sepolia"] as const) {
      expect(NETWORKS[key].rpcUrls.some((url) => url.includes("infura.io"))).toBe(false)
    }
  })
})
