"use client"

/**
 * WalletConnect panel: lets external dApps pair with EthTools as their wallet.
 *
 * The flow, and the reasoning behind it:
 *
 * - **Pairing.** The user pastes the `wc:` code a dApp shows (the QR payload's
 *   text). `parsePairingUri` validates it before the SDK ever sees it.
 * - **Proposals.** The dApp's connection request appears in a dialog listing
 *   exactly which chains and methods it asks for. Approval grants only chains
 *   the app knows and only the three supported methods — never more than was
 *   inspected on screen.
 * - **Requests.** `personal_sign`, `eth_signTypedData_v4` and
 *   `eth_sendTransaction` arrive as pending requests. Everything is decoded by
 *   `normalizeSignParams` (the security boundary) before it is rendered, and
 *   signing happens locally with the vault account's key via the app's own
 *   signing modules. Only signatures and signed-transaction hex travel back
 *   through the relay — `eth_sendTransaction` is signed, not broadcast, which
 *   is what wallet-side dApps expect.
 * - **Never left hanging.** Every response path answers the dApp, including a
 *   crashed handler (which falls back to an internal-error response) and
 *   unsupported methods (auto-rejected with a reason).
 *
 * Requests and proposals that arrive while this panel is unmounted — the vault
 * auto-locks and closes it — are retained by the SDK and resurfaced here on
 * the next mount, for as long as the tab (and the SDK's persisted storage)
 * lives. Requests expire on their own after five minutes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { formatUnits } from "ethers"
import { FileText, Link2, MessageSquareText, RefreshCw, Send, Unplug } from "lucide-react"
import type { IWalletKit } from "@reown/walletkit"
import Card, { CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Badge from "./ui/Badge"
import Alert from "./ui/Alert"
import Field, { monoInputClassName, secretInputProps } from "./ui/Field"
import ResponsiveDialog from "./ui/ResponsiveDialog"
import { EmptyState, ErrorState } from "./ui/Feedback"
import Skeleton, { SkeletonGroup } from "./ui/Skeleton"
import CopyButton from "./ui/CopyButton"
import { notify } from "./ui/Toast"
import { truncateHex } from "@/lib/format"
import { describeError, logger } from "@/lib/logger"
import { withProvider } from "@/lib/ethers"
import { useOnlineStatus } from "@/lib/useOnlineStatus"
import {
  buildApprovalNamespaces,
  describeActiveSession,
  describeSessionProposal,
  describeVerifiedOrigin,
  getWalletKit,
  jsonRpcError,
  jsonRpcSuccess,
  normalizeSignParams,
  parsePairingUri,
  signWalletConnectRequest,
  subscribeWalletKitEvents,
  SUPPORTED_METHODS,
  transactionSigningBlockers,
  WC_ERROR,
  type ChainView,
  type NormalizedSignRequest,
  type OriginCheck,
  type SessionProposalView,
  type SessionSummary,
  type TransactionFillOptions,
  type TransactionSignView,
  type WcJsonRpcResponse,
  type WcSessionDeleteEvent,
  type WcSessionProposalEvent,
  type WcSessionRequestEvent,
} from "@/lib/walletConnect"

export interface WalletConnectPanelProps {
  /** The active vault account; signing is impossible without it. */
  account: { address: string; privateKey: string }
  /** Called with a short status line for the parent to ignore or display. */
  onStatus?: (message: string) => void
}

/** A request waiting for the user's decision. */
interface PendingRequestEntry {
  id: number
  topic: string
  method: string
  /** Raw, unvalidated params — decoded on demand, never trusted. */
  params: unknown
  /** CAIP-2 chain from the request envelope, when present. */
  chainId: string | null
  /** What the verify registry concluded about the requester. */
  origin: OriginCheck | null
  receivedAt: number
}

/** A connection proposal waiting for the user's decision. */
interface PendingProposalEntry {
  id: number
  view: SessionProposalView
  receivedAt: number
}

/** Gas/nonce data fetched from an RPC to complete a transaction request. */
interface GasEnrichment {
  state: "loading" | "ready" | "failed"
  /** Human note about the current state or why it failed. */
  note: string
  /** True when the transaction could not be simulated on its chain. */
  simulationFailed: boolean
  fill: TransactionFillOptions
}

const EMPTY_ENRICHMENT: GasEnrichment = {
  state: "loading",
  note: "",
  simulationFailed: false,
  fill: {},
}

/** Human labels for the three supported methods. */
const METHOD_LABEL: Record<string, string> = {
  personal_sign: "Sign a message",
  "eth_signTypedData_v4": "Sign typed data",
  eth_sendTransaction: "Approve a transaction",
}

/** Icon per supported method, for the pending list. */
const METHOD_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  personal_sign: MessageSquareText,
  "eth_signTypedData_v4": FileText,
  eth_sendTransaction: Send,
}

/**
 * Answer a request, come what may.
 *
 * If building or sending the real response fails for any reason, an
 * internal-error response is sent instead: a dApp left waiting on a promise
 * shows its user an endless spinner and calls it a wallet bug.
 */
async function respondToRequest(
  kit: IWalletKit,
  topic: string,
  id: number,
  build: () => Promise<WcJsonRpcResponse>
): Promise<void> {
  try {
    const response = await build()
    await kit.respondSessionRequest({ topic, response })
  } catch (error) {
    logger.error("WalletConnect request response failed", { error, requestId: id })
    try {
      await kit.respondSessionRequest({ topic, response: jsonRpcError(id, WC_ERROR.INTERNAL) })
    } catch (fatal) {
      // The relay itself is unreachable; the SDK will let the request expire.
      logger.error("WalletConnect fallback response also failed", { error: fatal, requestId: id })
    }
  }
}

/** Monospace, scrollable block for message and payload previews. */
const PREVIEW_CLASS =
  "max-h-56 overflow-y-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"

/** A label/value row used inside the request dialog. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground sm:pt-0.5">
        {label}
      </p>
      <div className="min-w-0 text-sm text-foreground">{children}</div>
    </div>
  )
}

/** Chain badges shared by the proposal dialog and session rows. */
function ChainBadges({ chains }: { chains: ChainView[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {chains.map((chain) => (
        <Badge key={chain.caip2} tone={chain.known ? "neutral" : "warning"}>
          {chain.name}
          {!chain.known && " · not supported"}
        </Badge>
      ))}
    </div>
  )
}

/** The verify-registry verdict, phrased for a dialog. */
function OriginLine({ origin }: { origin: OriginCheck | null }) {
  if (origin === null || origin.origin === "" || origin.validation === "UNKNOWN") {
    return (
      <p className="text-xs text-warning">
        Origin not verified by WalletConnect — confirm the dApp is the one you expect before
        approving.
      </p>
    )
  }
  if (origin.isScam) {
    return (
      <Alert tone="danger" title="Flagged origin">
        WalletConnect’s scam registry flags {origin.origin}. Do not approve.
      </Alert>
    )
  }
  return (
    <p className="text-xs text-success">
      Origin verified by WalletConnect: <span className="font-mono">{origin.origin}</span>
    </p>
  )
}

export default function WalletConnectPanel({ account, onStatus }: WalletConnectPanelProps) {
  const { isOnline } = useOnlineStatus()

  const kitRef = useRef<IWalletKit | null>(null)
  const [ready, setReady] = useState(false)
  const [initError, setInitError] = useState("")
  const [attempt, setAttempt] = useState(0)

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [proposals, setProposals] = useState<PendingProposalEntry[]>([])
  const [requests, setRequests] = useState<PendingRequestEntry[]>([])

  const [pairingInput, setPairingInput] = useState("")
  const [pairError, setPairError] = useState("")
  const [pairBusy, setPairBusy] = useState(false)

  const [openProposalId, setOpenProposalId] = useState<number | null>(null)
  const [openRequestId, setOpenRequestId] = useState<number | null>(null)
  const [busyProposalId, setBusyProposalId] = useState<number | null>(null)
  const [busyRequestId, setBusyRequestId] = useState<number | null>(null)
  const [disconnectingTopic, setDisconnectingTopic] = useState<string | null>(null)
  const [enrichment, setEnrichment] = useState<GasEnrichment | null>(null)

  // The parent may re-render with a new callback identity at any time; holding
  // it in a ref keeps the SDK event subscriptions mounted exactly once.
  const onStatusRef = useRef(onStatus)
  useEffect(() => {
    onStatusRef.current = onStatus
  }, [onStatus])

  const status = useCallback((message: string): void => {
    onStatusRef.current?.(message)
  }, [])

  const refreshSessions = useCallback((): void => {
    const kit = kitRef.current
    if (kit === null) return
    try {
      setSessions(Object.values(kit.getActiveSessions()).map(describeActiveSession))
    } catch (error) {
      logger.warn("Could not read active WalletConnect sessions", { error })
    }
  }, [])

  // ----- lifecycle: initialize once, subscribe, adopt retained work -----

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | null = null

    /**
     * Run one incoming (or retained) request through the intake rules.
     *
     * Unsupported methods never reach the user — they are answered immediately
     * with a reason, because a dApp left waiting shows its user an endless
     * spinner and calls it a wallet bug.
     */
    const intakeRequest = (
      kit: IWalletKit,
      request: { id: number; topic: string; params?: unknown; verifyContext?: unknown }
    ): void => {
      const envelope = (request.params ?? {}) as {
        request?: { method?: unknown; params?: unknown }
        chainId?: unknown
      }
      const method = envelope.request?.method
      if (typeof method !== "string" || method === "") {
        void respondToRequest(kit, request.topic, request.id, async () =>
          jsonRpcError(request.id, WC_ERROR.INTERNAL)
        )
        return
      }
      if (!SUPPORTED_METHODS.includes(method)) {
        logger.warn("Rejected an unsupported WalletConnect method", { method })
        status(`Rejected an unsupported ${method} request from a dApp`)
        void respondToRequest(kit, request.topic, request.id, async () =>
          jsonRpcError(request.id, {
            code: WC_ERROR.UNSUPPORTED_METHODS.code,
            message: `EthTools does not support ${method}. Supported methods: personal_sign, eth_signTypedData_v4, eth_sendTransaction.`,
          })
        )
        return
      }
      const entry: PendingRequestEntry = {
        id: request.id,
        topic: request.topic,
        method,
        params: envelope.request?.params,
        chainId: typeof envelope.chainId === "string" ? envelope.chainId : null,
        origin: describeVerifiedOrigin(request.verifyContext),
        receivedAt: Date.now(),
      }
      setRequests((prev) => [...prev.filter((existing) => existing.id !== entry.id), entry])
      setOpenRequestId(entry.id)
      status(`A dApp sent a ${method} request`)
    }

    const adoptRetained = (kit: IWalletKit): void => {
      // Anything the SDK retained while this panel was closed — the vault can
      // auto-lock between a pairing and its proposal, or lock mid-request —
      // is surfaced now. This is the remount story: nothing is lost as long
      // as the tab lives; after that, requests expire on their own.
      try {
        const retained = Object.values(kit.getPendingSessionProposals()).map((proposal) => ({
          id: proposal.id,
          view: describeSessionProposal(proposal),
          receivedAt: Date.now(),
        }))
        if (retained.length > 0) {
          setProposals((prev) => {
            const seen = new Set(prev.map((entry) => entry.id))
            return [...prev, ...retained.filter((entry) => !seen.has(entry.id))]
          })
          setOpenProposalId((current) => current ?? retained[0].id)
        }
      } catch (error) {
        logger.warn("Could not adopt retained WalletConnect proposals", { error })
      }
      try {
        for (const request of kit.getPendingSessionRequests()) {
          intakeRequest(kit, request)
        }
      } catch (error) {
        logger.warn("Could not adopt retained WalletConnect requests", { error })
      }
    }

    void (async () => {
      try {
        const kit = await getWalletKit()
        if (disposed) return
        kitRef.current = kit
        refreshSessions()
        adoptRetained(kit)
        unsubscribe = subscribeWalletKitEvents(kit, {
          onSessionProposal: (event: WcSessionProposalEvent) => {
            const view = describeSessionProposal(event)
            setProposals((prev) => [
              ...prev.filter((existing) => existing.id !== event.id),
              { id: event.id, view, receivedAt: Date.now() },
            ])
            setOpenProposalId(event.id)
            status(`${view.dappName} wants to connect`)
          },
          onSessionRequest: (event: WcSessionRequestEvent) => intakeRequest(kit, event),
          onSessionDelete: (_event: WcSessionDeleteEvent) => refreshSessions(),
          onProposalExpire: ({ id }) =>
            setProposals((prev) => prev.filter((entry) => entry.id !== id)),
          onSessionRequestExpire: ({ id }) =>
            setRequests((prev) => prev.filter((entry) => entry.id !== id)),
        })
        setReady(true)
        setInitError("")
        status("WalletConnect ready")
      } catch (error) {
        if (disposed) return
        const message = describeError(error, "WalletConnect could not start.")
        setInitError(message)
        logger.error("WalletKit initialization failed", { error })
        status(`WalletConnect failed to start: ${message}`)
      }
    })()

    return () => {
      // Subscriptions are removed but the kit itself stays alive: it is a
      // shared singleton, and tearing it down would drop the relay socket for
      // a panel that remounts seconds later.
      disposed = true
      unsubscribe?.()
    }
  }, [attempt, refreshSessions, status])

  // ----- pairing -----

  const handlePair = useCallback(async (): Promise<void> => {
    const parsed = parsePairingUri(pairingInput)
    if (!parsed.ok) {
      setPairError(parsed.error)
      return
    }
    const kit = kitRef.current
    if (kit === null) return
    if (!isOnline) {
      setPairError("You are offline. Reconnect before pairing with a dApp.")
      return
    }
    setPairBusy(true)
    setPairError("")
    try {
      await kit.pair({ uri: parsed.value })
      setPairingInput("")
      status("Pairing started — approve the connection when the dApp asks")
    } catch (error) {
      setPairError(
        describeError(error, "Pairing failed. Generate a fresh code in the dApp and try again.")
      )
      logger.warn("WalletConnect pairing failed", { error })
    } finally {
      setPairBusy(false)
    }
  }, [isOnline, pairingInput, status])

  // ----- proposal decisions -----

  const decideProposal = useCallback(
    async (entry: PendingProposalEntry, approve: boolean): Promise<void> => {
      const kit = kitRef.current
      if (kit === null) return
      setBusyProposalId(entry.id)
      try {
        if (approve) {
          const namespaces = buildApprovalNamespaces(entry.view, account.address)
          if (!namespaces.ok) {
            // Should not happen (Approve is disabled), but never approve blind:
            // fall through to a rejection carrying the same reason.
            await kit.rejectSession({
              id: entry.id,
              reason: {
                code: WC_ERROR.UNSUPPORTED_CHAINS.code,
                message: namespaces.error,
              },
            })
          } else {
            await kit.approveSession({ id: entry.id, namespaces: namespaces.value })
            refreshSessions()
            notify.success(`Connected to ${entry.view.dappName}`)
            status(`Connected to ${entry.view.dappName}`)
          }
        } else {
          await kit.rejectSession({ id: entry.id, reason: WC_ERROR.USER_REJECTED })
          status("Connection declined")
        }
      } catch (error) {
        logger.error("WalletConnect proposal decision failed", { error, approve })
        notify.error(
          approve ? "Connection failed" : "Could not decline",
          describeError(error, "The dApp may have already closed the request.")
        )
        // Either way the proposal is spent: retrying a failed settlement or a
        // vanished pairing can only produce the same error.
        refreshSessions()
      } finally {
        setProposals((prev) => prev.filter((existing) => existing.id !== entry.id))
        setOpenProposalId((current) => (current === entry.id ? null : current))
        setBusyProposalId(null)
      }
    },
    [account.address, refreshSessions, status]
  )

  // ----- request decisions -----

  const decideRequest = useCallback(
    async (entry: PendingRequestEntry, approve: boolean, fill: TransactionFillOptions): Promise<void> => {
      const kit = kitRef.current
      if (kit === null) return
      const decoded = normalizeSignParams(entry.method, entry.params, {
        chainId: entry.chainId,
        accountAddress: account.address,
      })
      if (approve && !decoded.ok) return
      setBusyRequestId(entry.id)
      try {
        await respondToRequest(kit, entry.topic, entry.id, async () => {
          if (!approve || !decoded.ok) {
            return jsonRpcError(entry.id, WC_ERROR.USER_REJECTED)
          }
          // Signing is local; only the finished signature leaves the browser.
          const signed = await signWalletConnectRequest(decoded.value, account.privateKey, fill)
          if (!signed.ok) {
            return jsonRpcError(entry.id, {
              code: -32000,
              message: `Signing failed: ${signed.error}`,
            })
          }
          return jsonRpcSuccess(entry.id, signed.value)
        })
        if (approve) {
          notify.success("Signed", "The result was sent back to the dApp.")
          status(`${entry.method} answered`)
        } else {
          status("Request declined")
        }
      } finally {
        setRequests((prev) => prev.filter((existing) => existing.id !== entry.id))
        setOpenRequestId((current) => (current === entry.id ? null : current))
        setBusyRequestId(null)
      }
    },
    [account.address, account.privateKey, status]
  )

  const disconnect = useCallback(
    async (summary: SessionSummary): Promise<void> => {
      const kit = kitRef.current
      if (kit === null || summary.topic === "") return
      setDisconnectingTopic(summary.topic)
      try {
        await kit.disconnectSession({ topic: summary.topic, reason: WC_ERROR.USER_DISCONNECTED })
        setSessions((prev) => prev.filter((existing) => existing.topic !== summary.topic))
        status(`Disconnected from ${summary.dappName}`)
      } catch (error) {
        logger.error("WalletConnect disconnect failed", { error })
        notify.error("Could not disconnect", describeError(error, "Try again in a moment."))
        refreshSessions()
      } finally {
        setDisconnectingTopic(null)
      }
    },
    [refreshSessions, status]
  )

  // ----- derived dialog state -----

  const activeProposal = useMemo(
    () => proposals.find((entry) => entry.id === openProposalId) ?? null,
    [proposals, openProposalId]
  )
  const activeRequest = useMemo(
    () => requests.find((entry) => entry.id === openRequestId) ?? null,
    [requests, openRequestId]
  )
  const activeDecoded = useMemo(() => {
    if (activeRequest === null) return null
    return normalizeSignParams(activeRequest.method, activeRequest.params, {
      chainId: activeRequest.chainId,
      accountAddress: account.address,
    })
  }, [activeRequest, account.address])
  const requestingSession = useMemo(
    () => sessions.find((summary) => summary.topic === activeRequest?.topic) ?? null,
    [sessions, activeRequest]
  )

  // ----- gas enrichment for the open transaction request -----

  useEffect(() => {
    const request = activeRequest
    const decoded = activeDecoded
    if (
      request === null ||
      decoded === null ||
      !decoded.ok ||
      decoded.value.kind !== "transaction" ||
      !decoded.value.knownChain ||
      decoded.value.networkKey === null
    ) {
      setEnrichment(null)
      return
    }
    const view = decoded.value
    // Captured before any call below: property narrowing through the union
    // does not survive across function calls, but a local const does.
    const networkKey = view.networkKey
    if (networkKey === null) return
    const address = account.address
    const controller = new AbortController()
    setEnrichment({ ...EMPTY_ENRICHMENT, note: "Fetching gas, fees and the next nonce…" })

    void (async () => {
      try {
        // All reads are idempotent, so the pooled provider may retry them
        // across endpoints. The simulation is separated from the rest because
        // its failure means something different: the transaction itself is
        // expected to fail, not merely the network.
        const info = await withProvider(
          networkKey,
          async (provider) => {
            const [nonce, feeData, gasEstimate] = await Promise.all([
              provider.getTransactionCount(address, "pending").catch(() => null),
              provider.getFeeData().catch(() => null),
              provider
                .estimateGas({
                  from: address,
                  to: view.tx.to,
                  value: view.tx.valueWei,
                  data: view.tx.data,
                })
                .catch((error: unknown) => {
                  logger.warn("WalletConnect gas simulation failed", { error })
                  return describeError(
                    error,
                    "The transaction could not be simulated on this network."
                  )
                }),
            ])
            return { nonce, feeData, gasEstimate }
          },
          controller.signal
        )
        if (controller.signal.aborted) return

        if (typeof info.gasEstimate !== "bigint") {
          setEnrichment({
            state: "failed",
            // In this branch gasEstimate carries the simulation error string.
            note: info.gasEstimate,
            simulationFailed: true,
            fill: {},
          })
          return
        }

        const fill: TransactionFillOptions = {}
        if (view.tx.nonce === undefined && info.nonce !== null) {
          // ethers returns the count as a JS number; the fill speaks bigint.
          fill.nonce = BigInt(info.nonce)
        }
        if (view.tx.gasLimit === undefined) fill.gasLimit = info.gasEstimate
        if (view.tx.gasPrice === undefined && view.tx.maxFeePerGas === undefined) {
          if (info.feeData?.maxFeePerGas !== null && info.feeData?.maxFeePerGas !== undefined) {
            fill.maxFeePerGas = info.feeData.maxFeePerGas
            if (info.feeData.maxPriorityFeePerGas !== null && info.feeData.maxPriorityFeePerGas !== undefined) {
              fill.maxPriorityFeePerGas = info.feeData.maxPriorityFeePerGas
            }
          } else if (info.feeData?.gasPrice !== null && info.feeData?.gasPrice !== undefined) {
            fill.gasPrice = info.feeData.gasPrice
          }
        }
        setEnrichment({ state: "ready", note: "", simulationFailed: false, fill })
      } catch (error) {
        if (controller.signal.aborted) return
        logger.warn("WalletConnect gas enrichment failed", { error })
        setEnrichment({
          state: "failed",
          note: describeError(error, "Gas, fees and the next nonce could not be fetched."),
          simulationFailed: false,
          fill: {},
        })
      }
    })()

    return () => controller.abort()
  }, [activeRequest, activeDecoded, account.address])

  // ----- what the request dialog can currently do -----

  const txView = activeDecoded !== null && activeDecoded.ok && activeDecoded.value.kind === "transaction"
    ? activeDecoded.value
    : null
  const txBlockers = txView !== null ? transactionSigningBlockers(txView, enrichment?.fill) : []
  const simulationBlocked = txView !== null && enrichment?.simulationFailed === true
  const approveRequestDisabled =
    activeDecoded === null ||
    !activeDecoded.ok ||
    (txView !== null && (txBlockers.length > 0 || simulationBlocked))

  /**
   * Text for the live region, mirroring what sighted users see. The region is
   * always mounted and only its text changes, so screen readers announce the
   * transitions.
   */
  const liveStatus = (() => {
    if (initError !== "") return `WalletConnect failed to start. ${initError}`
    if (!ready) return "Connecting to the WalletConnect relay."
    const parts = [`${sessions.length} connected ${sessions.length === 1 ? "dApp" : "dApps"}`]
    if (proposals.length > 0) parts.push(`${proposals.length} pending connection ${proposals.length === 1 ? "request" : "requests"}`)
    if (requests.length > 0) parts.push(`${requests.length} pending signing ${requests.length === 1 ? "request" : "requests"}`)
    return parts.join(", ") + "."
  })()

  return (
    <Card variant="inset" padding="sm">
      <p role="status" aria-live="polite" className="sr-only">
        {liveStatus}
      </p>

      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h3" className="text-base">
              dApp connections
            </CardTitle>
            {ready && (
              <Badge tone={isOnline ? "success" : "warning"} dot pulse={isOnline}>
                {isOnline ? "Relay ready" : "Offline"}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            WalletConnect · signing as{" "}
            <span className="font-mono">{truncateHex(account.address, 10, 8)}</span>
          </p>
        </div>
        {ready && (
          <Button
            variant="ghost"
            size="icon"
            onClick={refreshSessions}
            icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
            title="Refresh sessions"
            aria-label="Refresh sessions"
            className="shrink-0"
          />
        )}
      </div>

      <Alert tone="warning" title="A connected dApp can ask you to sign — it never holds your keys">
        Connecting grants a dApp the power to request signatures and transactions, each of which
        you approve or decline here. Your key stays in this browser and is used only to sign what
        you explicitly approve.
      </Alert>

      {initError !== "" ? (
        <div className="mt-4">
          <ErrorState
            title="WalletConnect could not start."
            description={initError}
            action={
              <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </Button>
            }
          />
        </div>
      ) : !ready ? (
        <div className="mt-4">
          <SkeletonGroup label="Connecting to the WalletConnect relay">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="mt-3 h-4 w-2/3" />
            <Skeleton className="mt-1 h-4 w-1/2" />
          </SkeletonGroup>
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          {/* --- Pair --- */}
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              void handlePair()
            }}
          >
            <Field
              label="Pairing code from a dApp"
              error={pairError}
              hint='In the dApp choose “Connect wallet” → WalletConnect and copy the code it shows (the QR code’s text, starting with wc:).'
            >
              {(field) => (
                <div className="flex gap-2">
                  <input
                    {...field}
                    {...secretInputProps}
                    value={pairingInput}
                    onChange={(event) => {
                      setPairingInput(event.target.value)
                      if (pairError !== "") setPairError("")
                    }}
                    placeholder="wc:…"
                    spellCheck={false}
                    aria-label="WalletConnect pairing code"
                    className={monoInputClassName}
                  />
                  <Button
                    type="submit"
                    isLoading={pairBusy}
                    loadingLabel="Pairing…"
                    disabled={pairBusy || pairingInput.trim() === "" || !isOnline}
                    icon={<Link2 className="h-4 w-4" aria-hidden="true" />}
                    className="shrink-0"
                  >
                    Connect
                  </Button>
                </div>
              )}
            </Field>
            {!isOnline && (
              <p className="text-xs text-warning">
                You are offline. Pairing needs a connection to the WalletConnect relay.
              </p>
            )}
          </form>

          {/* --- Active sessions --- */}
          <section aria-labelledby="wc-sessions-heading" className="space-y-2">
            <h4 id="wc-sessions-heading" className="text-sm font-medium text-foreground">
              Connected dApps
            </h4>
            {sessions.length === 0 ? (
              <EmptyState
                title="No connected dApps yet"
                description="Pair with a dApp above to answer its signature and transaction requests here."
                icon={<Link2 className="h-6 w-6" aria-hidden="true" />}
              />
            ) : (
              <ul className="space-y-2">
                {sessions.map((summary) => (
                  <li
                    key={summary.topic}
                    className="rounded-lg border border-border/60 bg-background/40 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {summary.dappName}
                        </p>
                        {summary.dappUrl !== "" && (
                          <p className="break-all text-xs text-muted-foreground">
                            {summary.dappUrlHref !== null ? (
                              <a
                                href={summary.dappUrlHref}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                className="underline decoration-dotted underline-offset-2"
                              >
                                {summary.dappUrl}
                              </a>
                            ) : (
                              <>
                                {summary.dappUrl}{" "}
                                <span className="text-warning">(not a secure https link)</span>
                              </>
                            )}
                          </p>
                        )}
                        <ChainBadges chains={summary.chains} />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void disconnect(summary)}
                        isLoading={disconnectingTopic === summary.topic}
                        icon={<Unplug className="h-4 w-4" aria-hidden="true" />}
                        className="shrink-0"
                      >
                        Disconnect
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* --- Pending approvals --- */}
          {(proposals.length > 0 || requests.length > 0) && (
            <section aria-labelledby="wc-pending-heading" className="space-y-2">
              <h4 id="wc-pending-heading" className="text-sm font-medium text-foreground">
                Pending approvals
              </h4>
              <p className="text-xs text-muted-foreground">
                Requests wait here while this panel is open and expire on their own after five
                minutes. Nothing is signed until you approve it.
              </p>
              <ul className="space-y-2">
                {proposals.map((entry) => (
                  <li
                    key={`proposal-${entry.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 p-3"
                  >
                    <p className="min-w-0 truncate text-sm text-foreground">
                      {entry.view.dappName} wants to connect
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setOpenProposalId(entry.id)}
                      className="shrink-0"
                    >
                      Review
                    </Button>
                  </li>
                ))}
                {requests.map((entry) => {
                  const Icon = METHOD_ICON[entry.method]
                  return (
                    <li
                      key={`request-${entry.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 p-3"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {Icon !== undefined && (
                          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        )}
                        <p className="min-w-0 truncate text-sm text-foreground">
                          {METHOD_LABEL[entry.method] ?? entry.method} ·{" "}
                          {sessions.find((summary) => summary.topic === entry.topic)?.dappName ??
                            "a dApp"}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setOpenRequestId(entry.id)}
                        className="shrink-0"
                      >
                        Review
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </div>
      )}

      {/* --- Proposal dialog --- */}
      <ResponsiveDialog
        isOpen={activeProposal !== null}
        onClose={() => setOpenProposalId(null)}
        title={activeProposal !== null ? `Connect ${activeProposal.view.dappName}?` : "Connect dApp"}
        description="The dApp asks for the chains and methods below."
        size="lg"
        footer={
          activeProposal !== null && (
            <>
              <Button
                variant="secondary"
                onClick={() => void decideProposal(activeProposal, false)}
                isLoading={busyProposalId === activeProposal.id}
                disabled={busyProposalId === activeProposal.id}
              >
                Reject
              </Button>
              <Button
                onClick={() => void decideProposal(activeProposal, true)}
                isLoading={busyProposalId === activeProposal.id}
                loadingLabel="Approving…"
                disabled={
                  !activeProposal.view.approvable || busyProposalId === activeProposal.id
                }
              >
                Approve
              </Button>
            </>
          )
        }
      >
        {activeProposal !== null && (
          <ProposalDialogBody view={activeProposal.view} accountAddress={account.address} />
        )}
      </ResponsiveDialog>

      {/* --- Request dialog --- */}
      <ResponsiveDialog
        isOpen={activeRequest !== null}
        onClose={() => setOpenRequestId(null)}
        title={
          activeRequest !== null ? (METHOD_LABEL[activeRequest.method] ?? activeRequest.method) : "Request"
        }
        description={
          requestingSession !== null
            ? `From ${requestingSession.dappName}`
            : "From a connected dApp"
        }
        size="lg"
        footer={
          activeRequest !== null && (
            <>
              <Button
                variant="secondary"
                onClick={() => void decideRequest(activeRequest, false, enrichment?.fill ?? {})}
                isLoading={busyRequestId === activeRequest.id}
                disabled={busyRequestId === activeRequest.id}
              >
                Reject
              </Button>
              <Button
                onClick={() =>
                  void decideRequest(activeRequest, true, enrichment?.fill ?? {})
                }
                isLoading={busyRequestId === activeRequest.id}
                loadingLabel="Signing…"
                disabled={approveRequestDisabled || busyRequestId === activeRequest.id}
              >
                Approve &amp; sign
              </Button>
            </>
          )
        }
      >
        {activeRequest !== null && (
          <RequestDialogBody
            entry={activeRequest}
            decoded={activeDecoded}
            dapp={requestingSession}
            enrichment={enrichment}
            txBlockers={txBlockers}
          />
        )}
      </ResponsiveDialog>
    </Card>
  )
}

/** The body of the connection-approval dialog. */
function ProposalDialogBody({
  view,
  accountAddress,
}: {
  view: SessionProposalView
  accountAddress: string
}) {
  return (
    <div className="space-y-4">
      <OriginLine origin={view.verifiedOrigin} />

      <DetailRow label="dApp">
        <p className="font-medium">{view.dappName}</p>
        {view.dappUrl !== "" && (
          <p className="break-all text-xs text-muted-foreground">
            {view.dappUrlHref !== null ? (
              <a
                href={view.dappUrlHref}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="underline decoration-dotted underline-offset-2"
              >
                {view.dappUrl}
              </a>
            ) : (
              <>
                {view.dappUrl} <span className="text-warning">(not a secure https link)</span>
              </>
            )}
          </p>
        )}
      </DetailRow>

      <DetailRow label="Chains">
        <div className="space-y-1.5">
          <ChainBadges chains={view.chains} />
          {view.chains.some((chain) => !chain.known) && (
            <p className="text-xs text-muted-foreground">
              Unknown chains are not granted. Only the chains EthTools recognizes are approved.
            </p>
          )}
        </div>
      </DetailRow>

      <DetailRow label="Methods">
        <div className="flex flex-wrap gap-1.5">
          {view.methods.map((method) => (
            <Badge
              key={method}
              tone={SUPPORTED_METHODS.includes(method) ? "success" : "danger"}
            >
              {method}
            </Badge>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Only personal_sign, eth_signTypedData_v4 and eth_sendTransaction are ever granted;
          anything else the dApp asks for is refused.
        </p>
      </DetailRow>

      <DetailRow label="Account">
        <p className="font-mono text-xs">{accountAddress}</p>
      </DetailRow>

      {view.blockReason !== null && (
        <Alert tone="danger" title="This request cannot be approved">
          {view.blockReason} Rejecting tells the dApp why it cannot connect.
        </Alert>
      )}
    </div>
  )
}

/** The body of the signing-request dialog. */
function RequestDialogBody({
  entry,
  decoded,
  dapp,
  enrichment,
  txBlockers,
}: {
  entry: PendingRequestEntry
  decoded: { ok: true; value: NormalizedSignRequest } | { ok: false; error: string } | null
  dapp: SessionSummary | null
  enrichment: GasEnrichment | null
  txBlockers: string[]
}): React.ReactNode {
  return (
    <div className="space-y-4">
      <OriginLine origin={entry.origin} />
      {dapp !== null && (
        <DetailRow label="dApp">
          <p className="font-medium">{dapp.dappName}</p>
        </DetailRow>
      )}

      {decoded === null ? (
        <p className="text-sm text-muted-foreground">Decoding the request…</p>
      ) : !decoded.ok ? (
        <Alert tone="danger" title="This request cannot be approved safely">
          {decoded.error} Rejecting sends the reason back to the dApp.
        </Alert>
      ) : decoded.value.kind === "message" ? (
        <MessageBody view={decoded.value} />
      ) : decoded.value.kind === "typed-data" ? (
        <TypedDataBody view={decoded.value} />
      ) : (
        <TransactionBody view={decoded.value} enrichment={enrichment} blockers={txBlockers} />
      )}
    </div>
  )
}

/** personal_sign view. */
function MessageBody({ view }: { view: Extract<NormalizedSignRequest, { kind: "message" }> }) {
  return (
    <div className="space-y-3">
      <DetailRow label="Message">
        <p className="text-xs text-muted-foreground">{view.byteLength} bytes — sign only what you have read</p>
        <pre className={PREVIEW_CLASS}>{view.message}</pre>
      </DetailRow>
      <DetailRow label="Digest">
        <p className="break-all font-mono text-xs text-muted-foreground">{view.digest}</p>
      </DetailRow>
      {view.signerAddress !== null && (
        <DetailRow label="Signer">
          <p className="font-mono text-xs">{view.signerAddress}</p>
        </DetailRow>
      )}
    </div>
  )
}

/** eth_signTypedData_v4 view. */
function TypedDataBody({
  view,
}: {
  view: Extract<NormalizedSignRequest, { kind: "typed-data" }>
}) {
  return (
    <div className="space-y-3">
      <DetailRow label="Payload">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="primary">{view.primaryType}</Badge>
          <Badge tone="neutral">{view.domainSummary}</Badge>
        </div>
      </DetailRow>
      <DetailRow label="Digest">
        <p className="break-all font-mono text-xs text-muted-foreground">{view.digest}</p>
      </DetailRow>
      <DetailRow label="Data">
        <pre className={PREVIEW_CLASS}>{prettyJson(view.typedDataJson)}</pre>
      </DetailRow>
      <p className="text-xs text-muted-foreground">
        Typed data binds this signature to the domain above — a different site cannot replay it as
        its own.
      </p>
    </div>
  )
}

/** eth_sendTransaction view. */
function TransactionBody({
  view,
  enrichment,
  blockers,
}: {
  view: TransactionSignView
  enrichment: GasEnrichment | null
  blockers: string[]
}): React.ReactNode {
  return (
    <div className="space-y-3">
      <DetailRow label="Send to">
        <div className="flex items-center gap-1">
          <p className="break-all font-mono text-xs">{view.tx.to}</p>
          <CopyButton value={view.tx.to} label="recipient address" />
        </div>
      </DetailRow>
      <DetailRow label="Amount">
        <p className="font-medium">{view.valueDisplay}</p>
      </DetailRow>
      <DetailRow label="Chain">
        <Badge tone={view.knownChain ? "neutral" : "warning"}>{view.networkName}</Badge>
        {!view.knownChain && (
          <p className="mt-1 text-xs text-warning">
            EthTools does not know this chain, so it cannot fetch gas for it; the transaction is
            signed only if the dApp supplied everything.
          </p>
        )}
      </DetailRow>
      <DetailRow label="Calldata">
        {view.hasCalldata ? (
          <div className="space-y-1.5">
            <Alert tone="warning" title="This transaction calls a contract">
              It carries {view.tx.dataBytes} bytes of calldata. EthTools cannot decode arbitrary
              calldata here — be sure you know what this call does before signing.
            </Alert>
            <pre className={PREVIEW_CLASS}>{view.tx.data}</pre>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            None — a plain native transfer to the recipient.
          </p>
        )}
      </DetailRow>
      <DetailRow label="Gas">
        {enrichment === null ? (
          <p className="text-xs text-muted-foreground">
            {view.knownChain
              ? "Gas details could not be fetched."
              : "Not fetched — unknown chain."}
          </p>
        ) : enrichment.state === "loading" ? (
          <p className="text-xs text-muted-foreground" role="status">
            {enrichment.note}
          </p>
        ) : (
          <div className="space-y-1 text-xs text-muted-foreground">
            {enrichment.fill.gasLimit !== undefined && (
              <p>
                Gas limit:{" "}
                <span className="font-mono">{enrichment.fill.gasLimit.toString()}</span>
              </p>
            )}
            {enrichment.fill.maxFeePerGas !== undefined && (
              <p>
                Max fee:{" "}
                <span className="font-mono">
                  {formatUnits(enrichment.fill.maxFeePerGas, "gwei")} gwei
                </span>
              </p>
            )}
            {enrichment.fill.gasPrice !== undefined && (
              <p>
                Gas price:{" "}
                <span className="font-mono">
                  {formatUnits(enrichment.fill.gasPrice, "gwei")} gwei
                </span>
              </p>
            )}
            {enrichment.fill.nonce !== undefined && (
              <p>
                Next nonce: <span className="font-mono">{enrichment.fill.nonce.toString()}</span>
              </p>
            )}
            {view.tx.nonce !== undefined && (
              <p>
                Nonce (from the dApp): <span className="font-mono">{view.tx.nonce}</span>
              </p>
            )}
          </div>
        )}
        {enrichment?.state === "failed" && (
          <div className="mt-2">
            <Alert tone="warning" title="Gas details unavailable">
              {enrichment.note}
            </Alert>
          </div>
        )}
      </DetailRow>

      {blockers.length > 0 && (
        <Alert tone="danger" title="This transaction cannot be signed">
          <ul className="list-disc space-y-1 pl-4">
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker.charAt(0).toUpperCase() + blocker.slice(1)}.</li>
            ))}
          </ul>
        </Alert>
      )}

      <Alert tone="info" title="Signed here, sent by the dApp">
        EthTools does not broadcast. Approving returns the signed transaction to the dApp, which
        submits it — the standard expectation for wallet-side WalletConnect flows. Only the
        signature leaves this browser.
      </Alert>
    </div>
  )
}

/** Pretty-print a small JSON payload for preview, tolerating failure. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
