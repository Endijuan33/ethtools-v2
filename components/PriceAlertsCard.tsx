"use client"

/**
 * Price and gas alerts.
 *
 * One-shot alerts on native-asset USD prices and mainnet gas, evaluated by
 * polling. Two honest limits are stated in the UI rather than hidden:
 *
 * - **Alerts live only as long as this page does.** They are held in component
 *   state — not storage — because they are ephemeral: a one-shot alert that
 *   re-armed on every reload could fire the moment the page opens, from a
 *   crossing that happened while it was closed and that the user never chose to
 *   be told about retroactively. No background/service-worker delivery exists.
 * - **Three alerts at a time.** Each price alert costs a poll (cheap: the spot
 *   feed is cached) but each firing costs a user's attention, which is the
 *   scarcer resource. The cap is shown, not silently enforced.
 *
 * All firing rules live in `lib/priceAlerts` as pure functions; this component
 * only owns the two timers (60s prices, 120s gas), tears them down on unmount,
 * and never lets a superseded poll land state.
 */

import { useEffect, useState } from "react"
import { formatUnits } from "ethers"
import { Bell, BellRing, Plus, Trash2 } from "lucide-react"
import Card, { CardDescription, CardHeader, CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Field, { inputClassName } from "./ui/Field"
import Badge from "./ui/Badge"
import { EmptyState } from "./ui/Feedback"
import { notify } from "./ui/Toast"
import { NETWORKS } from "@/lib/ethers"
import { getCoinId } from "@/lib/priceFeed"
import { fetchSpotPrice } from "@/lib/priceHistory"
import { getGasOverview } from "@/lib/gasTracker"
import {
  evaluateGasAlert,
  evaluatePriceAlert,
  nextAlertId,
  validateGasThresholdGwei,
  validatePriceThresholdUsd,
  type GasAlert,
  type GasAlertKind,
  type PriceAlert,
  type PriceAlertKind,
  type WalletAlert,
} from "@/lib/priceAlerts"
import { formatFiat } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * Maximum simultaneously armed alerts.
 *
 * A cap, not a storage bound: see the module doc for why attention, not
 * requests, is the scarce resource here.
 */
const MAX_ACTIVE_ALERTS = 3

/** Price poll cadence. `fetchSpotPrice` caches for ~60s, so this is one real request per minute per asset. */
const PRICE_POLL_MS = 60_000

/** Gas poll cadence. Gas moves slowly compared with price, and each poll is a live RPC round trip. */
const GAS_POLL_MS = 120_000

/**
 * Networks whose native asset can be alerted on.
 *
 * Keep in sync with `CHART_NETWORK_KEYS` in `components/PriceChartCard.tsx`
 * (not exported — it is module-local there): both lists are the same curated
 * major-asset set, and users should be able to alert on exactly what they can
 * chart. CoinGecko ids are resolved through `lib/priceFeed` here too, so an
 * ETH-native L2 is priced as `ethereum`, never as its governance token.
 */
const ALERT_NETWORK_KEYS = [
  "mainnet",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "bsc",
  "avalanche",
] as const

/** One alertable asset, mirroring PriceChartCard's derived `CHART_ASSETS`. */
interface AlertAsset {
  /** Network key; the select value. */
  key: string
  /** CoinGecko id from `lib/priceFeed`. */
  coinId: string
  /** Currency symbol, e.g. `ETH`. */
  symbol: string
}

/**
 * Alertable assets, derived from the network table so a future table edit flows
 * through without a second hand-copied list of ids. Networks that share a coin
 * id (every ETH L2) collapse into one option — the alert prices the asset.
 */
const ALERT_ASSETS: readonly AlertAsset[] = (() => {
  const seen = new Set<string>()
  const assets: AlertAsset[] = []
  for (const key of ALERT_NETWORK_KEYS) {
    const network = NETWORKS[key]
    if (network === undefined) continue
    const coinId = getCoinId(network.currency, network.type === "testnet")
    if (coinId === null || seen.has(coinId)) continue
    seen.add(coinId)
    assets.push({ key, coinId, symbol: network.currency })
  }
  return assets
})()

/** Select options for the alert kind. */
const KIND_OPTIONS: ReadonlyArray<{ value: PriceAlertKind | GasAlertKind; label: string }> = [
  { value: "price-above", label: "Price above" },
  { value: "price-below", label: "Price below" },
  { value: "gas-below", label: "Gas below (mainnet)" },
]

/**
 * Announce a fired alert.
 *
 * A toast always carries the crossing; the browser Notification is additive and
 * only when permission was granted — a denied or unavailable Notification API
 * degrades to the toast alone, which is why permission is requested (once,
 * non-blocking) at alert creation, never at fire time.
 */
function announceAlert(message: string): void {
  notify.success("Alert triggered", message)
  if (typeof window !== "undefined" && "Notification" in window) {
    if (Notification.permission === "granted") {
      try {
        new Notification("EthTools alert", { body: message })
      } catch {
        // Some embedders throw on construction; the toast already carries it.
      }
    }
  }
}

/**
 * Ask for notification permission, non-blocking, exactly once per browser state.
 *
 * Called when the user creates their first alert — the moment they have shown
 * intent — rather than on page load, which browsers treat as nagging.
 */
function requestNotificationPermission(): void {
  if (typeof window === "undefined" || !("Notification" in window)) return
  if (Notification.permission !== "default") return
  // Deliberately not awaited: the answer arrives whenever the user gives it,
  // and alert creation must not wait on a permission dialog.
  void Notification.requestPermission().catch(() => undefined)
}

/** Whether an alert is a price alert. */
function isPriceAlert(alert: WalletAlert): alert is PriceAlert {
  return alert.kind === "price-above" || alert.kind === "price-below"
}

/** Whether an alert is a gas alert. */
function isGasAlert(alert: WalletAlert): alert is GasAlert {
  return alert.kind === "gas-below"
}

/** The sentence naming an alert in the list and the live region. */
function describeAlert(alert: WalletAlert): string {
  if (isGasAlert(alert)) {
    return `Mainnet gas below ${alert.thresholdGwei} gwei`
  }
  const direction = alert.kind === "price-above" ? "above" : "below"
  return `${alert.assetSymbol} ${direction} ${formatFiat(alert.thresholdUsd)}`
}

/** The sentence stating a fired crossing, used for the toast and notification. */
function describeFiring(alert: WalletAlert, reading: number): string {
  if (isGasAlert(alert)) {
    return `Mainnet gas dropped below ${alert.thresholdGwei} gwei — now ${reading.toFixed(2)} gwei.`
  }
  const verb = alert.kind === "price-above" ? "crossed above" : "dropped below"
  return `${alert.assetSymbol} ${verb} ${formatFiat(alert.thresholdUsd)} — now ${formatFiat(reading)}.`
}

export default function PriceAlertsCard() {
  const [alerts, setAlerts] = useState<WalletAlert[]>([])
  /** coinId → latest spot price, or null when the last fetch failed. */
  const [prices, setPrices] = useState<Record<string, number | null>>({})
  /** Latest standard-tier gas price in gwei, or null when the last read failed. */
  const [gasGwei, setGasGwei] = useState<number | null>(null)

  // Form state.
  const [kind, setKind] = useState<PriceAlertKind | GasAlertKind>("price-above")
  const [assetKey, setAssetKey] = useState(() => ALERT_ASSETS[0]?.key ?? "")
  const [threshold, setThreshold] = useState("")
  const [formError, setFormError] = useState("")

  const isGasKind = kind === "gas-below"
  const asset = ALERT_ASSETS.find((entry) => entry.key === assetKey) ?? ALERT_ASSETS[0]
  const atCap = alerts.length >= MAX_ACTIVE_ALERTS

  /**
   * Price polling.
   *
   * The effect re-runs whenever the alert list changes, so the timer is always
   * polling exactly the assets the current alerts need — and a fired (removed)
   * alert stops costing requests on the very next tick. A cancelled flag keeps
   * a superseded poll from setting state after the alert that caused it is gone.
   */
  useEffect(() => {
    const priceAlerts = alerts.filter(isPriceAlert)
    const coinIds = [...new Set(priceAlerts.map((alert) => alert.assetCoinId))]
    if (coinIds.length === 0) return

    let cancelled = false
    const poll = async (): Promise<void> => {
      // fetchSpotPrice's own short cache makes simultaneous polls of the same
      // asset free, so each distinct coin id is fetched directly.
      const settled = await Promise.all(
        coinIds.map(async (coinId): Promise<[string, number | null]> => {
          const result = await fetchSpotPrice(coinId)
          return [coinId, result.ok ? result.value : null]
        })
      )
      if (cancelled) return

      const latest: Record<string, number | null> = {}
      for (const [coinId, price] of settled) latest[coinId] = price
      setPrices((previous) => ({ ...previous, ...latest }))

      const fired: { alert: PriceAlert; reading: number }[] = []
      for (const alert of priceAlerts) {
        const price = latest[alert.assetCoinId] ?? null
        if (price !== null && evaluatePriceAlert(alert, price).fired) {
          fired.push({ alert, reading: price })
        }
      }
      if (fired.length > 0) {
        // One-shot: a fired alert removes itself so it can never re-fire.
        const firedIds = new Set(fired.map((entry) => entry.alert.id))
        setAlerts((previous) => previous.filter((alert) => !firedIds.has(alert.id)))
        for (const { alert, reading } of fired) {
          announceAlert(describeFiring(alert, reading))
        }
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), PRICE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [alerts])

  /**
   * Gas polling, on the standard tier.
   *
   * Each poll is a live RPC round trip (with failover), so the cadence is half
   * the price poll's and the effect only runs at all while a gas alert exists.
   * A failed read keeps the last known value on screen; the next poll retries.
   */
  useEffect(() => {
    const gasAlerts = alerts.filter(isGasAlert)
    if (gasAlerts.length === 0) return

    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const overview = await getGasOverview("mainnet")
        if (cancelled) return
        const gwei = Number(formatUnits(overview.standard, "gwei"))
        if (!Number.isFinite(gwei) || gwei < 0) return
        setGasGwei(gwei)

        const fired = gasAlerts.filter((alert) => evaluateGasAlert(alert, gwei).fired)
        if (fired.length > 0) {
          const firedIds = new Set(fired.map((alert) => alert.id))
          setAlerts((previous) => previous.filter((alert) => !firedIds.has(alert.id)))
          for (const alert of fired) {
            announceAlert(describeFiring(alert, gwei))
          }
        }
      } catch {
        // The RPC pool threw (offline, all endpoints failed). Nothing is
        // announced and nothing is removed — an unreadable value must not
        // count as a crossing any more than it counts as calm.
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), GAS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [alerts])

  /** Add an alert from the form. Validation is the lib's; the form only renders it. */
  const handleAdd = (): void => {
    setFormError("")
    if (atCap) return

    if (isGasKind) {
      const validated = validateGasThresholdGwei(threshold)
      if (!validated.ok) {
        setFormError(validated.error)
        return
      }
      const alert: GasAlert = {
        id: nextAlertId(),
        kind: "gas-below",
        thresholdGwei: validated.value,
      }
      setAlerts((previous) => [...previous, alert])
    } else {
      if (asset === undefined) return
      const validated = validatePriceThresholdUsd(threshold)
      if (!validated.ok) {
        setFormError(validated.error)
        return
      }
      const alert: PriceAlert = {
        id: nextAlertId(),
        kind,
        assetSymbol: asset.symbol,
        assetCoinId: asset.coinId,
        thresholdUsd: validated.value,
      }
      setAlerts((previous) => [...previous, alert])
    }

    setThreshold("")
    requestNotificationPermission()
  }

  const removeAlert = (id: string): void => {
    setAlerts((previous) => previous.filter((alert) => alert.id !== id))
  }

  /**
   * The live region text, mirroring the visible list.
   *
   * Mounted before any alert exists so the region is present when its first
   * text arrives — a region that first appears alongside its content is
   * ignored by several screen readers.
   */
  const liveSummary =
    alerts.length === 0
      ? "No active alerts."
      : `${alerts.length} active alert${alerts.length !== 1 ? "s" : ""}: ${alerts
          .map(describeAlert)
          .join("; ")}.`

  /** The "now" line for one row, or a muted placeholder when no reading exists. */
  const currentReading = (alert: WalletAlert): { text: string; unavailable: boolean } => {
    if (isGasAlert(alert)) {
      return gasGwei === null
        ? { text: "gas price unavailable", unavailable: true }
        : { text: `${gasGwei.toFixed(2)} gwei`, unavailable: false }
    }
    const price = prices[alert.assetCoinId]
    if (price === null) return { text: "price unavailable", unavailable: true }
    if (price === undefined) return { text: "checking…", unavailable: true }
    return { text: formatFiat(price), unavailable: false }
  }

  return (
    <Card as="section" aria-label="Price and gas alerts" className="w-full">
      <CardHeader className="items-center">
        <div>
          <CardTitle as="h3">Price &amp; Gas Alerts</CardTitle>
          <CardDescription>
            One-shot alerts, checked while this page is open and removed once triggered.
          </CardDescription>
        </div>
        {alerts.length > 0 && (
          <Badge tone="primary">
            <Bell className="h-3 w-3" aria-hidden="true" />
            {alerts.length}/{MAX_ACTIVE_ALERTS}
          </Badge>
        )}
      </CardHeader>

      <div className="space-y-4">
        <p role="status" aria-live="polite" className="sr-only">
          {liveSummary}
        </p>

        {/* Create form */}
        <div className="space-y-3 rounded-xl border border-border/60 bg-background/40 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Alert type" required>
              {(props) => (
                <select
                  {...props}
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value as PriceAlertKind | GasAlertKind)
                    setFormError("")
                  }}
                  className={inputClassName}
                >
                  {KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            {!isGasKind && (
              <Field
                label="Asset"
                required
                hint="Major native assets. Networks that share an asset, like the ETH L2s, are alerted once."
              >
                {(props) => (
                  <select
                    {...props}
                    value={assetKey}
                    onChange={(event) => setAssetKey(event.target.value)}
                    className={inputClassName}
                  >
                    {ALERT_ASSETS.map((entry) => (
                      <option key={entry.key} value={entry.key}>
                        {entry.symbol}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
          </div>

          <Field
            label={isGasKind ? "Threshold (gwei)" : "Threshold (USD)"}
            required
            hint={
              isGasKind
                ? "Fires when mainnet's standard gas tier is at or below this level."
                : "Fires when the price touches this level — exactly, or past it."
            }
            error={formError || undefined}
          >
            {(props) => (
              <input
                {...props}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={threshold}
                onChange={(event) => {
                  setThreshold(event.target.value)
                  setFormError("")
                }}
                placeholder={isGasKind ? "e.g., 10" : "e.g., 3000"}
                className={inputClassName}
              />
            )}
          </Field>

          <Button
            onClick={handleAdd}
            disabled={atCap}
            fullWidth
            icon={<Plus size={18} aria-hidden="true" />}
          >
            Add alert
          </Button>

          {atCap && (
            <p className="text-xs text-muted-foreground">
              Up to {MAX_ACTIVE_ALERTS} alerts at a time — remove one to add another. Alerts are
              one-shot: each is removed as soon as it triggers.
            </p>
          )}
        </div>

        {/* Active alerts */}
        {alerts.length === 0 ? (
          <EmptyState
            title="No alerts armed"
            description="Add one above. It is checked here while the page is open, and a notification or toast fires the moment the level is crossed."
            icon={<BellRing size={20} aria-hidden="true" />}
          />
        ) : (
          <ul className="space-y-2">
            {alerts.map((alert) => {
              const current = currentReading(alert)
              return (
                <li
                  key={alert.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3 transition-colors hover:bg-muted/60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {describeAlert(alert)}
                    </p>
                    <p
                      className={cn("mt-0.5 font-mono text-xs tabular-nums", {
                        "text-muted-foreground": !current.unavailable,
                        "text-muted-foreground/60": current.unavailable,
                      })}
                    >
                      Now: {current.text}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 hover:text-destructive"
                    onClick={() => removeAlert(alert.id)}
                    title="Remove alert"
                    aria-label={`Remove alert: ${describeAlert(alert)}`}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        <p className="text-xs text-muted-foreground">
          Prices are checked every minute and gas every two, while this page is open. Closing the
          page disarms them — they are not delivered in the background.
        </p>
      </div>
    </Card>
  )
}
