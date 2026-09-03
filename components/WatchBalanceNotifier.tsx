"use client"

/**
 * Balance watcher: a quiet background poll for one address on one network.
 *
 * Design constraints, all deliberate:
 * - In-memory only. No persistence: a page reload restarts from a fresh
 *   baseline, because the watcher's job is "tell me about changes from now",
 *   not "reconstruct history".
 * - The FIRST poll establishes the baseline silently. Alerting on the first
 *   read would announce a number the user just looked at, not a change.
 * - Every change between polls is announced twice: as a toast (the signal the
 *   user asked for) and through the live region below (the current balance,
 *   available to assistive tech at all times).
 * - Polling stops completely on stop/unmount/network change: the abort signal
 *   cancels any in-flight read and the interval is cleared, so a network
 *   switch can never deliver a stale balance as a "change" on the new network.
 * - Reads go through the pooled RPC path; one request per minute is the entire
 *   cost while running, and nothing is sent anywhere except a public RPC query
 *   for a public balance.
 */

import { useEffect, useState } from "react"
import { BellRing, BellOff } from "lucide-react"
import Card, { CardHeader, CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Badge from "./ui/Badge"
import Field, { inputClassName } from "./ui/Field"
import Alert from "./ui/Alert"
import { notify } from "./ui/Toast"
import {
  NETWORKS,
  RpcError,
  getBalanceWei,
  getNativeDecimals,
  type Network,
} from "@/lib/ethers"
import { formatBalanceForDisplay } from "@/lib/format"
import { describeError, logger } from "@/lib/logger"
import { isEthAddress } from "@/lib/schema"

/** Poll interval while running. Matches the token manager's refresh cadence. */
const POLL_INTERVAL_MS = 60_000

/**
 * The curated network list, mirroring the portfolio's: the watcher costs one
 * RPC read per minute, so it covers the major mainnets rather than the full
 * table (and testnets are excluded because they change for free).
 */
const WATCH_NETWORKS = [
  "mainnet",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "bsc",
  "avalanche",
] as const

export interface WatchBalanceNotifierProps {
  /** The address to watch. Public information; no secret is ever involved. */
  address: string
  /** Optional label, shown in the header so the watcher is recognizable. */
  label?: string
}

export default function WatchBalanceNotifier({ address, label }: WatchBalanceNotifierProps) {
  const [network, setNetwork] = useState<Network>(WATCH_NETWORKS[0])
  const [running, setRunning] = useState(false)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [lastError, setLastError] = useState("")

  const networkInfo = NETWORKS[network]
  const nativeDecimals = getNativeDecimals(network)
  const currency = networkInfo?.currency ?? "ETH"
  const networkName = networkInfo?.name ?? network

  // The address prop comes from the parent, but a guard here keeps the card
  // honest if it is ever mounted with anything else.
  const addressValid = isEthAddress(address)

  /**
   * The polling loop. One effect owns the whole lifecycle for a
   * (running, network, address) combination: the baseline lives in the closure
   * so a restart (network switch, stop/start) resets it — the first read after
   * any restart is again silent, by design.
   */
  useEffect(() => {
    if (!running || !addressValid) return

    const controller = new AbortController()
    let stale = false
    let baseline: bigint | null = null

    const poll = async (): Promise<void> => {
      try {
        const wei = await getBalanceWei(address, network, controller.signal)
        if (stale) return

        setLastError("")
        setBalance(wei)

        // First read sets the baseline without alerting: it is the current
        // state, not a change. Every later difference is the signal.
        if (baseline !== null && baseline !== wei) {
          notify.info(
            `Balance changed: ${formatBalanceForDisplay(baseline, nativeDecimals)} → ${formatBalanceForDisplay(
              wei,
              nativeDecimals
            )} ${currency} on ${networkName}`,
            label !== undefined ? `${label} (${address})` : address
          )
        }
        baseline = wei
      } catch (cause) {
        // An aborted or superseded read is not a failure the user needs.
        if (stale || controller.signal.aborted) return
        if (cause instanceof RpcError && cause.kind === "aborted") return

        logger.warn("Balance watcher poll failed", { network, error: cause })
        setLastError(
          cause instanceof RpcError
            ? cause.userMessage
            : describeError(cause, "Could not read the balance.")
        )
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS)

    return () => {
      stale = true
      controller.abort()
      clearInterval(timer)
    }
  }, [address, addressValid, currency, nativeDecimals, network, networkName, label, running])

  /** Switching networks discards the old network's balance display. */
  const handleNetworkChange = (next: Network): void => {
    setNetwork(next)
    setBalance(null)
    setLastError("")
  }

  if (!addressValid) {
    return (
      <Card variant="inset" padding="sm" as="section" aria-label="Balance watcher">
        <CardHeader className="mb-3">
          <CardTitle as="h3" className="text-base">
            Balance watcher
          </CardTitle>
        </CardHeader>
        <Alert tone="warning">
          This account has no valid address to watch, so the balance watcher is disabled.
        </Alert>
      </Card>
    )
  }

  return (
    <Card variant="inset" padding="sm" as="section" aria-label="Balance watcher">
      <CardHeader className="mb-3">
        <CardTitle as="h3" className="text-base">
          Balance watcher{label !== undefined ? ` · ${label}` : ""}
        </CardTitle>
        {running ? (
          <Badge tone="success" dot pulse>
            Watching
          </Badge>
        ) : (
          <Badge tone="neutral">Paused</Badge>
        )}
      </CardHeader>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Network" required className="flex-1">
          {(props) => (
            <select
              {...props}
              value={network}
              onChange={(e) => handleNetworkChange(e.target.value)}
              className={inputClassName}
            >
              {WATCH_NETWORKS.map((key) => (
                <option key={key} value={key}>
                  {NETWORKS[key]?.name ?? key}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Button
          variant={running ? "secondary" : "primary"}
          onClick={() => setRunning((current) => !current)}
          className="sm:mb-0.5"
          icon={
            running ? (
              <BellOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <BellRing className="h-4 w-4" aria-hidden="true" />
            )
          }
          aria-pressed={running}
        >
          {running ? "Stop watching" : "Start watching"}
        </Button>
      </div>

      {/*
        Live region: the current balance and any read failure are announced
        politely. A change is additionally surfaced as a toast — the live
        region keeps the steady state, the toast is the event.
      */}
      <div
        role="status"
        aria-live="polite"
        className="mt-3 rounded-md border border-border bg-background/40 p-2.5"
      >
        {lastError !== "" ? (
          <p className="text-sm text-destructive">{lastError}</p>
        ) : balance === null ? (
          <p className="text-sm text-muted-foreground">
            {running
              ? "Reading the current balance…"
              : "Not watching. Start to track changes on this network."}
          </p>
        ) : (
          <p className="font-mono text-sm text-foreground">
            {formatBalanceForDisplay(balance, nativeDecimals)}{" "}
            <span className="text-muted-foreground">{currency}</span>
            <span className="text-muted-foreground"> · {networkName}</span>
          </p>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        While watching, the balance is re-read every minute and each change is announced. The
        baseline resets when the network changes or the page reloads — the first read is never
        reported as a change.
      </p>
    </Card>
  )
}
