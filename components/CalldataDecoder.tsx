"use client"

/**
 * Transaction calldata decoder.
 *
 * Works without an ABI by matching the 4-byte selector against a local table of
 * common signatures, and decodes arguments fully when the user supplies an ABI.
 *
 * A selector match from the local table is a best guess: selectors are only four
 * bytes, so distinct functions can collide. The UI labels a guessed match as such
 * rather than presenting it as authoritative.
 */

import { useCallback, useState } from "react"
import { FileCode2 } from "lucide-react"
import Field, { monoInputClassName } from "./ui/Field"
import Button from "./ui/Button"
import Card from "./ui/Card"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import CopyButton from "./ui/CopyButton"
import Tabs from "./ui/Tabs"
import {
  decodeCalldata,
  decodeRevertReason,
  type DecodedArgument,
  type DecodedCalldata,
  type RevertReason,
} from "@/lib/calldata"

const MODES = [
  { id: "calldata", label: "Calldata" },
  { id: "revert", label: "Revert data" },
] as const

type Mode = (typeof MODES)[number]["id"]

/** One decoded argument, with its declared Solidity type. */
function ArgumentRow({ argument, index }: { argument: DecodedArgument; index: number }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-2.5">
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-foreground">{argument.name}</span>
        <span className="font-mono text-muted-foreground">{argument.type}</span>
        <span className="ml-auto font-mono text-muted-foreground/70">#{index}</span>
      </p>
      <p className="mt-1 break-all font-mono text-sm text-foreground">{argument.value}</p>
    </div>
  )
}

export default function CalldataDecoder() {
  const [mode, setMode] = useState<Mode>("calldata")
  const [data, setData] = useState("")
  const [abi, setAbi] = useState("")
  const [error, setError] = useState("")
  const [decoded, setDecoded] = useState<DecodedCalldata | null>(null)
  const [revert, setRevert] = useState<RevertReason | null>(null)

  const reset = (): void => {
    setDecoded(null)
    setRevert(null)
    setError("")
  }

  const handleDecode = useCallback(() => {
    reset()

    if (data.trim() === "") {
      setError("Paste some hex data to decode.")
      return
    }

    const abiInput = abi.trim() === "" ? undefined : abi

    if (mode === "calldata") {
      const result = decodeCalldata(data, abiInput)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setDecoded(result.value)
    } else {
      const result = decodeRevertReason(data, abiInput)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setRevert(result.value)
    }
  }, [abi, data, mode])

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        handleDecode()
      }}
      className="space-y-4"
    >
      <Tabs
        items={MODES}
        value={mode}
        onChange={(next) => {
          setMode(next)
          reset()
        }}
        label="Decoder mode"
        layoutGroupId="calldata-mode"
      />

      <Field
        label={mode === "calldata" ? "Calldata" : "Revert data"}
        hint={
          mode === "calldata"
            ? "The transaction input, starting with a 4-byte selector."
            : "The error data returned by a failed call."
        }
      >
        {(props) => (
          <textarea
            {...props}
            value={data}
            onChange={(event) => setData(event.target.value)}
            rows={4}
            placeholder="0xa9059cbb000000000000000000000000…"
            spellCheck={false}
            className={`${monoInputClassName} resize-y text-xs`}
          />
        )}
      </Field>

      <Field
        label="ABI or signatures"
        hint="Optional. JSON ABI, or one signature per line such as transfer(address,uint256). Without this, only known selectors are recognised."
      >
        {(props) => (
          <textarea
            {...props}
            value={abi}
            onChange={(event) => setAbi(event.target.value)}
            rows={3}
            placeholder="transfer(address,uint256)"
            spellCheck={false}
            className={`${monoInputClassName} resize-y text-xs`}
          />
        )}
      </Field>

      <Button
        type="submit"
        fullWidth
        icon={<FileCode2 className="h-4 w-4" aria-hidden="true" />}
      >
        Decode
      </Button>

      {error && <Alert tone="danger">{error}</Alert>}

      {decoded?.kind === "function" && (
        <Card variant="inset" padding="sm" className="space-y-3">
          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Function</p>
              <Badge tone={decoded.source === "abi" ? "success" : "warning"}>
                {decoded.source === "abi" ? "From ABI" : "Best guess"}
              </Badge>
            </div>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="min-w-0 break-all font-mono text-sm font-semibold text-success">
                {decoded.signature}
              </p>
              <CopyButton value={decoded.signature} label="signature" />
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{decoded.selector}</p>
          </div>

          {decoded.source === "known-selectors" && (
            <Alert tone="warning">
              Matched from the built-in selector table, not a supplied ABI. Four-byte selectors
              can collide, so confirm against the contract before relying on this.
            </Alert>
          )}

          {decoded.args.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Arguments · {decoded.args.length}
              </p>
              {decoded.args.map((argument, index) => (
                <ArgumentRow key={`${index}-${argument.name}`} argument={argument} index={index} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">This function takes no arguments.</p>
          )}
        </Card>
      )}

      {decoded?.kind === "raw" && (
        <Card variant="inset" padding="sm" className="space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Selector</p>
            <p className="font-mono text-sm font-semibold text-warning">{decoded.selector}</p>
            {decoded.signature && (
              <p className="mt-1 break-all font-mono text-sm text-foreground">
                {decoded.signature}
              </p>
            )}
          </div>

          <Alert tone="warning">{decoded.note}</Alert>

          {decoded.words.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                Payload · {decoded.words.length} words
              </p>
              <ol className="space-y-1 overflow-x-auto">
                {decoded.words.map((word, index) => (
                  <li key={index} className="flex gap-2 font-mono text-xs">
                    <span className="w-6 shrink-0 select-none text-right text-muted-foreground/60">
                      {index}
                    </span>
                    <span className="break-all text-foreground">{word}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Card>
      )}

      {revert && (
        <Card variant="inset" padding="sm" className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Revert reason</p>

          {revert.kind === "none" && (
            <p className="text-sm text-muted-foreground">
              The call reverted without a reason. That is typical of a bare{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">revert()</code>, a
              transfer to a non-payable function, or running out of gas.
            </p>
          )}

          {revert.kind === "error-string" && (
            <p className="break-words font-mono text-sm text-destructive">{revert.reason}</p>
          )}

          {revert.kind === "panic" && (
            <div>
              <p className="font-mono text-sm text-destructive">{revert.description}</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                Panic {revert.codeHex} · {revert.code.toString()}
              </p>
            </div>
          )}

          {revert.kind === "custom-error" && (
            <div className="space-y-2">
              <p className="break-all font-mono text-sm text-destructive">{revert.signature}</p>
              {revert.args.map((argument, index) => (
                <ArgumentRow key={`${index}-${argument.name}`} argument={argument} index={index} />
              ))}
            </div>
          )}

          {revert.kind === "unknown" && (
            <div>
              <p className="font-mono text-sm text-warning">{revert.selector}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                This selector matched no known error. Supply the contract ABI to decode a custom
                error.
              </p>
            </div>
          )}
        </Card>
      )}
    </form>
  )
}
