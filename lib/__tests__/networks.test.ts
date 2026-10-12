/**
 * RA-13 closure: the built-in network table with no Infura id configured.
 *
 * The shared embedded Infura project id is gone from the source. With
 * `NEXT_PUBLIC_INFURA_PROJECT_ID` unset (the test environment, like the
 * default deployment), no built-in list may contain an Infura endpoint,
 * and every network must keep at least two public no-key HTTPS
 * endpoints so failover never depends on a key. The configured shape is
 * pinned separately in `tests/infuraEnv.test.ts`.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { NETWORKS } from "../ethers"

test("no built-in network uses an Infura endpoint when no project id is configured", () => {
  for (const [key, network] of Object.entries(NETWORKS)) {
    for (const url of network.rpcUrls) {
      assert.equal(url.includes("infura.io"), false, `${key} unexpectedly uses Infura: ${url}`)
    }
  }
})

test("every built-in network keeps at least two public HTTPS endpoints", () => {
  for (const [key, network] of Object.entries(NETWORKS)) {
    assert.ok(network.rpcUrls.length >= 2, `${key} has only ${network.rpcUrls.length} endpoint(s)`)
    for (const url of network.rpcUrls) {
      assert.ok(url.startsWith("https://"), `${key} endpoint is not HTTPS: ${url}`)
    }
  }
})

test("no built-in network uses a key-gated or call-limited endpoint", () => {
  // Endpoint hygiene (2026-10-13): Ankr's public hosts now reject keyless
  // requests ("Unauthorized: You must authenticate your request with an
  // API key"), cloudflare-eth.com answers chain reads but fails eth_call
  // (it broke ENS resolution in production), and BlastAPI's Fantom host
  // is shut down. None of them may re-enter the built-in table.
  for (const [key, network] of Object.entries(NETWORKS)) {
    for (const url of network.rpcUrls) {
      assert.equal(url.includes("ankr.com"), false, `${key} uses key-gated Ankr endpoint: ${url}`)
      assert.equal(
        url.includes("cloudflare-eth.com"),
        false,
        `${key} uses call-limited Cloudflare endpoint: ${url}`
      )
    }
  }
})

test("the formerly Infura-backed networks keep their public endpoints, in order", () => {
  assert.deepEqual(NETWORKS.mainnet.rpcUrls.slice(0, 3), [
    "https://ethereum-rpc.publicnode.com",
    "https://eth-mainnet.public.blastapi.io",
    "https://eth.drpc.org",
  ])
  assert.deepEqual(NETWORKS.optimism.rpcUrls.slice(0, 3), [
    "https://mainnet.optimism.io",
    "https://optimism-rpc.publicnode.com",
    "https://optimism.drpc.org",
  ])
  assert.deepEqual(NETWORKS.arbitrum.rpcUrls.slice(0, 3), [
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum-one-rpc.publicnode.com",
    "https://arbitrum.drpc.org",
  ])
  assert.deepEqual(NETWORKS.avalanche.rpcUrls.slice(0, 3), [
    "https://api.avax.network/ext/bc/C/rpc",
    "https://avalanche-c-chain-rpc.publicnode.com",
    "https://avalanche.drpc.org",
  ])
  // Celo had only Ankr + Infura before RA-13; Forno (the chain's official
  // public RPC) plus PublicNode and dRPC keep it at three public endpoints.
  assert.deepEqual(NETWORKS.celo.rpcUrls.slice(0, 3), [
    "https://forno.celo.org",
    "https://celo-rpc.publicnode.com",
    "https://celo.drpc.org",
  ])
  assert.equal(NETWORKS.celo.rpcUrls.length, 3)
})
