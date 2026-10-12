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

test("the formerly Infura-backed networks keep their public endpoints, in order", () => {
  assert.deepEqual(NETWORKS.mainnet.rpcUrls.slice(0, 3), [
    "https://eth-mainnet.public.blastapi.io",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
  ])
  assert.deepEqual(NETWORKS.optimism.rpcUrls.slice(0, 2), [
    "https://mainnet.optimism.io",
    "https://rpc.ankr.com/optimism",
  ])
  assert.deepEqual(NETWORKS.arbitrum.rpcUrls.slice(0, 2), [
    "https://arb1.arbitrum.io/rpc",
    "https://rpc.ankr.com/arbitrum",
  ])
  assert.deepEqual(NETWORKS.avalanche.rpcUrls.slice(0, 2), [
    "https://api.avax.network/ext/bc/C/rpc",
    "https://rpc.ankr.com/avalanche",
  ])
  // Celo had only Ankr + Infura before; Forno (the chain's official
  // public RPC) is the second always-on endpoint now.
  assert.deepEqual(NETWORKS.celo.rpcUrls.slice(0, 2), [
    "https://forno.celo.org",
    "https://rpc.ankr.com/celo",
  ])
  assert.equal(NETWORKS.celo.rpcUrls.length, 2)
})
