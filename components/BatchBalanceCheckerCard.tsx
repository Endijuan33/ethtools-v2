"use client"

/**
 * Batch balance checker tool card.
 *
 * Pastes of many addresses are checked across a curated set of seven mainnets,
 * one row per address. The network list is the same hand-picked subset as the
 * gas tracker for the same reason: a select with twenty-plus entries buries the
 * chains people actually check balances on.
 *
 * Addresses are processed strictly one at a time. 25 addresses × 7 networks is
 * up to 175 RPC requests; running them as one burst would hammer the shared
 * public endpoints, while a visible "3 of 10" progress line keeps the wait
 * honest and abortable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Scale } from "lucide-react"
import Field, { monoInputClassName } from "./ui/Field"
import Button from "./ui/Button"
import Card from "./ui/Card"
import Badge from "./ui/Badge"
import { EmptyState, ErrorState, Spinner } from "./ui/Feedback"
import {
  getAddressBalances,
  parseAddressList,
  sumBalancesBySymbol,
  MAX_BATCH_ADDRESSES,
  type NetworkBalanceResult,
  type ParsedAddressList,
} from "@/lib/batchBalances"
import { NETWORKS } from "@/lib/ethers"
import { formatBalanceForDisplay, truncateHex } from "@/lib/format"
import { logger } from "@/lib/logger"

/** Networks checked, mirroring the gas tracker's curated mainnet subset. */
const BATCH_NETWORK_KEYS = [
  "mainnet",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "bsc",
  "avalanche",
] as const

/**
 * Column headers, short enough for a seven-column table, filtered through the
 * built-in table so a future key rename degrades to a shorter list instead of
 * rendering `undefined`.
 */
const NETWORK_COLUMNS = BATCH_NETWORK_KEYS.filter(
  (key): key is (typeof BATCH_NETWORK_KEYS)[number] => key in NETWORKS
).map((key) => ({
  key,
  short: {
    mainnet: "Mainnet",
    base: "Base",
    optimism: "OP",
    arbitrum: "Arbitrum",
    polygon: "Polygon",
    bsc: "BSC",
    avalanche: "Avalanche",
  }[key],
  name: NETWORKS[key].name,
}))

/** How many invalid lines to list before collapsing the rest. */
const MAX_SHOWN_INVALID_LINES = 8

/** One row of results: an address and its per-network balances. */
interface AddressRow {
  address: string
  networks: NetworkBalanceResult[]
}

export default function BatchBalanceCheckerCard() {
  const [text, setText] = useState("")
  const [rows, setRows] = useState<AddressRow[] | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState("")

  // One controller per in-flight check, superseded by the next one.
  const abortRef = useRef<AbortController | null>(null)

  // Abandon any in-flight check when the card unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Live parse feedback: pure, so it can be derived on every keystroke.
  const parsed: ParsedAddressList | null = useMemo(
    () => (text.trim() === "" ? null : parseAddressList(text)),
    [text]
  )

  const canCheck =
    parsed !== null && parsed.error === undefined && parsed.addresses.length > 0

  const checkBalances = useCallback(async (list: ParsedAddressList) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setRows(null)
    setError("")
    setProgress({ done: 0, total: list.addresses.length })

    try {
      const collected: AddressRow[] = []
      for (const [index, address] of list.addresses.entries()) {
        if (controller.signal.aborted) return
        const networks = await getAddressBalances(address, BATCH_NETWORK_KEYS, controller.signal)
        if (controller.signal.aborted) return
        collected.push({ address, networks })
        // Incremental results: a long batch shows rows as they arrive rather
        // than after a blank wait.
        setRows([...collected])
        setProgress({ done: index + 1, total: list.addresses.length })
      }
    } catch (caught) {
      if (controller.signal.aborted) return
      setRows(null)
      logger.warn("Batch balance check failed", { error: caught })
      setError(
        caught instanceof Error && caught.message === "Invalid address."
          ? "One of the addresses is not valid. Re-check the list and try again."
          : "Could not read balances. Check your connection and try again."
      )
    } finally {
      if (!controller.signal.aborted) setProgress(null)
    }
  }, [])

  const busy = progress !== null

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (parsed !== null && canCheck) void checkBalances(parsed)
      }}
      className="space-y-4"
    >
      {/* Persistent announcement region: a live region that first appears
          alongside its content is ignored by several screen readers. */}
      <p role="status" aria-live="polite" className="sr-only">
        {progress
          ? `Checked ${progress.done} of ${progress.total} addresses.`
          : rows && rows.length > 0
            ? `Balances loaded for ${rows.length} ${rows.length === 1 ? "address" : "addresses"}.`
            : ""}
      </p>

      <Field
        label="Addresses"
        hint={`One address per line, at most ${MAX_BATCH_ADDRESSES}. Duplicates are ignored.`}
      >
        {(props) => (
          <textarea
            {...props}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={5}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={`${monoInputClassName} resize-y`}
            placeholder={"0x8ba1f109551bD432803012645Ac136ddd64DBA72\n0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}
          />
        )}
      </Field>

      {/* Live parse feedback, rendered only when there is something to say. */}
      {parsed !== null && (parsed.error !== undefined || parsed.invalidLines.length > 0) && (
        <div className="space-y-2 rounded-lg border border-warning/35 bg-warning/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
            {parsed.error !== undefined
              ? "Too many addresses"
              : `${parsed.invalidLines.length} ${parsed.invalidLines.length === 1 ? "line needs" : "lines need"} fixing`}
          </p>
          <ul className="list-inside list-disc space-y-0.5 text-xs leading-relaxed text-muted-foreground">
            {parsed.invalidLines.slice(0, MAX_SHOWN_INVALID_LINES).map((invalid) => (
              <li key={invalid.line}>
                Line {invalid.line}: {invalid.reason}
              </li>
            ))}
            {parsed.invalidLines.length > MAX_SHOWN_INVALID_LINES && (
              <li>
                …and {parsed.invalidLines.length - MAX_SHOWN_INVALID_LINES} more. Every rejected
                line is listed with its line number.
              </li>
            )}
            {parsed.error !== undefined && <li>{parsed.error}</li>}
          </ul>
        </div>
      )}

      {parsed !== null && parsed.error === undefined && parsed.addresses.length > 0 && (
        <div className="flex items-center gap-2">
          <Badge tone="success" dot>
            {parsed.addresses.length} valid {parsed.addresses.length === 1 ? "address" : "addresses"}
          </Badge>
          {parsed.invalidLines.length === 0 && (
            <span className="text-xs text-muted-foreground">Ready to check</span>
          )}
        </div>
      )}

      <Button
        type="submit"
        isLoading={busy}
        loadingLabel="Checking…"
        fullWidth
        disabled={!canCheck}
        icon={<Scale className="h-4 w-4" aria-hidden="true" />}
      >
        Check balances
      </Button>

      {progress && (!rows || rows.length === 0) && (
        <Spinner
          label={`Checking ${progress.total} ${progress.total === 1 ? "address" : "addresses"} across ${NETWORK_COLUMNS.length} networks…`}
        />
      )}

      {error && !busy && (
        <ErrorState
          title="Could not read balances."
          description={error}
          action={
            canCheck && parsed !== null ? (
              <Button variant="secondary" onClick={() => void checkBalances(parsed)}>
                Try again
              </Button>
            ) : undefined
          }
        />
      )}

      {rows === null && !busy && !error && (
        <EmptyState
          icon={<Scale className="h-6 w-6" aria-hidden="true" />}
          title="No results yet"
          description={`Paste up to ${MAX_BATCH_ADDRESSES} addresses above and press Check balances. Each is looked up on ${NETWORK_COLUMNS.length} mainnets, one at a time.`}
        />
      )}

      {rows !== null && rows.length > 0 && (
        <Card variant="inset" padding="sm" className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Native balances per address and network, with per-currency totals
              </caption>
              <thead>
                <tr className="border-b border-border text-left">
                  <th scope="col" className="whitespace-nowrap px-2 py-2 pr-4 font-medium text-muted-foreground">
                    Address
                  </th>
                  {NETWORK_COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      title={column.name}
                      className="whitespace-nowrap px-2 py-2 text-right font-medium text-muted-foreground"
                    >
                      {column.short}
                    </th>
                  ))}
                  <th scope="col" className="whitespace-nowrap px-2 py-2 pl-4 text-right font-medium text-muted-foreground">
                    Totals
                  </th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((row) => (
                  <BalanceRow key={row.address} row={row} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Totals sum only networks sharing the same currency, so ETH, BNB and others are never
            added together. Failed lookups are marked, not counted as zero.
          </p>
        </Card>
      )}
    </form>
  )
}

/** One table row: address, per-network balances, and per-currency totals. */
function BalanceRow({ row }: { row: AddressRow }) {
  const totals = sumBalancesBySymbol(row.networks)
  const failedCount = row.networks.filter((network) => network.value === null).length

  return (
    <tr className="border-b border-border/50 last:border-b-0">
      <td className="max-w-[10rem] truncate px-2 py-2.5 pr-4 font-mono text-foreground" title={row.address}>
        {truncateHex(row.address, 8, 6)}
      </td>
      {NETWORK_COLUMNS.map((column) => {
        const result = row.networks.find((network) => network.network === column.key)
        return (
          <td key={column.key} className="whitespace-nowrap px-2 py-2.5 text-right font-mono">
            {result === undefined || result.value === null ? (
              <span
                className="text-xs text-muted-foreground"
                title={result?.error ?? "Not checked"}
              >
                failed
                <span className="sr-only">{`: ${result?.error ?? "not checked"}`}</span>
              </span>
            ) : (
              <span className={result.value === 0n ? "text-muted-foreground" : "text-foreground"}>
                {formatBalanceForDisplay(result.value, result.decimals)}
              </span>
            )}
          </td>
        )
      })}
      <td className="whitespace-nowrap px-2 py-2.5 pl-4 text-right font-mono">
        {totals.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {failedCount > 0 ? "no data" : "0"}
          </span>
        ) : (
          totals.map((total) => (
            <span key={`${total.symbol}:${total.decimals}`} className="block text-foreground">
              {formatBalanceForDisplay(total.total, total.decimals)}{" "}
              <span className="font-sans text-xs text-muted-foreground">{total.symbol}</span>
            </span>
          ))
        )}
      </td>
    </tr>
  )
}
