"use client"

/**
 * WalletConnect wallet-side plumbing.
 *
 * EthTools acts as the WALLET in the WalletConnect protocol: an external dApp
 * (Uniswap, a mint page, a dev tool) pairs with it, asks for signatures, and
 * receives locally computed results. The private key never crosses into
 * anything that talks to the network — the SDK only ever sees finished
 * signatures and signed-transaction hex.
 *
 * The module has two halves with different trust models:
 *
 * 1. **Pure helpers** (`parsePairingUri`, `normalizeSignParams`,
 *    `describeSessionProposal`, the CAIP-2 mappers). Everything arriving from a
 *    dApp is hostile until it has passed through these, so they reject wrong
 *    arity, non-hex payloads, absurd sizes, missing fields and non-`https:`
 *    URLs rather than trying to "clean up" input. They are exported for unit
 *    tests and deliberately import no SDK code at runtime.
 * 2. **Runtime plumbing** (`getWalletKit` and the event helpers). Browser-only,
 *    importing the SDK lazily so the pure half stays loadable in Node (the unit
 *    test runner) and out of the first-load JavaScript bundle.
 */

import { Wallet, getAddress, getBytes, type TransactionLike } from "ethers"
import { logger } from "./logger"
import { NETWORKS, getNativeDecimals } from "./ethers"
import { formatTokenAmount } from "./format"
import {
  hashPersonalMessage,
  MAX_MESSAGE_BYTES,
  normalizePrivateKey,
  signPersonalMessage,
  type SignResult,
} from "./signMessage"
import { signTypedData, validateTypedDataJSON } from "./signTypedData"
// Type-only: erased at compile time, so importing this module in Node (unit
// tests) never loads the SDK or its relay client.
import type { IWalletKit, WalletKitTypes } from "@reown/walletkit"

// ===== Constants =====

/**
 * The JSON-RPC methods EthTools will answer on a WalletConnect session.
 *
 * Everything else is auto-rejected with a reason rather than silently ignored:
 * a dApp that sees silence hangs on a pending promise, which reads as a bug in
 * the wallet, while an explicit error tells it (and the user) exactly why.
 */
export const SUPPORTED_METHODS: readonly string[] = [
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
]

/** Literal union of {@link SUPPORTED_METHODS}, for view-model discrimination. */
export type SupportedMethod = "personal_sign" | "eth_signTypedData_v4" | "eth_sendTransaction"

/**
 * Session events EthTools is willing to declare when approving a session.
 *
 * A wallet only ever *emits* these, never receives them, so granting them is
 * safe; in practice they are the only two events EVM dApps request.
 */
export const GRANTABLE_EVENTS: readonly string[] = ["accountsChanged", "chainChanged"]

/**
 * Hard ceiling on any single dApp-supplied payload, in UTF-8 bytes.
 *
 * Far beyond anything a legitimate dApp sends, but small enough that a hostile
 * payload cannot stall the main thread while being hashed, parsed or rendered.
 */
export const MAX_PARAM_BYTES = 64 * 1024

/**
 * The owner's Reown project id. A WalletConnect project id is a public
 * client-side identifier (it names this app to the relay), not a secret, which
 * is why shipping it as a fallback constant is safe. Deployments can override
 * it with `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to use their own project.
 */
export const FALLBACK_WALLETCONNECT_PROJECT_ID = "522907a8ab12702be9c320439813cbec"

/**
 * Largest accepted pairing URI, in characters. A real WalletConnect URI is a
 * topic, a version and one query string — a few hundred characters at most.
 */
const PAIRING_URI_MAX_LENGTH = 2048

/** Character set a WalletConnect pairing topic is made of. */
const PAIRING_TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/

/**
 * Largest number of chains or methods read out of a session proposal before the
 * proposal is declared oversized. A legitimate proposal names a handful; a
 * hostile one can embed unbounded arrays, and approving what was not fully
 * inspected is not an option.
 */
const PROPOSAL_ARRAY_CAP = 64

/** The project id actually used, overridable through the environment. */
const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || FALLBACK_WALLETCONNECT_PROJECT_ID

// ===== SDK-derived types =====

/** A live WalletConnect session, as returned by `getActiveSessions`. */
export type WcSession = ReturnType<IWalletKit["getActiveSessions"]>[string]

/** A proposal retained by the SDK, as returned by `getPendingSessionProposals`. */
export type WcPendingProposal = ReturnType<IWalletKit["getPendingSessionProposals"]>[number]

/** A request retained by the SDK, as returned by `getPendingSessionRequests`. */
export type WcPendingRequest = ReturnType<IWalletKit["getPendingSessionRequests"]>[number]

/** The JSON-RPC envelope `respondSessionRequest` accepts. */
export type WcJsonRpcResponse = Parameters<IWalletKit["respondSessionRequest"]>[0]["response"]

/** The error-reason shape the SDK's reject/disconnect calls expect. */
export type WcErrorReason = Parameters<IWalletKit["rejectSession"]>[0]["reason"]

/** Payload of the `session_proposal` event. */
export type WcSessionProposalEvent = WalletKitTypes.SessionProposal

/** Payload of the `session_request` event. */
export type WcSessionRequestEvent = WalletKitTypes.SessionRequest

/** Payload of the `session_delete` event. */
export type WcSessionDeleteEvent = WalletKitTypes.SessionDelete

/**
 * Error reasons for the SDK's reject/disconnect/respond calls.
 *
 * These mirror `getSdkError(...)` from `@walletconnect/utils`, which is not a
 * direct dependency of this app. The codes and messages are part of the
 * WalletConnect v2 wire contract, so hard-coding them is stable.
 */
export const WC_ERROR = {
  /** The user saw the prompt and declined it. */
  USER_REJECTED: { code: 5000, message: "User rejected." },
  /** The wallet does not know one of the requested chains. */
  UNSUPPORTED_CHAINS: { code: 5100, message: "Unsupported chains." },
  /** The wallet refuses one of the requested methods. */
  UNSUPPORTED_METHODS: { code: 5101, message: "Unsupported methods." },
  /** The user (or the wallet) ended the session. */
  USER_DISCONNECTED: { code: 6000, message: "User disconnected." },
  /** A handler crashed before it could produce a real answer. */
  INTERNAL: { code: -32603, message: "Internal error while handling the request." },
} as const satisfies Record<string, WcErrorReason>

/** Build a JSON-RPC success envelope for `respondSessionRequest`. */
export function jsonRpcSuccess(id: number, result: unknown): WcJsonRpcResponse {
  return { id, jsonrpc: "2.0", result }
}

/** Build a JSON-RPC error envelope for `respondSessionRequest`. */
export function jsonRpcError(id: number, reason: WcErrorReason): WcJsonRpcResponse {
  return { id, jsonrpc: "2.0", error: reason }
}

// ===== CAIP-2 chain mapping =====

/**
 * EIP-155 chain id → key in the app's `NETWORKS` table.
 *
 * `NETWORKS` itself carries no chain ids, yet WalletConnect speaks CAIP-2
 * (`eip155:<id>`), so this table is the join between the two. Every entry was
 * verified in September 2026 against the network's own RPC (`eth_chainId`) or
 * the ethereum-lists registry. A wrong id would be worse than a missing one —
 * it would, for example, format an Arc transfer with 18 decimals instead of
 * Arc's 6 — so chains this table does not list are reported as explicitly
 * unsupported rather than guessed.
 */
export const EIP155_CHAIN_TO_NETWORK_KEY: Readonly<Record<number, string>> = {
  // Mainnets
  1: "mainnet",
  10: "optimism",
  56: "bsc",
  100: "gnosis",
  137: "polygon",
  250: "fantom",
  324: "zksyncera",
  1088: "metis",
  1284: "moonbeam",
  5000: "mantle",
  5031: "somnia",
  // 5042 (Arc Mainnet) is intentionally unmapped: the network is absent from
  // NETWORKS until a keyless public RPC exists, and WalletConnect approval is
  // only granted for chains the app actually knows.
  7000: "zetachain",
  8217: "kaia",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
  42220: "celo",
  534352: "scroll",
  80094: "berachain",
  // Testnets
  919: "mode-sepolia",
  1301: "unichain",
  6343: "megaeth",
  84532: "base-sepolia",
  560048: "hoodi",
  421614: "arbitrum-sepolia",
  91342: "giwa-sepolia",
  11155111: "sepolia",
  11155420: "optimism-sepolia",
  5042002: "arc-testnet",
}

/** How one chain is presented in every WalletConnect dialog. */
export interface ChainView {
  /** CAIP-2 identifier as sent, e.g. `eip155:1`. */
  caip2: string
  /** Numeric chain id, or null when the identifier is not well-formed. */
  chainId: number | null
  /** Key in the app's NETWORKS table, or null when unknown. */
  networkKey: string | null
  /** Friendly name, or an explicit unsupported marker. */
  name: string
  /** Whether the app knows this chain. */
  known: boolean
  /** Whether the dApp named this chain as required (vs merely optional). */
  required: boolean
}

/** Format a numeric chain id as a CAIP-2 identifier. */
export function formatChainId(chainId: number): string {
  return `eip155:${chainId}`
}

/**
 * Parse a CAIP-2 identifier into its numeric EIP-155 chain id.
 *
 * Strict on purpose: `eip155:1` is accepted, `eip155:01`, `eip155:-1`,
 * `cosmos:cosmoshub-4` and non-strings are not. Callers use a null result as
 * "unknown or hostile chain".
 */
export function parseEip155ChainId(chainId: unknown): number | null {
  if (typeof chainId !== "string") return null
  // No leading zeros and no zero: CAIP-2 forbids both, and accepting them
  // would let two spellings of one chain bypass a "known chain" check.
  const match = /^eip155:([1-9]\d{0,9})$/.exec(chainId.trim())
  if (match === null) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Map a CAIP-2 identifier to the app's NETWORKS key.
 *
 * @param chainId - CAIP-2 identifier, e.g. `eip155:1`
 * @returns The network key, or null when the chain is unknown to the app
 */
export function chainIdToNetworkKey(chainId: unknown): string | null {
  const numeric = parseEip155ChainId(chainId)
  if (numeric === null) return null
  const key = EIP155_CHAIN_TO_NETWORK_KEY[numeric]
  return key !== undefined && key in NETWORKS ? key : null
}

/**
 * Describe one chain for display, with unknown chains labelled as such.
 *
 * @param chainId - CAIP-2 identifier as sent by the dApp
 * @param required - Whether the dApp named this chain as required
 */
export function describeChain(chainId: unknown, required = false): ChainView {
  const caip2 = typeof chainId === "string" ? chainId.trim().slice(0, 64) : ""
  const numeric = parseEip155ChainId(caip2)
  const networkKey = chainIdToNetworkKey(caip2)
  return {
    caip2: caip2 || "unknown chain",
    chainId: numeric,
    networkKey,
    name:
      networkKey !== null
        ? NETWORKS[networkKey].name
        : `${caip2 || "malformed chain id"} — unsupported`,
    known: networkKey !== null,
    required,
  }
}

// ===== Pairing URI parsing =====

/**
 * Validate and canonicalize a pasted WalletConnect pairing URI.
 *
 * The URI is the secret that lets a dApp open a relay channel to this wallet,
 * so it is parsed strictly rather than passed through: the scheme must be
 * `wc:` (the `wc://` deep-link variant seen in some QR flows is normalized to
 * it — the SDK treats both identically), the version must be 2, and the pairing
 * key must be present and well-formed. Junk that merely looks like a URI is
 * rejected instead of being handed to the SDK.
 *
 * @param input - Raw pasted text
 * @returns The canonical `wc:…@2?…` URI to pass to `pair()`
 */
export function parsePairingUri(input: unknown): SignResult<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "Paste the pairing code shown by the dApp." }
  }
  const trimmed = input.trim()
  if (trimmed === "") {
    return { ok: false, error: "Paste the pairing code shown by the dApp." }
  }
  if (trimmed.length > PAIRING_URI_MAX_LENGTH) {
    return { ok: false, error: "That pairing code is far longer than a real WalletConnect code." }
  }
  // A QR payload is a single line. Internal whitespace means a paste accident
  // (or an attempt to smuggle structure past the parser), not a valid code.
  if (/\s/.test(trimmed)) {
    return { ok: false, error: "A pairing code is one continuous code with no spaces or line breaks." }
  }

  let body: string
  if (trimmed.startsWith("wc://")) {
    body = trimmed.slice(5)
  } else if (trimmed.startsWith("wc:")) {
    body = trimmed.slice(3)
  } else {
    return {
      ok: false,
      error: "A WalletConnect pairing code starts with “wc:” — copy it again from the dApp.",
    }
  }

  const queryAt = body.indexOf("?")
  const path = queryAt === -1 ? body : body.slice(0, queryAt)
  const query = queryAt === -1 ? "" : body.slice(queryAt + 1)
  const at = path.lastIndexOf("@")
  if (at === -1) {
    return { ok: false, error: "The pairing code is missing its version part (…@2)." }
  }
  const topic = path.slice(0, at)
  const version = path.slice(at + 1)
  if (version !== "2") {
    return { ok: false, error: "Only WalletConnect v2 pairing codes are supported." }
  }
  if (!PAIRING_TOPIC_PATTERN.test(topic)) {
    return { ok: false, error: "The pairing code’s topic is malformed. Copy the code again." }
  }

  const params = new URLSearchParams(query)
  const symKey = params.get("symKey")
  if (symKey === null || !/^[0-9a-f]{64}$/.test(symKey)) {
    return {
      ok: false,
      error: "The pairing code is missing its key, which means it is incomplete or expired.",
    }
  }

  return { ok: true, value: `wc:${topic}@2?${query}` }
}

// ===== Session proposal =====

/** A session proposal decoded into safe, UI-ready values. */
export interface SessionProposalView {
  /** dApp-supplied name, sanitized for display. */
  dappName: string
  /** dApp-supplied URL exactly as sent (display only — never a link). */
  dappUrl: string
  /**
   * The URL as a safe `href`, or null when it is not `https://`.
   *
   * A dApp-controlled string must never become a clickable link unless the
   * scheme is https: `javascript:` and `data:` URLs are the classic smuggle.
   */
  dappUrlHref: string | null
  /** Origin confirmed by WalletConnect's verify registry, when available. */
  verifiedOrigin: OriginCheck | null
  /** Every EVM chain the proposal mentions, required ones flagged. */
  chains: ChainView[]
  /** Required methods (deduplicated, order preserved). */
  methods: string[]
  /** Required events (deduplicated). */
  events: string[]
  /** Required methods EthTools refuses to grant. */
  unsupportedRequiredMethods: string[]
  /** Required chains the app does not know. */
  unsupportedRequiredChains: ChainView[]
  /** Required namespaces other than `eip155` (Cosmos, Solana, …). */
  nonEvmRequiredNamespaces: string[]
  /** Required session events EthTools cannot emit. */
  ungrantableRequiredEvents: string[]
  /** Whether the proposal exceeded the chain/method inspection cap. */
  truncated: boolean
  /** Whether the proposal can be approved at all. */
  approvable: boolean
  /** One-sentence reason the proposal cannot be approved, or null. */
  blockReason: string | null
}

/**
 * What WalletConnect's verify registry concluded about the requester.
 *
 * This is the strongest anti-phishing signal available: the relay itself
 * attests which origin initiated the pairing, which a spoofed dApp cannot
 * forge. `isScam` comes from Reown's scam registry.
 */
export interface OriginCheck {
  /** Verified origin URL, or "" when unknown. */
  origin: string
  /** Registry verdict on the attestation. */
  validation: "UNKNOWN" | "VALID" | "INVALID"
  /** Whether the origin is on Reown's scam list. */
  isScam: boolean
}

/**
 * Extract an origin check from a proposal/request `verifyContext`.
 *
 * Defensive against every field being absent or malformed — an unverifiable
 * request is still shown, just with an explicit "origin not verified" warning.
 */
export function describeVerifiedOrigin(verifyContext: unknown): OriginCheck | null {
  if (typeof verifyContext !== "object" || verifyContext === null) return null
  const verified = (verifyContext as { verified?: unknown }).verified
  if (typeof verified !== "object" || verified === null) return null
  const { origin, validation, isScam } = verified as Record<string, unknown>
  if (typeof origin !== "string" || typeof validation !== "string") return null
  const verdict =
    validation === "VALID" || validation === "INVALID" ? validation : "UNKNOWN"
  return {
    origin: origin.slice(0, 200),
    validation: verdict,
    isScam: isScam === true,
  }
}

/** Strip control characters and cap length — dApp text is rendered, so sanitize it. */
function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return ""
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength)
}

/** Whether a value is a plain, non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validate a dApp-supplied URL for display.
 *
 * Returns the URL as a safe href only when it is `https:`; anything else
 * (`http:`, `javascript:`, `data:`, garbage) is kept as plain text so the user
 * can see what was sent without it ever becoming a link.
 */
function safeUrlHref(raw: string): string | null {
  if (!/^https:\/\/\S+$/i.test(raw)) return null
  return raw
}

/**
 * Decode a session proposal into a safe, UI-ready view model.
 *
 * This is where the "approve only what was inspected" rule is enforced: every
 * array is bounds-checked, every string sanitized, and anything the app cannot
 * serve (unknown chains, unsupported methods, non-EVM namespaces) is collected
 * so the dialog can explain precisely why approval is blocked.
 *
 * The input is typed `unknown` on purpose — it arrives from a dApp through the
 * relay, and this helper is the validator. Two shapes are understood: the
 * `session_proposal` event argument (`{ id, params: ProposalTypes.Struct, … }`)
 * and the bare struct returned by `getPendingSessionProposals()`.
 *
 * @param proposal - The `session_proposal` event argument, or a pending proposal struct
 */
export function describeSessionProposal(proposal: unknown): SessionProposalView {
  const root = isRecord(proposal) ? proposal : {}
  // Event arguments nest the struct under `params`; pending-proposal structs
  // carry its fields at the top level. `params` ends up being the struct in
  // either case, or an empty record for hostile or absent input.
  const params = isRecord(root.params) ? root.params : root
  const proposer = isRecord(params.proposer) ? params.proposer : isRecord(root.proposer) ? root.proposer : {}
  const metadata = isRecord(proposer.metadata) ? proposer.metadata : {}

  const dappName = sanitizeText(metadata.name, 120) || "Unnamed dApp"
  const dappUrl = sanitizeText(metadata.url, 200)

  const chains: ChainView[] = []
  const methods: string[] = []
  const events: string[] = []
  const nonEvmRequiredNamespaces: string[] = []
  const unsupportedRequiredChains: ChainView[] = []
  const unsupportedRequiredMethods: string[] = []
  const ungrantableRequiredEvents: string[] = []
  let truncated = false

  const collect = (namespaces: unknown, required: boolean): void => {
    if (!isRecord(namespaces)) return
    for (const [namespace, entry] of Object.entries(namespaces)) {
      if (namespace !== "eip155") {
        if (required) nonEvmRequiredNamespaces.push(namespace.slice(0, 32))
        continue
      }
      if (!isRecord(entry)) {
        // A required namespace that is not an object is malformed, not empty.
        if (required) truncated = true
        continue
      }
      const { chains: entryChains, methods: entryMethods, events: entryEvents } = entry
      if (Array.isArray(entryChains)) {
        if (entryChains.length > PROPOSAL_ARRAY_CAP) truncated = true
        for (const chain of entryChains.slice(0, PROPOSAL_ARRAY_CAP)) {
          const view = describeChain(chain, required)
          if (!chains.some((existing) => existing.caip2 === view.caip2)) chains.push(view)
          if (required && !view.known && !unsupportedRequiredChains.some((existing) => existing.caip2 === view.caip2)) {
            unsupportedRequiredChains.push(view)
          }
        }
      } else if (required && entryChains !== undefined) {
        // A required namespace whose chains field exists but is not an array
        // is malformed, not merely empty.
        truncated = true
      }
      if (Array.isArray(entryMethods)) {
        if (entryMethods.length > PROPOSAL_ARRAY_CAP) truncated = true
        for (const method of entryMethods.slice(0, PROPOSAL_ARRAY_CAP)) {
          if (typeof method !== "string") {
            if (required) truncated = true
            continue
          }
          const name = method.slice(0, 64)
          if (!methods.includes(name)) methods.push(name)
          if (required && !SUPPORTED_METHODS.includes(name)) unsupportedRequiredMethods.push(name)
        }
      } else if (required && entryMethods !== undefined) {
        truncated = true
      }
      if (required && Array.isArray(entryEvents)) {
        if (entryEvents.length > PROPOSAL_ARRAY_CAP) truncated = true
        for (const event of entryEvents.slice(0, PROPOSAL_ARRAY_CAP)) {
          if (typeof event !== "string") {
            truncated = true
            continue
          }
          const name = event.slice(0, 64)
          if (!events.includes(name)) events.push(name)
          if (!GRANTABLE_EVENTS.includes(name)) ungrantableRequiredEvents.push(name)
        }
      }
    }
  }

  collect(params.requiredNamespaces, true)
  collect(params.optionalNamespaces, false)

  const knownChains = chains.filter((chain) => chain.known)

  // The first applicable reason wins; order is most-fundamental first.
  let blockReason: string | null = null
  if (truncated) {
    blockReason = "The connection request is malformed or oversized, so it cannot be reviewed safely."
  } else if (nonEvmRequiredNamespaces.length > 0) {
    blockReason = `The dApp requires the ${nonEvmRequiredNamespaces.join(", ")} namespace, which EthTools cannot serve — it is an EVM-only wallet.`
  } else if (unsupportedRequiredChains.length > 0) {
    blockReason = `The dApp requires chains EthTools does not know: ${unsupportedRequiredChains
      .map((chain) => chain.caip2)
      .join(", ")}.`
  } else if (unsupportedRequiredMethods.length > 0) {
    blockReason = `The dApp requires methods EthTools does not support: ${unsupportedRequiredMethods.join(
      ", "
    )}. Supported: personal_sign, eth_signTypedData_v4, eth_sendTransaction.`
  } else if (ungrantableRequiredEvents.length > 0) {
    blockReason = `The dApp requires session events EthTools cannot emit: ${ungrantableRequiredEvents.join(", ")}.`
  } else if (knownChains.length === 0) {
    blockReason = "The dApp did not name any EVM chain that EthTools recognizes."
  }

  return {
    dappName,
    dappUrl,
    dappUrlHref: safeUrlHref(dappUrl),
    verifiedOrigin: describeVerifiedOrigin(root.verifyContext),
    chains,
    methods,
    events,
    unsupportedRequiredMethods,
    unsupportedRequiredChains,
    nonEvmRequiredNamespaces,
    ungrantableRequiredEvents,
    truncated,
    approvable: blockReason === null,
    blockReason,
  }
}

/** The namespaces payload for `approveSession`, keyed by CAIP namespace. */
export interface ApprovalNamespaces {
  [namespace: string]: {
    chains: string[]
    accounts: string[]
    methods: string[]
    events: string[]
  }
}

/**
 * Build the namespaces with which a proposal may be approved.
 *
 * Grants only chains the app actually knows (each bound to the vault account
 * as a CAIP-10 address), only the supported methods, and only events EthTools
 * declares. Refuses — with the proposal's own block reason — when the view
 * marked the proposal unapprovable, because a hand-built namespace payload
 * that silently drops a required chain would produce a session the dApp
 * immediately rejects.
 *
 * @param view - A decoded proposal view
 * @param address - The vault account's address
 */
export function buildApprovalNamespaces(
  view: SessionProposalView,
  address: string
): SignResult<ApprovalNamespaces> {
  if (!view.approvable) {
    return { ok: false, error: view.blockReason ?? "This connection request cannot be approved." }
  }
  const chainIds = Array.from(
    new Set(view.chains.filter((chain) => chain.known && chain.chainId !== null).map((chain) => chain.chainId as number))
  ).sort((a, b) => a - b)
  if (chainIds.length === 0) {
    return { ok: false, error: "No approvable EVM chain was named." }
  }
  return {
    ok: true,
    value: {
      eip155: {
        chains: chainIds.map((chainId) => formatChainId(chainId)),
        accounts: chainIds.map((chainId) => `eip155:${chainId}:${address}`),
        methods: [...SUPPORTED_METHODS],
        events: [...GRANTABLE_EVENTS],
      },
    },
  }
}

// ===== Active sessions =====

/** A live session decoded into safe, UI-ready values. */
export interface SessionSummary {
  topic: string
  dappName: string
  dappUrl: string
  dappUrlHref: string | null
  chains: ChainView[]
}

/**
 * Decode an active session into a display row.
 *
 * The peer metadata is dApp-controlled, so it passes through the same
 * sanitizing rules as proposal metadata. The input is typed `unknown` because
 * it crosses the same trust boundary, even though it comes from the SDK's own
 * session store.
 *
 * @param session - One value from `getActiveSessions()`
 */
export function describeActiveSession(session: unknown): SessionSummary {
  const root = isRecord(session) ? session : {}
  const peer = isRecord(root.peer) ? root.peer : {}
  const metadata = isRecord(peer.metadata) ? peer.metadata : {}
  const dappName = sanitizeText(metadata.name, 120) || "Unnamed dApp"
  const dappUrl = sanitizeText(metadata.url, 200)
  const chains: ChainView[] = []
  const namespaces = isRecord(root.namespaces) ? root.namespaces : {}
  for (const [namespace, entry] of Object.entries(namespaces)) {
    if (namespace !== "eip155") continue
    if (!isRecord(entry) || !Array.isArray(entry.chains)) continue
    for (const chain of entry.chains) {
      const view = describeChain(chain, true)
      if (!chains.some((existing) => existing.caip2 === view.caip2)) chains.push(view)
    }
  }
  return {
    topic: typeof root.topic === "string" ? root.topic : "",
    dappName,
    dappUrl,
    dappUrlHref: safeUrlHref(dappUrl),
    chains,
  }
}

// ===== Request normalization =====

/** Extra, trusted context for normalizing a dApp request. */
export interface SignRequestContext {
  /** The CAIP-2 chain the request was routed to (`eth_sendTransaction` requires it). */
  chainId?: unknown
  /** The unlocked vault account, to cross-check the dApp's requested signer. */
  accountAddress?: string
}

/** A `personal_sign` request decoded for review. */
export interface PersonalSignView {
  method: "personal_sign"
  kind: "message"
  /** The message text, exactly the bytes that will be signed. */
  message: string
  /** Message size in bytes. */
  byteLength: number
  /** The EIP-191 digest of the message. */
  digest: string
  /** The address the dApp asked to sign, checksummed, or null when unstated. */
  signerAddress: string | null
}

/** An `eth_signTypedData_v4` request decoded for review. */
export interface TypedDataView {
  method: "eth_signTypedData_v4"
  kind: "typed-data"
  /** Normalized typed-data JSON, ready for `validateTypedDataJSON`. */
  typedDataJson: string
  /** The payload's primary type, derived by compiling the type graph. */
  primaryType: string
  /** One-line domain summary, e.g. "EtherToken v1 · chain 1". */
  domainSummary: string
  /** Chain id declared inside the domain, or null when absent. */
  domainChainId: number | null
  /** The EIP-712 digest of the payload. */
  digest: string
  /** The address the dApp asked to sign, checksummed, or null when unstated. */
  signerAddress: string | null
}

/** The validated fields of an `eth_sendTransaction` request. */
export interface TransactionFields {
  /** Recipient, checksummed. */
  to: string
  /** Value in base units, as a normalized hex quantity. */
  value: string
  /** Value in base units. */
  valueWei: bigint
  /** Calldata, normalized hex; `"0x"` when none. */
  data: string
  /** Calldata size in bytes. */
  dataBytes: number
  /** Numeric EIP-155 chain id taken from the request envelope. */
  chainId: number
  /** Optional gas fields, each a normalized hex quantity when present. */
  nonce?: string
  gasLimit?: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}

/** An `eth_sendTransaction` request decoded for review. */
export interface TransactionSignView {
  method: "eth_sendTransaction"
  kind: "transaction"
  tx: TransactionFields
  /** NETWORKS key for the chain, or null when unknown. */
  networkKey: string | null
  /** Friendly chain name, or an explicit unsupported marker. */
  networkName: string
  /** Whether the app knows the chain well enough to use its RPCs. */
  knownChain: boolean
  /** Human-readable value with the chain's native symbol when known. */
  valueDisplay: string
  /** Native currency symbol, or null when the chain is unknown. */
  currency: string | null
  /** Whether the transaction carries calldata (a contract call, not a transfer). */
  hasCalldata: boolean
}

/** A validated, UI-ready view of a supported dApp request. */
export type NormalizedSignRequest = PersonalSignView | TypedDataView | TransactionSignView

/**
 * Normalize and validate a session request's parameters into a view model.
 *
 * This is the security boundary of the signing flow: whatever passes has the
 * right arity, the right shapes, sane sizes and a consistent signer, and the
 * dialog can render it without further parsing. Anything else is rejected with
 * a user-presentable reason, and the request is answered with an error instead
 * of being signed blind.
 *
 * @param method - The JSON-RPC method the dApp requested
 * @param params - The raw `params` array from the request
 * @param context - Trusted context: the request's chain id and the active account
 */
export function normalizeSignParams(
  method: string,
  params: unknown,
  context?: SignRequestContext
): SignResult<NormalizedSignRequest> {
  if (!SUPPORTED_METHODS.includes(method)) {
    return {
      ok: false,
      error: `EthTools only supports personal_sign, eth_signTypedData_v4 and eth_sendTransaction — “${String(method).slice(0, 64)}” was rejected.`,
    }
  }
  if (!Array.isArray(params)) {
    return { ok: false, error: "The request parameters are malformed (expected a list)." }
  }
  const size = measureParams(params)
  if (!size.ok) return size

  if (method === "personal_sign") return normalizePersonalSign(params, context)
  if (method === "eth_signTypedData_v4") return normalizeTypedData(params, context)
  return normalizeTransaction(params, context)
}

/** Bound the serialized size of the raw params before any per-field work. */
function measureParams(params: unknown[]): SignResult<true> {
  try {
    const serialized = JSON.stringify(params) ?? ""
    if (serialized.length > MAX_PARAM_BYTES) {
      return {
        ok: false,
        error: "The request payload is larger than 64 KB and was rejected without inspection.",
      }
    }
  } catch {
    return { ok: false, error: "The request parameters could not be inspected." }
  }
  return { ok: true, value: true }
}

/**
 * Validate a dApp-supplied signer address against the active account.
 *
 * Returns null when the dApp did not state a signer (legitimate and common for
 * personal_sign). A stated address that is malformed, has a bad EIP-55
 * checksum, or names a *different* account than the unlocked one is rejected:
 * signing for another address would produce a signature the dApp cannot use
 * and hints at a confused or hostile caller.
 */
function validateRequestedSigner(
  raw: unknown,
  accountAddress: string | undefined,
  field: string
): SignResult<string | null> {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { ok: true, value: null }
  }
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw.trim())) {
    return { ok: false, error: `The ${field} parameter is not an Ethereum address.` }
  }
  let checksummed: string
  try {
    checksummed = getAddress(raw.trim())
  } catch {
    return {
      ok: false,
      error: `The ${field} address is mixed-case with an invalid EIP-55 checksum.`,
    }
  }
  if (accountAddress !== undefined && checksummed.toLowerCase() !== accountAddress.toLowerCase()) {
    return {
      ok: false,
      error: `The dApp asked ${checksummed.slice(0, 10)}… to sign, but the unlocked account is ${accountAddress.slice(0, 10)}….`,
    }
  }
  return { ok: true, value: checksummed }
}

/** Decode a `personal_sign` payload. */
function normalizePersonalSign(
  params: unknown[],
  context?: SignRequestContext
): SignResult<PersonalSignView> {
  if (params.length !== 2) {
    return {
      ok: false,
      error: "personal_sign takes exactly two parameters (the message and the address).",
    }
  }
  const [rawMessage, rawSigner] = params
  if (typeof rawMessage !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(rawMessage)) {
    return {
      ok: false,
      error: "The personal_sign message must be hex-encoded data (starting with 0x).",
    }
  }
  const bytes = getBytes(rawMessage)
  if (bytes.length === 0) {
    return { ok: false, error: "The dApp sent an empty message." }
  }
  if (bytes.length > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      error: `The message is ${(bytes.length / 1024).toFixed(1)} KB. Messages are limited to 10 KB so that what is signed stays readable.`,
    }
  }
  // Decode to text and prove the round trip is exact. If it is not, the payload
  // is binary that cannot be displayed for review — and blind-signing binary
  // data is exactly what this boundary exists to prevent.
  const text = new TextDecoder().decode(bytes)
  const reencoded = new TextEncoder().encode(text)
  const roundTrips =
    reencoded.length === bytes.length && reencoded.every((byte, index) => byte === bytes[index])
  if (!roundTrips) {
    return {
      ok: false,
      error: "The message is binary data that cannot be displayed as text, so EthTools refuses to sign it.",
    }
  }
  const signer = validateRequestedSigner(rawSigner, context?.accountAddress, "signing address")
  if (!signer.ok) return signer

  return {
    ok: true,
    value: {
      method: "personal_sign",
      kind: "message",
      message: text,
      byteLength: bytes.length,
      digest: hashPersonalMessage(text),
      signerAddress: signer.value,
    },
  }
}

/** Whether a parameter looks like a typed-data payload (stringified or object). */
function looksLikeTypedData(value: unknown): boolean {
  if (typeof value === "string") return value.trim().startsWith("{")
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Decode an `eth_signTypedData_v4` payload. */
function normalizeTypedData(
  params: unknown[],
  context?: SignRequestContext
): SignResult<TypedDataView> {
  if (params.length !== 2) {
    return {
      ok: false,
      error: "eth_signTypedData_v4 takes exactly two parameters (the address and the typed data).",
    }
  }
  const [first, second] = params
  const firstIsData = looksLikeTypedData(first)
  const secondIsData = looksLikeTypedData(second)
  if (firstIsData && secondIsData) {
    return { ok: false, error: "Both eth_signTypedData_v4 parameters look like typed data." }
  }
  const data = firstIsData ? first : secondIsData ? second : undefined
  if (data === undefined) {
    return {
      ok: false,
      error: "The eth_signTypedData_v4 parameters do not contain a typed-data payload.",
    }
  }
  const signer = validateRequestedSigner(
    firstIsData ? second : first,
    context?.accountAddress,
    "signing address"
  )
  if (!signer.ok) return signer

  // Some dApps ship the message struct under "data" instead of "message";
  // normalize to the canonical key before handing it to the validator.
  let payload: Record<string, unknown>
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: "The typed-data payload must be a JSON object." }
      }
      payload = parsed as Record<string, unknown>
    } catch {
      return { ok: false, error: "The typed-data payload is not valid JSON." }
    }
  } else {
    payload = data as Record<string, unknown>
  }
  const message = payload.message !== undefined ? payload.message : payload.data
  if (message === undefined) {
    return {
      ok: false,
      error: 'The typed-data payload is missing its message struct ("message" or "data").',
    }
  }
  const normalized: Record<string, unknown> = {
    types: payload.types,
    domain: payload.domain,
    message,
  }
  if (payload.primaryType !== undefined) normalized.primaryType = payload.primaryType
  const typedDataJson = JSON.stringify(normalized)

  // Deep validation (type-graph compile + digest) runs here, not at sign time,
  // so the dialog can show the primary type and any rejection reason.
  const validated = validateTypedDataJSON(typedDataJson)
  if (!validated.ok) return validated

  const domain = validated.value.domain
  const name = typeof domain.name === "string" && domain.name !== "" ? domain.name : "Unnamed domain"
  const version = typeof domain.version === "string" && domain.version !== "" ? ` v${domain.version}` : ""
  const domainChainId =
    typeof domain.chainId === "number" && Number.isSafeInteger(domain.chainId)
      ? domain.chainId
      : typeof domain.chainId === "string" && /^\d+$/.test(domain.chainId)
        ? Number(domain.chainId)
        : null

  return {
    ok: true,
    value: {
      method: "eth_signTypedData_v4",
      kind: "typed-data",
      typedDataJson,
      primaryType: validated.value.primaryType,
      domainSummary: `${name}${version} · chain ${domainChainId ?? "?"}`,
      domainChainId,
      digest: validated.value.digest,
      signerAddress: signer.value,
    },
  }
}

/**
 * Parse a JSON-RPC quantity: a 0x-hex quantity, a decimal string, or a number.
 *
 * Returns null for absent values and for anything malformed — callers decide
 * which of those two is an error.
 */
function parseQuantity(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (/^0x[0-9a-fA-F]*$/.test(trimmed)) {
    return trimmed === "0x" ? 0n : BigInt(trimmed)
  }
  if (/^\d{1,79}$/.test(trimmed)) return BigInt(trimmed)
  return null
}

/** Format a bigint as a normalized 0x-hex quantity. */
function toHexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`
}

/** Validate an optional quantity field, rejecting malformed input. */
function optionalQuantity(
  value: unknown,
  field: string
): SignResult<{ hex?: string; value?: bigint }> {
  if (value === undefined || value === null) return { ok: true, value: {} }
  const parsed = parseQuantity(value)
  if (parsed === null) {
    return { ok: false, error: `The transaction’s ${field} is neither a hex nor a decimal number.` }
  }
  return { ok: true, value: { hex: toHexQuantity(parsed), value: parsed } }
}

/** Decode an `eth_sendTransaction` payload. */
function normalizeTransaction(
  params: unknown[],
  context?: SignRequestContext
): SignResult<TransactionSignView> {
  if (params.length !== 1 || typeof params[0] !== "object" || params[0] === null || Array.isArray(params[0])) {
    return { ok: false, error: "eth_sendTransaction takes exactly one transaction object." }
  }
  const raw = params[0] as Record<string, unknown>

  if (typeof raw.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw.to.trim())) {
    return { ok: false, error: "The transaction is missing a valid recipient address." }
  }
  let to: string
  try {
    to = getAddress(raw.to.trim())
  } catch {
    return {
      ok: false,
      error: "The recipient address is mixed-case with an invalid EIP-55 checksum.",
    }
  }

  const from = validateRequestedSigner(raw.from, context?.accountAddress, "sender (from)")
  if (!from.ok) return from

  const value = optionalQuantity(raw.value, "value")
  if (!value.ok) return value
  const valueWei = value.value.value ?? 0n

  let data = "0x"
  if (raw.data !== undefined && raw.data !== null) {
    if (typeof raw.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.data)) {
      return { ok: false, error: "The transaction’s data field is not valid hex." }
    }
    data = raw.data === "" ? "0x" : raw.data
    if ((data.length - 2) / 2 > MAX_PARAM_BYTES) {
      return { ok: false, error: "The transaction’s calldata exceeds the 64 KB limit." }
    }
  }
  const dataBytes = (data.length - 2) / 2

  const chainId = parseEip155ChainId(context?.chainId)
  if (chainId === null) {
    return { ok: false, error: "The request does not name a valid EVM chain." }
  }
  // Some dApps repeat the chain id inside the transaction object; when present
  // it must agree with the request envelope, or the signature would be bound to
  // a different chain than the one the user believes they are transacting on.
  if (raw.chainId !== undefined && raw.chainId !== null) {
    const innerChainId = parseQuantity(raw.chainId)
    if (innerChainId === null || innerChainId !== BigInt(chainId)) {
      return {
        ok: false,
        error: "The transaction names a different chain than the request it arrived in.",
      }
    }
  }

  const nonce = optionalQuantity(raw.nonce, "nonce")
  if (!nonce.ok) return nonce
  const gasLimit = optionalQuantity(raw.gasLimit ?? raw.gas, "gas limit")
  if (!gasLimit.ok) return gasLimit
  const gasPrice = optionalQuantity(raw.gasPrice, "gas price")
  if (!gasPrice.ok) return gasPrice
  const maxFeePerGas = optionalQuantity(raw.maxFeePerGas, "max fee per gas")
  if (!maxFeePerGas.ok) return maxFeePerGas
  const maxPriorityFeePerGas = optionalQuantity(raw.maxPriorityFeePerGas, "max priority fee per gas")
  if (!maxPriorityFeePerGas.ok) return maxPriorityFeePerGas

  const networkKey = chainIdToNetworkKey(context?.chainId)
  const knownChain = networkKey !== null
  const networkName =
    networkKey !== null ? NETWORKS[networkKey].name : `eip155:${chainId} — unsupported`
  const currency = networkKey !== null ? NETWORKS[networkKey].currency : null
  const valueDisplay =
    networkKey !== null
      ? `${formatTokenAmount(valueWei, getNativeDecimals(networkKey), 6)} ${currency}`
      : `${valueWei.toString()} base units (native decimals unknown)`

  return {
    ok: true,
    value: {
      method: "eth_sendTransaction",
      kind: "transaction",
      tx: {
        to,
        value: toHexQuantity(valueWei),
        valueWei,
        data,
        dataBytes,
        chainId,
        nonce: nonce.value.hex,
        gasLimit: gasLimit.value.hex,
        gasPrice: gasPrice.value.hex,
        maxFeePerGas: maxFeePerGas.value.hex,
        maxPriorityFeePerGas: maxPriorityFeePerGas.value.hex,
      },
      networkKey,
      networkName,
      knownChain,
      valueDisplay,
      currency,
      hasCalldata: dataBytes > 0,
    },
  }
}

// ===== Signing =====

/**
 * Fee and nonce values fetched from an RPC when the dApp did not supply them.
 *
 * A transaction returned to a dApp as signed hex must be complete: the dApp
 * broadcasts it as-is and cannot fill in gas or a nonce afterwards, because
 * both are covered by the signature.
 */
export interface TransactionFillOptions {
  /** Next nonce for the account (`getTransactionCount(…, "pending")`). */
  nonce?: bigint
  /** Estimated gas limit for the transaction. */
  gasLimit?: bigint
  /** Current EIP-1559 maximum total fee per gas. */
  maxFeePerGas?: bigint
  /** Current EIP-1559 priority fee per gas. */
  maxPriorityFeePerGas?: bigint
  /** Current legacy gas price, for chains without EIP-1559. */
  gasPrice?: bigint
}

/**
 * List what is still missing before a transaction view can be signed.
 *
 * Mirrors the checks in the signer so the approval dialog can disable its
 * Approve button with an explanation, instead of letting the user approve and
 * discovering the refusal afterwards. Empty list means signable.
 *
 * @param view - A transaction view from {@link normalizeSignParams}
 * @param fill - RPC-fetched values, when enrichment succeeded
 */
export function transactionSigningBlockers(
  view: TransactionSignView,
  fill?: TransactionFillOptions
): string[] {
  const blockers: string[] = []
  if (view.tx.nonce === undefined && fill?.nonce === undefined) {
    blockers.push("the transaction has no nonce and the account’s next nonce is unknown")
  }
  if (view.tx.gasLimit === undefined && fill?.gasLimit === undefined && view.tx.dataBytes !== 0) {
    // A plain transfer always costs exactly the 21,000-unit intrinsic gas, so
    // it needs no estimate; anything with calldata does.
    blockers.push("the transaction has no gas limit and none could be estimated")
  }
  if (
    view.tx.gasPrice === undefined &&
    view.tx.maxFeePerGas === undefined &&
    fill?.gasPrice === undefined &&
    fill?.maxFeePerGas === undefined
  ) {
    blockers.push("the transaction names no gas price or maximum fee and current fees are unknown")
  }
  return blockers
}

/**
 * Sign a normalized request locally with the vault account's key.
 *
 * Dispatches to the app's existing signing modules for messages and typed
 * data, and to ethers for transactions. Nothing here touches the network: the
 * only results that leave this function are signature and signed-transaction
 * hex.
 *
 * @param request - A view produced by {@link normalizeSignParams}
 * @param privateKey - The vault account's private key
 * @param transactionFill - RPC-fetched values for a transaction missing them
 */
export async function signWalletConnectRequest(
  request: NormalizedSignRequest,
  privateKey: string,
  transactionFill?: TransactionFillOptions
): Promise<SignResult<string>> {
  if (request.kind === "message") {
    return signPersonalMessage(privateKey, request.message)
  }
  if (request.kind === "typed-data") {
    const validated = validateTypedDataJSON(request.typedDataJson)
    if (!validated.ok) return validated
    return signTypedData(privateKey, validated.value)
  }
  return signTransactionRequest(request, privateKey, transactionFill)
}

/**
 * Sign a transaction view into broadcastable hex.
 *
 * EthTools deliberately does **not** broadcast: in wallet-side WalletConnect
 * flows many dApps expect the signed transaction itself and submit it through
 * their own RPC. That means the signature must cover a *complete* transaction
 * — nonce, gas limit and fees included — so this function refuses rather than
 * signing something with zeroed fields that could never confirm.
 */
async function signTransactionRequest(
  view: TransactionSignView,
  privateKey: string,
  fill?: TransactionFillOptions
): Promise<SignResult<string>> {
  const key = normalizePrivateKey(privateKey)
  if (!key.ok) return key

  const dappNonce = view.tx.nonce !== undefined ? BigInt(view.tx.nonce) : undefined
  const nonce = dappNonce ?? fill?.nonce
  if (nonce === undefined) {
    return {
      ok: false,
      error: "The transaction has no nonce and the account’s next nonce could not be fetched, so a valid signature is impossible.",
    }
  }
  // TransactionLike types the nonce as a number; account nonces are far below
  // the safe-integer ceiling, so the conversion is exact.
  if (!Number.isSafeInteger(Number(nonce))) {
    return { ok: false, error: "The transaction’s nonce is out of range." }
  }

  const dappGasLimit = view.tx.gasLimit !== undefined ? BigInt(view.tx.gasLimit) : undefined
  const gasLimit = dappGasLimit ?? fill?.gasLimit ?? (view.tx.dataBytes === 0 ? 21_000n : undefined)
  if (gasLimit === undefined) {
    return {
      ok: false,
      error: "The transaction has no gas limit and gas could not be estimated for this network.",
    }
  }

  const tx: TransactionLike = {
    chainId: view.tx.chainId,
    to: view.tx.to,
    value: view.tx.valueWei,
    data: view.tx.data,
    nonce: Number(nonce),
    gasLimit,
  }

  // Fee strategy: prefer what the dApp specified, then RPC-fetched values, and
  // refuse to sign when neither exists. Mixing legacy and EIP-1559 fields would
  // make ethers throw, so exactly one branch sets fees.
  if (view.tx.gasPrice !== undefined) {
    tx.gasPrice = BigInt(view.tx.gasPrice)
  } else if (view.tx.maxFeePerGas !== undefined) {
    tx.maxFeePerGas = BigInt(view.tx.maxFeePerGas)
    tx.maxPriorityFeePerGas =
      view.tx.maxPriorityFeePerGas !== undefined
        ? BigInt(view.tx.maxPriorityFeePerGas)
        : (fill?.maxPriorityFeePerGas ?? 0n)
  } else if (fill?.maxFeePerGas !== undefined) {
    tx.maxFeePerGas = fill.maxFeePerGas
    tx.maxPriorityFeePerGas =
      view.tx.maxPriorityFeePerGas !== undefined
        ? BigInt(view.tx.maxPriorityFeePerGas)
        : (fill.maxPriorityFeePerGas ?? 0n)
  } else if (fill?.gasPrice !== undefined) {
    tx.gasPrice = fill.gasPrice
  } else {
    return {
      ok: false,
      error: "The transaction names no gas price or maximum fee, and current fees could not be fetched for this network.",
    }
  }

  try {
    const wallet = new Wallet(key.value)
    return { ok: true, value: await wallet.signTransaction(tx) }
  } catch (cause) {
    // Never surface the raw error: it embeds the full transaction object.
    logger.warn("WalletConnect transaction signing failed", { error: cause })
    return {
      ok: false,
      error: "The transaction could not be signed. It may contain a field this chain rejects.",
    }
  }
}

// ===== Runtime plumbing =====

let walletKitPromise: Promise<IWalletKit> | null = null

/**
 * The app's WalletKit client, initialized at most once per page session.
 *
 * Lazy in both senses: the SDK is imported inside this function (keeping it
 * out of the initial bundle and out of Node entirely), and the init promise is
 * memoized so concurrent callers — React Strict Mode double-mounts included —
 * share one client. A failed init clears the memo so the user can retry.
 *
 * Must only be called in the browser; the WalletConnect relay is a WebSocket.
 */
export function getWalletKit(): Promise<IWalletKit> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("WalletConnect can only be initialized in the browser."))
  }
  if (walletKitPromise === null) {
    walletKitPromise = initializeWalletKit().catch((error: unknown) => {
      walletKitPromise = null
      throw error
    })
  }
  return walletKitPromise
}

/** Construct and initialize the WalletKit client. */
async function initializeWalletKit(): Promise<IWalletKit> {
  const [{ Core }, { WalletKit }] = await Promise.all([
    import("@walletconnect/core"),
    import("@reown/walletkit"),
  ])

  const origin = window.location.origin
  // A named database makes sessions and pending requests survive a page
  // reload; Core's own default is ":memory:", which forgets every pairing the
  // moment the tab closes. The storage layer degrades to localStorage when
  // IndexedDB is unavailable (private windows, sandboxed iframes), so this
  // stays safe in the Farcaster mini-app embed too.
  const core = new Core({
    projectId,
    storageOptions: { database: "walletconnect" },
  })

  return WalletKit.init({
    core,
    metadata: {
      name: "EthTools",
      description:
        "Client-side Ethereum wallet utility. Keys are encrypted in the browser and never sent to a server.",
      url: process.env.NEXT_PUBLIC_SITE_URL || origin,
      // The app's own icon, served from its own origin — never a third-party
      // host a dApp could probe for tracking.
      icons: [`${origin}/icon.svg`],
    },
  })
}

/** Event handlers the panel wires up to a WalletKit client. */
export interface WalletKitEventHandlers {
  onSessionProposal?: (event: WcSessionProposalEvent) => void
  onSessionRequest?: (event: WcSessionRequestEvent) => void
  onSessionDelete?: (event: WcSessionDeleteEvent) => void
  onProposalExpire?: (event: WalletKitTypes.ProposalExpire) => void
  onSessionRequestExpire?: (event: WalletKitTypes.SessionRequestExpire) => void
}

/**
 * Subscribe to the WalletConnect events the panel cares about.
 *
 * @param kit - The shared client
 * @param handlers - Callbacks for the events to observe
 * @returns An unsubscribe function that removes every listener added
 */
export function subscribeWalletKitEvents(
  kit: IWalletKit,
  handlers: WalletKitEventHandlers
): () => void {
  const teardown: Array<() => void> = []

  if (handlers.onSessionProposal) {
    const listener = (event: WcSessionProposalEvent): void => {
      handlers.onSessionProposal?.(event)
    }
    kit.on("session_proposal", listener)
    teardown.push(() => kit.off("session_proposal", listener))
  }
  if (handlers.onSessionRequest) {
    const listener = (event: WcSessionRequestEvent): void => {
      handlers.onSessionRequest?.(event)
    }
    kit.on("session_request", listener)
    teardown.push(() => kit.off("session_request", listener))
  }
  if (handlers.onSessionDelete) {
    const listener = (event: WcSessionDeleteEvent): void => {
      handlers.onSessionDelete?.(event)
    }
    kit.on("session_delete", listener)
    teardown.push(() => kit.off("session_delete", listener))
  }
  if (handlers.onProposalExpire) {
    const listener = (event: WalletKitTypes.ProposalExpire): void => {
      handlers.onProposalExpire?.(event)
    }
    kit.on("proposal_expire", listener)
    teardown.push(() => kit.off("proposal_expire", listener))
  }
  if (handlers.onSessionRequestExpire) {
    const listener = (event: WalletKitTypes.SessionRequestExpire): void => {
      handlers.onSessionRequestExpire?.(event)
    }
    kit.on("session_request_expire", listener)
    teardown.push(() => kit.off("session_request_expire", listener))
  }

  return () => {
    for (const off of teardown) off()
  }
}
