"use client"

/**
 * Ethereum unit converter.
 *
 * All arithmetic goes through `lib/units.ts`, which is bigint-exact. Nothing here
 * touches `Number`, so 1 wei survives a round trip through ether and back.
 */

import { useMemo, useState } from "react"
import { ArrowLeftRight } from "lucide-react"
import Field, { inputClassName, monoInputClassName } from "./ui/Field"
import Card from "./ui/Card"
import Alert from "./ui/Alert"
import CopyButton from "./ui/CopyButton"
import { convertUnits, isUnitName, UNIT_NAMES, UNIT_PRESETS, type UnitName } from "@/lib/units"

/** One labelled, copyable output row. */
function ResultRow({
  label,
  value,
  copyLabel,
  emphasis = false,
}: {
  label: string
  value: string
  copyLabel: string
  emphasis?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={
            emphasis
              ? "break-all font-mono text-lg font-semibold text-success"
              : "break-all font-mono text-sm text-foreground"
          }
        >
          {value}
        </p>
      </div>
      <CopyButton value={value} label={copyLabel} />
    </div>
  )
}

export default function UnitConverter() {
  const [amount, setAmount] = useState("1")
  const [from, setFrom] = useState<UnitName>("ether")
  const [to, setTo] = useState<UnitName>("wei")

  const conversion = useMemo(() => {
    if (amount.trim() === "") return null
    return convertUnits(amount, from, to)
  }, [amount, from, to])

  return (
    <div className="space-y-4">
      <Field
        label="Amount"
        error={conversion && !conversion.ok ? conversion.error : undefined}
      >
        {(props) => (
          <input
            {...props}
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="1.5"
            className={monoInputClassName}
          />
        )}
      </Field>

      <div className="flex items-end gap-2">
        <Field label="From" className="flex-1">
          {(props) => (
            <select
              {...props}
              value={from}
              onChange={(event) => {
                if (isUnitName(event.target.value)) setFrom(event.target.value)
              }}
              className={inputClassName}
            >
              {UNIT_NAMES.map((unit) => (
                <option key={unit} value={unit}>
                  {unit} · 10^{UNIT_PRESETS[unit].decimals}
                </option>
              ))}
            </select>
          )}
        </Field>

        <button
          type="button"
          onClick={() => {
            setFrom(to)
            setTo(from)
          }}
          aria-label="Swap source and target units"
          className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
        </button>

        <Field label="To" className="flex-1">
          {(props) => (
            <select
              {...props}
              value={to}
              onChange={(event) => {
                if (isUnitName(event.target.value)) setTo(event.target.value)
              }}
              className={inputClassName}
            >
              {UNIT_NAMES.map((unit) => (
                <option key={unit} value={unit}>
                  {unit} · 10^{UNIT_PRESETS[unit].decimals}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {conversion?.ok && (
        <Card variant="inset" padding="sm" className="space-y-3">
          <ResultRow label={`Result · ${to}`} value={conversion.value.value} copyLabel="result" emphasis />

          {conversion.value.exact !== conversion.value.value && (
            <ResultRow label="Exact" value={conversion.value.exact} copyLabel="exact value" />
          )}

          <ResultRow label="Wei" value={conversion.value.wei.toString()} copyLabel="wei value" />

          {conversion.value.truncated && (
            <Alert tone="warning">
              Digits were dropped to fit the display precision. The exact value is shown above.
            </Alert>
          )}
        </Card>
      )}
    </div>
  )
}
