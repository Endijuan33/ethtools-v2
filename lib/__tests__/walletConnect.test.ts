/**
 * Unit tests for the WalletConnect plumbing's pure helpers.
 *
 * These deliberately import no SDK code: everything here exercises the trust
 * boundary (`parsePairingUri`, `normalizeSignParams`, `describeSessionProposal`)
 * against hostile or accidental input, plus the local signing paths that reuse
 * the app's existing signing modules. The SDK client itself is lazily imported
 * and browser-only, so it must never be reachable from this suite.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { hashMessage, keccak256, recoverAddress, Transaction, verifyMessage } from "ethers"

import type { SignResult } from "../signMessage"
import { validateTypedDataJSON, verifyTypedDataSignature } from "../signTypedData"
import {
  buildApprovalNamespaces,
  chainIdToNetworkKey,
  describeActiveSession,
  describeChain,
  describeSessionProposal,
  describeVerifiedOrigin,
  formatChainId,
  jsonRpcError,
  jsonRpcSuccess,
  normalizeSignParams,
  parseEip155ChainId,
  parsePairingUri,
  signWalletConnectRequest,
  SUPPORTED_METHODS,
  type TransactionSignView,
} from "../walletConnect"

/** Well-known Hardhat/Anvil development key #1 (publicly documented, zero funds). */
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

/** Address of TEST_KEY, published by Hardhat. */
const TEST_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

/** A second, unrelated checksummed address (also from the Hardhat set). */
const OTHER_ADDRESS = "0x8ba1f109551bD432803012645Ac136ddd64DBA72"

/** TEST_ADDRESS with one hex character case-flipped: right shape, bad EIP-55 checksum. */
const BAD_CHECKSUM_ADDRESS = "0x70997970C51812Dc3A010C7d01b50e0d17dc79C8"

/**
 * Unwrap a successful result, failing the test with the error message otherwise.
 */
function expectOk<T>(result: SignResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected a success but got: ${result.error}`)
  }
  return result.value
}

/**
 * Unwrap a failed result, failing the test when the operation succeeded.
 */
function expectError<T>(result: SignResult<T>): string {
  if (result.ok) {
    assert.fail("expected a failure but the operation succeeded")
  }
  return result.error
}

// ---------- fixtures ----------

/** A realistic v2 pairing URI, in the canonical `wc:` form dApps emit. */
const PAIRING_URI = `wc:8a5e5bdc-a25e-4ea5-8c41-4d0c6a2bf4a8@2?relay-protocol=irn&symKey=${
  "587d5484ce2a2c59c1d7a1f1" + "e0".repeat(20)
}`

/** A session_proposal event payload, in the shape WalletKit emits. */
function proposalEventFixture(overrides?: {
  metadata?: Record<string, unknown>
  requiredNamespaces?: unknown
  optionalNamespaces?: unknown
  verifyContext?: unknown
}): Record<string, unknown> {
  return {
    id: 42,
    verifyContext:
      overrides?.verifyContext === undefined
        ? {
            verified: {
              origin: "https://app.example.com",
              validation: "VALID",
              verifyUrl: "https://verify.walletconnect.org",
            },
          }
        : overrides.verifyContext,
    params: {
      proposer: {
        publicKey: "16c1b2f5ab8573f2e5a5f2b3c4d5e6f708192a3b4c5d6e7f809192a3b4c5d6e7f",
        metadata: {
          name: "Example dApp",
          description: "A fixture dApp",
          url: "https://app.example.com",
          icons: [],
          ...overrides?.metadata,
        },
      },
      requiredNamespaces:
        overrides?.requiredNamespaces === undefined
          ? {
              eip155: {
                chains: ["eip155:1", "eip155:137"],
                methods: ["personal_sign", "eth_sendTransaction"],
                events: ["accountsChanged", "chainChanged"],
              },
            }
          : overrides.requiredNamespaces,
      optionalNamespaces:
        overrides?.optionalNamespaces === undefined
          ? {
              eip155: {
                chains: ["eip155:8453"],
                methods: ["eth_signTypedData_v4"],
                events: [],
              },
            }
          : overrides.optionalNamespaces,
    },
  }
}

/** An EIP-712 payload in the exact shape a wallet produces for eth_signTypedData_v4. */
const TYPED_DATA = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Mail: [
      { name: "from", type: "address" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  message: { from: TEST_ADDRESS, contents: "Hello from the dApp" },
}

/** An eth_sendTransaction parameter object. */
function txFixture(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    from: TEST_ADDRESS,
    to: OTHER_ADDRESS,
    value: "0xde0b6b3a7640000",
    data: "0x",
    nonce: "0x7",
    gasLimit: "0x5208",
    gasPrice: "0x77359400",
    ...overrides,
  }
}

/** Normalize a transaction request against the test account on Ethereum Mainnet. */
function normalizeTx(params: unknown, chainId = "eip155:1") {
  return normalizeSignParams("eth_sendTransaction", params, {
    chainId,
    accountAddress: TEST_ADDRESS,
  })
}

// ---------- pairing URI parsing ----------

test("parsePairingUri accepts a canonical wc: URI and returns it unchanged", () => {
  assert.equal(expectOk(parsePairingUri(PAIRING_URI)), PAIRING_URI)
})

test("parsePairingUri accepts the wc:// deep-link form and normalizes it to wc:", () => {
  const deepLink = PAIRING_URI.replace("wc:", "wc://")
  assert.equal(expectOk(parsePairingUri(deepLink)), PAIRING_URI)
})

test("parsePairingUri trims surrounding whitespace", () => {
  assert.equal(expectOk(parsePairingUri(`   ${PAIRING_URI}\n`)), PAIRING_URI)
})

test("parsePairingUri rejects junk that is not a WalletConnect URI", () => {
  for (const junk of ["", "   ", "hello world", "https://example.com", "javascript:alert(1)"]) {
    const error = expectError(parsePairingUri(junk))
    assert.match(error, /pairing code/i)
  }
})

test("parsePairingUri rejects internal whitespace and line breaks", () => {
  // Trailing whitespace is trimmed away; whitespace *inside* the code is not.
  assert.ok(!parsePairingUri(PAIRING_URI.replace("wc:", "wc :")).ok)
  assert.ok(!parsePairingUri(PAIRING_URI.replace("relay-protocol", "relay protocol")).ok)
  assert.ok(!parsePairingUri(`${PAIRING_URI.slice(0, 20)}\n${PAIRING_URI.slice(20)}`).ok)
})

test("parsePairingUri rejects wrong versions, malformed topics and missing keys", () => {
  // Wrong protocol version.
  assert.ok(!parsePairingUri(PAIRING_URI.replace("@2", "@1")).ok)
  // No version at all.
  assert.ok(!parsePairingUri(PAIRING_URI.replace("@2", "")).ok)
  // Missing pairing key.
  assert.ok(!parsePairingUri(PAIRING_URI.replace(/&symKey=[0-9a-f]+/, "")).ok)
  // Pairing key of the wrong length or alphabet.
  assert.ok(!parsePairingUri(PAIRING_URI.replace(/symKey=[0-9a-f]+/, "symKey=deadbeef")).ok)
  assert.ok(!parsePairingUri(PAIRING_URI.replace(/symKey=[0-9a-f]+/, "symKey=zz")).ok)
  // No query string whatsoever.
  assert.ok(!parsePairingUri("wc:8a5e5bdc-a25e-4ea5-8c41-4d0c6a2bf4a8@2").ok)
  // Hostile characters in the topic.
  assert.ok(
    !parsePairingUri(
      'wc:8a5e5bdc"a25e?4ea5@2?relay-protocol=irn&symKey=587d5484ce2a2c59c1d7a1f1e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0'
    ).ok
  )
  // Absurd length.
  assert.ok(!parsePairingUri(`wc:${"a".repeat(3000)}@2?symKey=${"ab".repeat(32)}`).ok)
})

// ---------- CAIP-2 mapping ----------

test("formatChainId produces CAIP-2 identifiers", () => {
  assert.equal(formatChainId(1), "eip155:1")
  assert.equal(formatChainId(84532), "eip155:84532")
})

test("parseEip155ChainId accepts well-formed ids and rejects everything else", () => {
  assert.equal(parseEip155ChainId("eip155:1"), 1)
  assert.equal(parseEip155ChainId("eip155:8453"), 8453)
  assert.equal(parseEip155ChainId(1), null)
  assert.equal(parseEip155ChainId("eip155:01"), null)
  assert.equal(parseEip155ChainId("eip155:0"), null)
  assert.equal(parseEip155ChainId("eip155:-1"), null)
  assert.equal(parseEip155ChainId("eip155:99999999999999999999"), null)
  assert.equal(parseEip155ChainId("cosmos:cosmoshub-4"), null)
  assert.equal(parseEip155ChainId("eip155:1extra"), null)
})

test("chainIdToNetworkKey maps verified chain ids to NETWORKS keys", () => {
  assert.equal(chainIdToNetworkKey("eip155:1"), "mainnet")
  assert.equal(chainIdToNetworkKey("eip155:137"), "polygon")
  assert.equal(chainIdToNetworkKey("eip155:42161"), "arbitrum")
  assert.equal(chainIdToNetworkKey("eip155:8453"), "base")
  // Arc Mainnet (5042) stays unmapped while the network is absent from
  // NETWORKS — no keyless public RPC exists for it yet.
  assert.equal(chainIdToNetworkKey("eip155:5042"), null)
  assert.equal(chainIdToNetworkKey("eip155:5042002"), "arc-testnet")
  // ZetaChain mainnet is 7000; 7001 is its Athens testnet — the classic trap.
  assert.equal(chainIdToNetworkKey("eip155:7000"), "zetachain")
  assert.equal(chainIdToNetworkKey("eip155:7001"), null)
  assert.equal(chainIdToNetworkKey("eip155:11155111"), "sepolia")
})

test("chainIdToNetworkKey reports unknown chains as null, never guesses", () => {
  assert.equal(chainIdToNetworkKey("eip155:999999"), null)
  assert.equal(chainIdToNetworkKey("eip155:abc"), null)
  assert.equal(chainIdToNetworkKey(undefined), null)
})

test("describeChain labels known chains with friendly names and unknown ones explicitly", () => {
  const mainnet = describeChain("eip155:1", true)
  assert.equal(mainnet.name, "Ethereum Mainnet")
  assert.equal(mainnet.known, true)
  assert.equal(mainnet.required, true)
  assert.equal(mainnet.networkKey, "mainnet")

  const unknown = describeChain("eip155:999999")
  assert.equal(unknown.known, false)
  assert.match(unknown.name, /unsupported/)
  assert.match(unknown.name, /eip155:999999/)
})

// ---------- verified origin ----------

test("describeVerifiedOrigin extracts the registry verdict and flags scam origins", () => {
  const valid = describeVerifiedOrigin({
    verified: { origin: "https://app.example.com", validation: "VALID", verifyUrl: "x" },
  })
  assert.equal(valid?.origin, "https://app.example.com")
  assert.equal(valid?.validation, "VALID")
  assert.equal(valid?.isScam, false)

  const scam = describeVerifiedOrigin({
    verified: { origin: "https://evil.example", validation: "VALID", isScam: true },
  })
  assert.equal(scam?.isScam, true)

  const unknown = describeVerifiedOrigin({
    verified: { origin: "", validation: "UNKNOWN" },
  })
  assert.equal(unknown?.validation, "UNKNOWN")

  assert.equal(describeVerifiedOrigin(null), null)
  assert.equal(describeVerifiedOrigin({}), null)
  assert.equal(describeVerifiedOrigin({ verified: "nope" }), null)
})

// ---------- session proposal ----------

test("describeSessionProposal decodes metadata, chains and methods with friendly names", () => {
  const view = describeSessionProposal(proposalEventFixture())
  assert.equal(view.dappName, "Example dApp")
  assert.equal(view.dappUrl, "https://app.example.com")
  assert.equal(view.dappUrlHref, "https://app.example.com")
  assert.equal(view.verifiedOrigin?.origin, "https://app.example.com")
  assert.deepEqual(
    view.chains.map((chain) => chain.name),
    ["Ethereum Mainnet", "Polygon Mainnet", "Base"]
  )
  assert.deepEqual(
    view.chains.map((chain) => chain.required),
    [true, true, false]
  )
  // Required methods come first (collection order), then the optional
  // namespace's — the view lists everything the dApp asked for.
  assert.deepEqual(view.methods, [
    "personal_sign",
    "eth_sendTransaction",
    "eth_signTypedData_v4",
  ])
  assert.deepEqual(view.events, ["accountsChanged", "chainChanged"])
  assert.equal(view.approvable, true)
  assert.equal(view.blockReason, null)
})

test("describeSessionProposal accepts the pending-proposal struct shape as well as the event shape", () => {
  const event = proposalEventFixture()
  const struct = { id: event.id, ...(event.params as Record<string, unknown>) }
  const fromEvent = describeSessionProposal(event)
  const fromStruct = describeSessionProposal(struct)
  assert.equal(fromStruct.dappName, fromEvent.dappName)
  assert.deepEqual(fromStruct.chains, fromEvent.chains)
  assert.deepEqual(fromStruct.methods, fromEvent.methods)
  // The struct carries no verifyContext, so no origin is claimed.
  assert.equal(fromStruct.verifiedOrigin, null)
})

test("describeSessionProposal refuses to linkify a non-https dApp URL", () => {
  for (const url of ["http://app.example.com", "javascript:alert(1)", "data:text/html,x", ""]) {
    const view = describeSessionProposal(proposalEventFixture({ metadata: { url } }))
    assert.equal(view.dappUrlHref, null, `${url} must not become a link`)
    // The raw URL is still shown as text, so nothing is hidden from the user.
    assert.equal(view.dappUrl, url.trim())
  }
})

test("describeSessionProposal sanitizes control characters out of dApp-supplied names", () => {
  const view = describeSessionProposal(
    proposalEventFixture({ metadata: { name: "Evil\u0000dApp\u0007" } })
  )
  assert.equal(view.dappName, "Evil dApp")
})

test("describeSessionProposal blocks required chains the app does not know", () => {
  const view = describeSessionProposal(
    proposalEventFixture({
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1", "eip155:999999"],
          methods: ["personal_sign"],
          events: [],
        },
      },
    })
  )
  assert.equal(view.approvable, false)
  assert.equal(view.unsupportedRequiredChains.length, 1)
  assert.equal(view.unsupportedRequiredChains[0].caip2, "eip155:999999")
  assert.match(view.blockReason ?? "", /eip155:999999/)
})

test("describeSessionProposal tolerates unknown chains that are merely optional", () => {
  const view = describeSessionProposal(
    proposalEventFixture({
      requiredNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: [] },
      },
      optionalNamespaces: {
        eip155: { chains: ["eip155:999999"], methods: [], events: [] },
      },
    })
  )
  assert.equal(view.approvable, true)
  // The unknown chain still appears in the list, flagged, but blocks nothing.
  assert.ok(view.chains.some((chain) => !chain.known && !chain.required))
})

test("describeSessionProposal blocks required methods EthTools does not support", () => {
  const view = describeSessionProposal(
    proposalEventFixture({
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["personal_sign", "eth_signTransaction"],
          events: [],
        },
      },
    })
  )
  assert.equal(view.approvable, false)
  assert.deepEqual(view.unsupportedRequiredMethods, ["eth_signTransaction"])
  assert.match(view.blockReason ?? "", /eth_signTransaction/)
})

test("describeSessionProposal blocks non-EVM required namespaces", () => {
  const view = describeSessionProposal(
    proposalEventFixture({
      requiredNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: [] },
        cosmos: { chains: ["cosmos:cosmoshub-4"], methods: ["cosmos_signDirect"], events: [] },
      },
    })
  )
  assert.equal(view.approvable, false)
  assert.deepEqual(view.nonEvmRequiredNamespaces, ["cosmos"])
})

test("describeSessionProposal blocks session events EthTools cannot emit", () => {
  const view = describeSessionProposal(
    proposalEventFixture({
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["personal_sign"],
          events: ["accountsChanged", "message"],
        },
      },
    })
  )
  assert.equal(view.approvable, false)
  assert.deepEqual(view.ungrantableRequiredEvents, ["message"])
})

test("describeSessionProposal marks oversized proposals as unreviewable", () => {
  const methods = Array.from({ length: 65 }, (_, index) => `method_${index}`)
  const view = describeSessionProposal(
    proposalEventFixture({
      requiredNamespaces: { eip155: { chains: ["eip155:1"], methods, events: [] } },
    })
  )
  assert.equal(view.truncated, true)
  assert.equal(view.approvable, false)
  assert.match(view.blockReason ?? "", /malformed or oversized/)
})

test("describeSessionProposal survives empty and hostile input", () => {
  const empty = describeSessionProposal(null)
  assert.equal(empty.dappName, "Unnamed dApp")
  assert.equal(empty.approvable, false)

  const hostile = describeSessionProposal({
    params: {
      proposer: { metadata: { name: 42, url: { evil: true }, icons: "nope" } },
      requiredNamespaces: "not-an-object",
      optionalNamespaces: null,
    },
  })
  assert.equal(hostile.dappName, "Unnamed dApp")
  assert.equal(hostile.approvable, false)
})

// ---------- approval namespaces ----------

test("buildApprovalNamespaces grants known chains, supported methods and grantable events only", () => {
  const view = describeSessionProposal(proposalEventFixture())
  const namespaces = expectOk(buildApprovalNamespaces(view, TEST_ADDRESS))
  const eip155 = namespaces.eip155
  assert.deepEqual(eip155.chains, ["eip155:1", "eip155:137", "eip155:8453"])
  assert.deepEqual(eip155.accounts, [
    `eip155:1:${TEST_ADDRESS}`,
    `eip155:137:${TEST_ADDRESS}`,
    `eip155:8453:${TEST_ADDRESS}`,
  ])
  assert.deepEqual(eip155.methods, [...SUPPORTED_METHODS])
  assert.ok(eip155.events.includes("chainChanged"))
  assert.ok(eip155.events.includes("accountsChanged"))
})

test("buildApprovalNamespaces refuses an unapprovable view with its block reason", () => {
  const view = describeSessionProposal(
    proposalEventFixture({
      requiredNamespaces: {
        eip155: { chains: ["eip155:999999"], methods: ["personal_sign"], events: [] },
      },
    })
  )
  const error = expectError(buildApprovalNamespaces(view, TEST_ADDRESS))
  assert.match(error, /eip155:999999/)
})

// ---------- active sessions ----------

test("describeActiveSession summarizes a session with sanitized peer metadata", () => {
  const summary = describeActiveSession({
    topic: "topic-abc",
    expiry: 1234567890,
    peer: { metadata: { name: "Example dApp", url: "https://app.example.com", icons: [] } },
    namespaces: { eip155: { chains: ["eip155:1", "eip155:137"], accounts: [], methods: [], events: [] } },
  })
  assert.equal(summary.topic, "topic-abc")
  assert.equal(summary.dappName, "Example dApp")
  assert.equal(summary.dappUrlHref, "https://app.example.com")
  assert.equal(summary.chains.length, 2)
  assert.equal(summary.chains[0].name, "Ethereum Mainnet")

  const hostile = describeActiveSession({
    topic: 5,
    peer: { metadata: { name: "x", url: "javascript:alert(1)" } },
    namespaces: null,
  })
  assert.equal(hostile.topic, "")
  assert.equal(hostile.dappUrlHref, null)
  assert.deepEqual(hostile.chains, [])
})

// ---------- normalizeSignParams: method gate and generic guards ----------

test("normalizeSignParams rejects methods outside the supported list", () => {
  for (const method of ["eth_signTransaction", "eth_sign", "wallet_switchEthereumChain", ""]) {
    const error = expectError(normalizeSignParams(method, []))
    assert.match(error, /only supports personal_sign, eth_signTypedData_v4 and eth_sendTransaction/)
  }
})

test("normalizeSignParams rejects non-array params", () => {
  const error = expectError(normalizeSignParams("personal_sign", { 0: "0x00", 1: TEST_ADDRESS }))
  assert.match(error, /malformed/)
})

test("normalizeSignParams rejects payloads over 64 KB without inspecting them", () => {
  const huge = ["0x" + "aa".repeat(40_000), TEST_ADDRESS]
  const error = expectError(normalizeSignParams("personal_sign", huge))
  assert.match(error, /64 KB/)
})

// ---------- normalizeSignParams: personal_sign ----------

test("personal_sign decodes a hex message into the exact text that will be signed", () => {
  const view = expectOk(
    normalizeSignParams("personal_sign", ["0x68656c6c6f20776f726c64", TEST_ADDRESS], {
      accountAddress: TEST_ADDRESS,
    })
  )
  assert.equal(view.kind, "message")
  assert.equal(view.method, "personal_sign")
  if (view.kind !== "message") return
  assert.equal(view.message, "hello world")
  assert.equal(view.byteLength, 11)
  assert.equal(view.digest, hashMessage("hello world"))
  assert.equal(view.signerAddress, TEST_ADDRESS)
})

test("personal_sign tolerates an unstated signer but rejects a mismatched one", () => {
  const unstated = expectOk(normalizeSignParams("personal_sign", ["0x00", ""]))
  if (unstated.kind !== "message") return assert.fail("wrong kind")
  assert.equal(unstated.signerAddress, null)

  const mismatch = expectError(
    normalizeSignParams(
      "personal_sign",
      ["0x00", OTHER_ADDRESS],
      { accountAddress: TEST_ADDRESS }
    )
  )
  assert.match(mismatch, /unlocked account/)
})

test("personal_sign rejects wrong arity, non-hex and empty messages", () => {
  const arity = expectError(normalizeSignParams("personal_sign", ["0x00"]))
  assert.match(arity, /exactly two/)

  const plain = expectError(normalizeSignParams("personal_sign", ["hello", TEST_ADDRESS]))
  assert.match(plain, /hex/)

  const odd = expectError(normalizeSignParams("personal_sign", ["0x123", TEST_ADDRESS]))
  assert.match(odd, /hex/)

  const empty = expectError(normalizeSignParams("personal_sign", ["0x", TEST_ADDRESS]))
  assert.match(empty, /empty/)
})

test("personal_sign enforces the 10 KB readability limit", () => {
  const error = expectError(
    normalizeSignParams("personal_sign", ["0x" + "61".repeat(10_241), TEST_ADDRESS])
  )
  assert.match(error, /10 KB/)
  // Exactly at the limit is accepted.
  assert.ok(normalizeSignParams("personal_sign", ["0x" + "61".repeat(10_240), TEST_ADDRESS]).ok)
})

test("personal_sign refuses binary payloads that cannot be displayed as text", () => {
  const error = expectError(normalizeSignParams("personal_sign", ["0xfffeff", TEST_ADDRESS]))
  assert.match(error, /binary/)
})

test("personal_sign rejects a mixed-case signer with a bad EIP-55 checksum", () => {
  const error = expectError(
    normalizeSignParams("personal_sign", ["0x00", BAD_CHECKSUM_ADDRESS], {
      accountAddress: TEST_ADDRESS,
    })
  )
  assert.match(error, /checksum/)
})

// ---------- normalizeSignParams: eth_signTypedData_v4 ----------

test("eth_signTypedData_v4 accepts both parameter orders", () => {
  const json = JSON.stringify(TYPED_DATA)
  const addressFirst = expectOk(
    normalizeSignParams("eth_signTypedData_v4", [TEST_ADDRESS, json], {
      accountAddress: TEST_ADDRESS,
    })
  )
  const jsonFirst = expectOk(
    normalizeSignParams("eth_signTypedData_v4", [json, TEST_ADDRESS], {
      accountAddress: TEST_ADDRESS,
    })
  )
  if (addressFirst.kind !== "typed-data" || jsonFirst.kind !== "typed-data") {
    return assert.fail("wrong kind")
  }
  assert.equal(addressFirst.primaryType, "Mail")
  assert.equal(jsonFirst.primaryType, "Mail")
  assert.equal(addressFirst.digest, jsonFirst.digest)
  assert.equal(addressFirst.domainSummary, "Ether Mail v1 · chain 1")
  assert.equal(addressFirst.domainChainId, 1)
  // The normalized JSON round-trips through the shared validator.
  assert.ok(validateTypedDataJSON(addressFirst.typedDataJson).ok)
})

test("eth_signTypedData_v4 accepts an object payload and the legacy data key", () => {
  const asObject = expectOk(
    normalizeSignParams("eth_signTypedData_v4", [TEST_ADDRESS, TYPED_DATA], {
      accountAddress: TEST_ADDRESS,
    })
  )
  assert.equal(asObject.kind, "typed-data")

  const withDataKey = { ...TYPED_DATA, data: TYPED_DATA.message }
  delete (withDataKey as Record<string, unknown>).message
  const view = expectOk(
    normalizeSignParams("eth_signTypedData_v4", [TEST_ADDRESS, JSON.stringify(withDataKey)], {
      accountAddress: TEST_ADDRESS,
    })
  )
  if (view.kind !== "typed-data") return assert.fail("wrong kind")
  assert.ok(validateTypedDataJSON(view.typedDataJson).ok)
})

test("eth_signTypedData_v4 rejects ambiguous, missing, and invalid payloads", () => {
  const json = JSON.stringify(TYPED_DATA)
  const ambiguous = expectError(
    normalizeSignParams("eth_signTypedData_v4", [json, { ...TYPED_DATA }])
  )
  assert.match(ambiguous, /both/i)

  const noData = expectError(normalizeSignParams("eth_signTypedData_v4", [TEST_ADDRESS, TEST_ADDRESS]))
  assert.match(noData, /do not contain/i)

  const badJson = expectError(
    normalizeSignParams("eth_signTypedData_v4", [TEST_ADDRESS, "{not json"])
  )
  assert.match(badJson, /JSON/)

  const noMessage = expectError(
    normalizeSignParams("eth_signTypedData_v4", [TEST_ADDRESS, JSON.stringify({ types: {} })])
  )
  assert.match(noMessage, /message/i)

  const brokenTypes = expectError(
    normalizeSignParams("eth_signTypedData_v4", [
      TEST_ADDRESS,
      JSON.stringify({ ...TYPED_DATA, types: { Mail: [{ name: "x", type: "Missing" }] } }),
    ])
  )
  assert.ok(brokenTypes.length > 0)
})

test("eth_signTypedData_v4 rejects a signer mismatch", () => {
  const error = expectError(
    normalizeSignParams("eth_signTypedData_v4", [
      OTHER_ADDRESS,
      JSON.stringify(TYPED_DATA),
    ], { accountAddress: TEST_ADDRESS })
  )
  assert.match(error, /unlocked account/)
})

// ---------- normalizeSignParams: eth_sendTransaction ----------

test("eth_sendTransaction validates a well-formed transaction and formats its value", () => {
  const view = expectOk(normalizeTx([txFixture()]))
  if (view.kind !== "transaction") return assert.fail("wrong kind")
  assert.equal(view.tx.to, OTHER_ADDRESS)
  assert.equal(view.tx.valueWei, 1_000_000_000_000_000_000n)
  assert.equal(view.tx.chainId, 1)
  assert.equal(view.networkKey, "mainnet")
  assert.equal(view.networkName, "Ethereum Mainnet")
  assert.equal(view.knownChain, true)
  assert.equal(view.valueDisplay, "1.0 ETH")
  assert.equal(view.currency, "ETH")
  assert.equal(view.hasCalldata, false)
  assert.equal(view.tx.dataBytes, 0)
  // Gas fields survive as normalized hex quantities.
  assert.equal(view.tx.nonce, "0x7")
  assert.equal(view.tx.gasLimit, "0x5208")
  assert.equal(view.tx.gasPrice, "0x77359400")
})

test("eth_sendTransaction accepts decimal values and calldata", () => {
  const view = expectOk(
    normalizeTx([txFixture({ value: "1500000000000000000", data: "0xa9059cbb" + "00".repeat(64) })])
  )
  if (view.kind !== "transaction") return assert.fail("wrong kind")
  assert.equal(view.tx.valueWei, 1_500_000_000_000_000_000n)
  assert.equal(view.hasCalldata, true)
  assert.equal(view.tx.dataBytes, 68)
})

test("eth_sendTransaction formats values with the chain's own decimals", () => {
  // Arc's native unit is USDC — but Arc mints it with 18 decimals, not the 6
  // used by USDC elsewhere (verified against live testnet transactions and
  // docs.arc.io). A 73.27 USDC transfer is 73273025000000000000 base units.
  const view = expectOk(
    normalizeTx([txFixture({ value: "73273025000000000000" })], "eip155:5042002")
  )
  if (view.kind !== "transaction") return assert.fail("wrong kind")
  assert.equal(view.networkKey, "arc-testnet")
  assert.equal(view.currency, "USDC")
  assert.equal(view.valueDisplay, "73.273025 USDC")
})

test("eth_sendTransaction flags unknown chains and shows raw base units", () => {
  const view = expectOk(normalizeTx([txFixture()], "eip155:999999"))
  if (view.kind !== "transaction") return assert.fail("wrong kind")
  assert.equal(view.knownChain, false)
  assert.equal(view.networkKey, null)
  assert.match(view.networkName, /unsupported/)
  assert.match(view.valueDisplay, /base units/)
})

test("eth_sendTransaction rejects structural problems", () => {
  const arity = expectError(normalizeTx([]))
  assert.match(arity, /exactly one/)

  const notObject = expectError(normalizeTx(["0x00"]))
  assert.match(notObject, /exactly one/)

  const noTo = expectError(normalizeTx([txFixture({ to: undefined })]))
  assert.match(noTo, /recipient/)

  const badTo = expectError(normalizeTx([txFixture({ to: "0x1234" })]))
  assert.match(badTo, /recipient/)

  const badChecksum = expectError(normalizeTx([txFixture({ to: BAD_CHECKSUM_ADDRESS })]))
  assert.match(badChecksum, /checksum/)

  const badValue = expectError(normalizeTx([txFixture({ value: "1.5" })]))
  assert.match(badValue, /value/)

  const oddData = expectError(normalizeTx([txFixture({ data: "0x123" })]))
  assert.match(oddData, /data/)

  const badGas = expectError(normalizeTx([txFixture({ gasLimit: "lots" })]))
  assert.match(badGas, /gas limit/)
})

test("eth_sendTransaction rejects a sender that is not the unlocked account", () => {
  const error = expectError(normalizeTx([txFixture({ from: OTHER_ADDRESS })]))
  assert.match(error, /unlocked account/)
})

test("eth_sendTransaction requires a chain and rejects a contradictory inner chain id", () => {
  const noChain = expectError(
    normalizeSignParams("eth_sendTransaction", [txFixture()], { accountAddress: TEST_ADDRESS })
  )
  assert.match(noChain, /chain/)

  const mismatch = expectError(normalizeTx([txFixture({ chainId: "0x89" })], "eip155:1"))
  assert.match(mismatch, /different chain/)

  // An inner chain id that agrees is fine.
  assert.ok(normalizeTx([txFixture({ chainId: "0x1" })], "eip155:1").ok)
})

test("eth_sendTransaction rejects calldata over 64 KB", () => {
  const error = expectError(normalizeTx([txFixture({ data: "0x" + "aa".repeat(33_000) })]))
  assert.match(error, /64 KB/)
})

// ---------- signing ----------

test("signWalletConnectRequest signs a personal_sign message with the vault key", async () => {
  const view = expectOk(
    normalizeSignParams("personal_sign", ["0x68656c6c6f20776f726c64", TEST_ADDRESS], {
      accountAddress: TEST_ADDRESS,
    })
  )
  const signature = expectOk(await signWalletConnectRequest(view, TEST_KEY))
  assert.equal(verifyMessage("hello world", signature), TEST_ADDRESS)
})

test("signWalletConnectRequest signs typed data and the signature verifies", async () => {
  const view = expectOk(
    normalizeSignParams("eth_signTypedData_v4", [TEST_ADDRESS, JSON.stringify(TYPED_DATA)], {
      accountAddress: TEST_ADDRESS,
    })
  )
  const signature = expectOk(await signWalletConnectRequest(view, TEST_KEY))
  const validated = expectOk(validateTypedDataJSON(JSON.stringify(TYPED_DATA)))
  // Recovery is asserted through the app's own verifier, not re-implemented.
  const recovered = verifyTypedDataSignature(TEST_ADDRESS, validated, signature)
  assert.equal(expectOk(recovered).matches, true)
})

test("signWalletConnectRequest refuses an invalid private key without leaking it", async () => {
  const view = expectOk(normalizeSignParams("personal_sign", ["0x00", ""]))
  const error = expectError(await signWalletConnectRequest(view, "not-a-key"))
  assert.match(error, /private key/)
  assert.ok(!error.includes("not-a-key"))
})

test("signWalletConnectRequest signs a complete transaction into broadcastable hex", async () => {
  const view = expectOk(normalizeTx([txFixture()]))
  const signed = expectOk(await signWalletConnectRequest(view, TEST_KEY))
  const parsed = Transaction.from(signed)
  assert.equal(parsed.to, OTHER_ADDRESS)
  assert.equal(parsed.value, 1_000_000_000_000_000_000n)
  assert.equal(parsed.nonce, 7)
  assert.equal(parsed.chainId, 1n)
  assert.equal(parsed.gasLimit, 21_000n)
  // The signature must recover to the vault account.
  assert.ok(parsed.signature !== null, "a signed transaction carries a signature")
  const digest = keccak256(parsed.unsignedSerialized)
  assert.equal(recoverAddress(digest, parsed.signature), TEST_ADDRESS)
})

test("signWalletConnectRequest fills gas and fees from RPC-fetched values", async () => {
  // The dApp supplied none of nonce, gas limit or fees, so everything comes
  // from the RPC-fetched fill values.
  const view = expectOk(
    normalizeTx([txFixture({ nonce: undefined, gasLimit: undefined, gasPrice: undefined })])
  )
  const signed = expectOk(
    await signWalletConnectRequest(view, TEST_KEY, {
      nonce: 5n,
      gasLimit: 65_000n,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
  )
  const parsed = Transaction.from(signed)
  assert.equal(parsed.type, 2)
  assert.equal(parsed.nonce, 5)
  assert.equal(parsed.gasLimit, 65_000n)
  assert.equal(parsed.maxFeePerGas, 30_000_000_000n)
  assert.equal(parsed.maxPriorityFeePerGas, 1_000_000_000n)
})

test("signWalletConnectRequest defaults a plain transfer to the 21,000 intrinsic gas", async () => {
  const view = expectOk(normalizeTx([txFixture({ gasLimit: undefined })]))
  const signed = expectOk(
    await signWalletConnectRequest(view, TEST_KEY, {
      nonce: 1n,
      gasPrice: 2_000_000_000n,
    })
  )
  assert.equal(Transaction.from(signed).gasLimit, 21_000n)
})

test("signWalletConnectRequest refuses transactions it cannot complete", async () => {
  const bare = expectOk(
    normalizeTx([txFixture({ nonce: undefined, gasLimit: undefined, gasPrice: undefined })])
  )
  const nonceless = expectError(await signWalletConnectRequest(bare as TransactionSignView, TEST_KEY))
  assert.match(nonceless, /nonce/)

  const noGas = expectOk(normalizeTx([txFixture({ gasLimit: undefined, gasPrice: undefined })]))
  const gasless = expectError(
    await signWalletConnectRequest(noGas, TEST_KEY, { nonce: 3n, gasLimit: 21_000n })
  )
  assert.match(gasless, /gas price or maximum fee/)

  const noLimit = expectOk(
    normalizeTx([txFixture({ gasLimit: undefined, gasPrice: undefined, data: "0xa9059cbb" })])
  )
  const limitless = expectError(
    await signWalletConnectRequest(noLimit, TEST_KEY, { nonce: 3n, gasPrice: 2_000_000_000n })
  )
  assert.match(limitless, /gas limit/)
})

// ---------- JSON-RPC envelopes ----------

test("jsonRpcSuccess and jsonRpcError build the envelopes the SDK expects", () => {
  assert.deepEqual(jsonRpcSuccess(7, "0xsig"), { id: 7, jsonrpc: "2.0", result: "0xsig" })
  assert.deepEqual(jsonRpcError(7, { code: 5000, message: "User rejected." }), {
    id: 7,
    jsonrpc: "2.0",
    error: { code: 5000, message: "User rejected." },
  })
})

test("the supported-method list is exactly the three signing methods", () => {
  assert.deepEqual([...SUPPORTED_METHODS], [
    "personal_sign",
    "eth_signTypedData_v4",
    "eth_sendTransaction",
  ])
})
