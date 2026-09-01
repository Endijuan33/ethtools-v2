"use client"

/**
 * Gas tracker tool card.
 *
 * Shows three fee levels — slow, standard, fast — each as a total fee cap in
 * gwei plus the USD cost of a plain native transfer at that cap. The levels are
 * derived by `lib/gasTracker.ts`, which also states whether they came from an
 * EIP-1559 fee market or the legacy `eth_gasPrice` fallback; the two describe
 * different things, so the card labels which produced the numbers.
 *
 * The network list is a hand-picked mainnet subset rather than the full table:
 * a select with twenty-plus entries buries the chains people actually check gas
 * on, and custom networks are rarely where gas questions arise.
 *
 * One in-flight request at a time: switching networks aborts the previous
 * request, so a slow response can never land results for a network the user has
 * already navigated away from.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Fuel, RefreshCw } from "lucide-react"
import Field, { inputClassName } from "./ui/Field"
import Button from "./ui/Button"
import Card from "./ui/Card"
import Badge, { type BadgeTone } from "./ui/Badge"
import { ErrorState, Spinner } from "./ui/Feedback"
import { getGasOverview, type GasOverview } from "@/lib/gasTracker"
import { NETWORKS, RpcError } from "@/lib/ethers"
import { describeError, logger } from "@/lib/logger"
import { formatFiat, toFiatValue } from "@/lib/format"
import { formatUnit } from "@/lib/units"

/** Wei in one gwei. */
const GWEI = 1_000_000_000n

/** Gas units consumed by a plain native-token transfer. */
const TRANSFER_GAS = 21_000n

/** Networks offered. Curated mainnets; see the module note. */
const GAS_NETWORK_KEYS = [
  "mainnet",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "bsc",
  "avalanche",
] as const

type GasNetworkKey = (typeof GAS_NETWORK_KEYS)[number]

const KNOWN_GAS_NETWORKS: ReadonlySet<string> = new Set(GAS_NETWORK_KEYS)

/**
 * Select options, filtered through the built-in table so a future rename of a
 * key degrades to a shorter list instead of rendering `undefined.name`.
 */
const GAS_NETWORK_OPTIONS = GAS_NETWORK_KEYS.filter(
  (key): key is GasNetworkKey => key in NETWORKS
).map((key) => ({ key, name: NETWORKS[key].name }))

/** Presentation metadata per tier. Tones deliberately differ so the three rows
 *  are distinguishable without reading the numbers. */
const LEVELS = [
  { key: "slow", label: "Slow", tone: "info" },
  { key: "standard", label: "Standard", tone: "success" },
  { key: "fast", label: "Fast", tone: "warning" },
] as const satisfies readonly { key: keyof GasOverview; label: string; tone: BadgeTone }[]

/**
 * Render a wei fee cap in gwei.
 *
 * Precision adapts to magnitude: L2 base fees routinely sit far below 1 gwei,
 * where a fixed two fraction digits would collapse to "0.00" and read as "no
 * data". Truncation (via `formatUnit`) never shows more than the true fee.
 */
function formatGwei(wei: bigint): string {
  const maxFractionDigits = wei >= GWEI ? 2 : 6
  return formatUnit(wei, "gwei", { maxFractionDigits })
}

/** One tier row: badge, gwei fee cap, and the USD cost of a transfer at it. */
function LevelRow({
  label,
  tone,
  gwei,
  costLabel,
}: {
  label: string
  tone: BadgeTone
  gwei: string
  costLabel: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 p-3">
      <Badge tone={tone} dot>
        {label}
      </Badge>
      <div className="min-w-0 text-right">
        <p className="font-mono text-sm font-semibold text-foreground">
          {gwei} <span className="font-sans font-normal text-muted-foreground">gwei</span>
        </p>
        <p className="text-xs text-muted-foreground">{costLabel}</p>
      </div>
    </div>
  )
}

export default function GasTrackerCard() {
  const [network, setNetwork] = useState<GasNetworkKey>("mainnet")
  const [overview, setOverview] = useState<GasOverview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // One controller per in-flight check, superseded by the next one.
  const abortRef = useRef<AbortController | null>(null)

  // Abandon any in-flight request when the card unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  const checkGas = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setBusy(true)
    setError("")
    try {
      const result = await getGasOverview(network, controller.signal)
      // The pool cannot cancel an already-sent HTTP request, so an aborted
      // call can still resolve; never let it land stale results.
      if (controller.signal.aborted) return
      setOverview(result)
    } catch (caught) {
      // A superseded request is not an error: the network switch already
      // reset the visible state.
      if (controller.signal.aborted) return
      setOverview(null)
      logger.warn("Gas overview failed", { network, error: caught })
      setError(
        caught instanceof RpcError
          ? caught.userMessage
          : describeError(caught, "Could not read gas data. Check your connection and try again.")
      )
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [network])

  const selectNetwork = (next: string): void => {
    if (next === network || !KNOWN_GAS_NETWORKS.has(next)) return
    // Results and errors belong to the previously selected network.
    abortRef.current?.abort()
    abortRef.current = null
    setNetwork(next as GasNetworkKey)
    setOverview(null)
    setError("")
    setBusy(false)
  }

  const selectedName =
    GAS_NETWORK_OPTIONS.find((option) => option.key === network)?.name ?? network

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void checkGas()
      }}
      className="space-y-4"
    >
      {/* Persistent announcement region: a live region that first appears
          alongside its content is ignored by several screen readers, so the
          region is always mounted and only its text changes. */}
      <p role="status" aria-live="polite" className="sr-only">
        {overview
          ? `Gas on ${overview.networkName}: slow ${formatGwei(overview.slow)}, standard ${formatGwei(overview.standard)}, fast ${formatGwei(overview.fast)} gwei.`
          : ""}
      </p>

      <Field label="Network" hint="Major mainnets. Testnets are not priced in USD.">
        {(props) => (
          <select
            {...props}
            value={network}
            onChange={(event) => selectNetwork(event.target.value)}
            className={inputClassName}
          >
            {GAS_NETWORK_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Button
        type="submit"
        isLoading={busy}
        loadingLabel="Checking gas…"
        fullWidth
        icon={<Fuel className="h-4 w-4" aria-hidden="true" />}
      >
        Check gas
      </Button>

      {/* Skeleton-free busy state only when there is nothing to keep on
          screen; a refresh keeps the previous levels visible, like the wallet
          keeps balance rows during a re-fetch. */}
      {busy && !overview && <Spinner label={`Fetching gas levels on ${selectedName}…`} />}

      {error && !busy && (
        <ErrorState
          title="Could not read gas data."
          description={error}
          action={
            <Button variant="secondary" onClick={() => void checkGas()}>
              Try again
            </Button>
          }
        />
      )}

      {overview && (
        <Card variant="inset" padding="sm" className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1.5">
              <Badge tone={overview.isEip1559 ? "primary" : "neutral"} dot>
                {overview.isEip1559 ? "EIP-1559" : "Legacy"}
              </Badge>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {overview.isEip1559
                  ? "Base fee plus priority fee, from recent blocks."
                  : "Node-suggested gas price with slow/fast margins."}
              </p>
              <p className="text-xs text-muted-foreground">
                {overview.nativePriceUsd !== null
                  ? `1 ${overview.currency} ≈ ${formatFiat(overview.nativePriceUsd)}`
                  : `${overview.currency} price unavailable`}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0"
              onClick={() => void checkGas()}
              disabled={busy}
              title="Refresh gas levels"
              aria-label="Refresh gas levels"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          <div className="space-y-2">
            {LEVELS.map(({ key, label, tone }) => {
              const wei = overview[key]
              const cost = toFiatValue(
                wei * TRANSFER_GAS,
                overview.nativeDecimals,
                overview.nativePriceUsd
              )
              return (
                <LevelRow
                  key={key}
                  label={label}
                  tone={tone}
                  gwei={formatGwei(wei)}
                  costLabel={
                    cost === null ? "USD price unavailable" : `≈ ${formatFiat(cost)} per transfer`
                  }
                />
              )
            })}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Cost of a plain {overview.currency} transfer (21,000 gas) at each level. Fee levels
            are estimates, not guarantees.
          </p>
        </Card>
      )}
    </form>
  )
}
