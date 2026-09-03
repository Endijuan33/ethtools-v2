"use client"

/**
 * Contract playground tool card.
 *
 * A read-only inspector: the ABI is parsed with `lib/contractReader.ts`, which
 * keeps only `view` and `pure` functions callable, so this tool can never
 * submit a transaction no matter what ABI is pasted into it. State-changing
 * functions are still listed as unsupported so a pasted ABI is never silently
 * half-loaded.
 *
 * One in-flight call at a time: a new call aborts the previous request, and a
 * call in progress never lands results for an address or network the user has
 * already edited away from.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FileCode, Play } from "lucide-react"
import Field, { monoInputClassName } from "./ui/Field"
import Button from "./ui/Button"
import Card from "./ui/Card"
import Badge from "./ui/Badge"
import { EmptyState, ErrorState, Spinner } from "./ui/Feedback"
import {
  callViewFunction,
  parseAbiFunctions,
  type CallOutput,
  type ParsedAbi,
  type ReadFunction,
} from "@/lib/contractReader"
import { NETWORKS } from "@/lib/ethers"
import { formatRelativeTime } from "@/lib/format"
import { logger } from "@/lib/logger"

/** Networks offered, mirroring the gas tracker's curated mainnet subset. */
const PLAYGROUND_NETWORK_KEYS = [
  "mainnet",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "bsc",
  "avalanche",
] as const

type PlaygroundNetworkKey = (typeof PLAYGROUND_NETWORK_KEYS)[number]

const KNOWN_PLAYGROUND_NETWORKS: ReadonlySet<string> = new Set(PLAYGROUND_NETWORK_KEYS)

/** Select options, filtered through the built-in table like the gas tracker's. */
const NETWORK_OPTIONS = PLAYGROUND_NETWORK_KEYS.filter(
  (key): key is PlaygroundNetworkKey => key in NETWORKS
).map((key) => ({ key, name: NETWORKS[key].name }))

/** How many recent calls the in-memory history keeps. */
const HISTORY_LIMIT = 5

/** One remembered call, in component state only — never persisted. */
interface HistoryEntry {
  id: number
  at: number
  network: string
  contractAddress: string
  signature: string
  ok: boolean
  /** First output's value on success, or the error message on failure. */
  summary: string
}

export default function ContractPlaygroundCard() {
  const [network, setNetwork] = useState<PlaygroundNetworkKey>("mainnet")
  const [contractAddress, setContractAddress] = useState("")
  const [abiText, setAbiText] = useState("")
  const [selectedSignature, setSelectedSignature] = useState("")
  const [inputs, setInputs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [outputs, setOutputs] = useState<CallOutput[] | null>(null)
  const [error, setError] = useState("")
  const [history, setHistory] = useState<HistoryEntry[]>([])

  // One controller per in-flight call, superseded by the next one.
  const abortRef = useRef<AbortController | null>(null)

  // Abandon any in-flight call when the card unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Live ABI parse: pure, so it is derived on every keystroke. Empty text is
  // "no ABI yet", not an error.
  const parsed: ParsedAbi | null | { error: string } = useMemo(() => {
    if (abiText.trim() === "") return null
    const result = parseAbiFunctions(abiText)
    return result.ok ? result.value : { error: result.error }
  }, [abiText])

  const abiError = parsed !== null && "error" in parsed ? parsed.error : ""
  // Memoized so downstream useMemo deps stay stable across renders.
  const readFunctions = useMemo(
    () => (parsed !== null && !("error" in parsed) ? parsed.functions : []),
    [parsed]
  )
  const unsupported = useMemo(
    () => (parsed !== null && !("error" in parsed) ? parsed.unsupported : []),
    [parsed]
  )

  // Keep the selection valid as the ABI changes, and reset the input fields
  // whenever the function does — values typed for one signature are nonsense
  // for another.
  const selected: ReadFunction | null = useMemo(
    () => readFunctions.find((fn) => fn.signature === selectedSignature) ?? null,
    [readFunctions, selectedSignature]
  )

  const selectFunction = (signature: string): void => {
    setSelectedSignature(signature)
    setInputs([])
    setOutputs(null)
    setError("")
  }

  const setInput = (index: number, value: string): void => {
    setInputs((current) => {
      const next = [...current]
      next[index] = value
      return next
    })
  }

  /** Remember a completed call, newest first, capped at {@link HISTORY_LIMIT}. */
  const remember = useCallback(
    (fn: ReadFunction, ok: boolean, summary: string) => {
      const at = Date.now()
      setHistory((current) =>
        [
          {
            id: at,
            at,
            network,
            contractAddress: contractAddress.trim(),
            signature: fn.signature,
            ok,
            summary,
          },
          ...current,
        ].slice(0, HISTORY_LIMIT)
      )
    },
    [contractAddress, network]
  )

  // The most recent call, so a retry re-runs what actually failed rather than
  // whatever the form holds after later edits.
  const lastCallRef = useRef<{ fn: ReadFunction; args: readonly string[] } | null>(null)

  const call = useCallback(
    async (fn: ReadFunction, args: readonly string[]) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      lastCallRef.current = { fn, args }

      setBusy(true)
      setError("")
      try {
        const outcome = await callViewFunction(
          network,
          contractAddress,
          fn,
          args,
          controller.signal
        )
        if (controller.signal.aborted) return
        if (outcome.ok) {
          setOutputs(outcome.value)
          remember(fn, true, outcome.value[0]?.value ?? "(no outputs)")
        } else {
          setOutputs(null)
          setError(outcome.error)
          remember(fn, false, outcome.error)
        }
      } catch (caught) {
        if (controller.signal.aborted) return
        setOutputs(null)
        logger.warn("Contract playground call failed", { error: caught })
        const message = "The call could not be made. Check your connection and try again."
        setError(message)
        remember(fn, false, message)
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    },
    [contractAddress, network, remember]
  )

  const selectedName =
    NETWORK_OPTIONS.find((option) => option.key === network)?.name ?? network

  const callSelected = (): void => {
    if (selected !== null) {
      void call(selected, selected.inputs.map((_, index) => inputs[index] ?? ""))
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        callSelected()
      }}
      className="space-y-4"
    >
      {/* Persistent announcement region. */}
      <p role="status" aria-live="polite" className="sr-only">
        {busy
          ? `Calling ${selected ? selected.signature : "the function"} on ${selectedName}…`
          : outputs
            ? `Call returned ${outputs.length} ${outputs.length === 1 ? "output" : "outputs"}.`
            : error
              ? `Call failed: ${error}`
              : ""}
      </p>

      <Field label="Network" hint="Major mainnets, matching the other developer tools.">
        {(props) => (
          <select
            {...props}
            value={network}
            onChange={(event) => {
              if (!KNOWN_PLAYGROUND_NETWORKS.has(event.target.value)) return
              setNetwork(event.target.value as PlaygroundNetworkKey)
              // Results belong to the previously selected network.
              abortRef.current?.abort()
              setOutputs(null)
              setError("")
              setBusy(false)
            }}
            className={monoInputClassName}
          >
            {NETWORK_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Contract address">
        {(props) => (
          <input
            {...props}
            type="text"
            value={contractAddress}
            onChange={(event) => setContractAddress(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="0x…"
            className={monoInputClassName}
          />
        )}
      </Field>

      <Field
        label="ABI"
        hint="Paste the contract's JSON ABI. Only view and pure functions can be called."
      >
        {(props) => (
          <textarea
            {...props}
            value={abiText}
            onChange={(event) => {
              setAbiText(event.target.value)
              // A new ABI invalidates the old selection, inputs and results.
              setSelectedSignature("")
              setInputs([])
              setOutputs(null)
              setError("")
            }}
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={`${monoInputClassName} resize-y font-mono`}
            placeholder='[{"type":"function","name":"symbol","outputs":[{"type":"string"}],"stateMutability":"view"}]'
          />
        )}
      </Field>

      {/* Live ABI feedback. */}
      {abiError !== "" && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-foreground">
          {abiError}
        </p>
      )}
      {abiError === "" && parsed !== null && !("error" in parsed) && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={readFunctions.length > 0 ? "success" : "neutral"} dot>
            {readFunctions.length} readable {readFunctions.length === 1 ? "function" : "functions"}
          </Badge>
          {unsupported.length > 0 && (
            <Badge tone="warning" dot>
              {unsupported.length} not callable
            </Badge>
          )}
        </div>
      )}
      {abiError === "" && parsed !== null && !("error" in parsed) && unsupported.length > 0 && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          State-changing functions are listed but cannot be called here:{" "}
          {unsupported.map((fn) => fn.signature).join(", ")}.
        </p>
      )}

      {readFunctions.length > 0 && (
        <Field label="Function" hint="Only view and pure functions appear here.">
          {(props) => (
            <select
              {...props}
              value={selected?.signature ?? ""}
              onChange={(event) => selectFunction(event.target.value)}
              className={monoInputClassName}
            >
              {!selected && <option value="">Select a function…</option>}
              {readFunctions.map((fn) => (
                <option key={fn.signature} value={fn.signature}>
                  {fn.signature}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {selected && selected.inputs.length > 0 && (
        <div className="space-y-3 rounded-lg border border-border/50 bg-background/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            Arguments for <span className="font-mono">{selected.signature}</span>
          </p>
          {selected.inputs.map((param, index) => (
            <Field
              key={`${param.name}-${index}`}
              label={param.name !== "" ? param.name : `argument #${index}`}
              hint={`Type: ${param.type}. Arrays and tuples take JSON, e.g. [1, 2].`}
            >
              {(props) => (
                <input
                  {...props}
                  type="text"
                  value={inputs[index] ?? ""}
                  onChange={(event) => setInput(index, event.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className={monoInputClassName}
                />
              )}
            </Field>
          ))}
        </div>
      )}

      <Button
        type="submit"
        isLoading={busy}
        loadingLabel="Calling…"
        fullWidth
        disabled={selected === null || contractAddress.trim() === ""}
        icon={<Play className="h-4 w-4" aria-hidden="true" />}
      >
        Call
      </Button>

      {busy && <Spinner label={`Calling ${selected ? selected.signature : "the function"} on ${selectedName}…`} />}

      {error && !busy && (
        <ErrorState
          title="The call failed."
          description={error}
          action={(() => {
            const last = lastCallRef.current
            if (last === null) return undefined
            return (
              <Button variant="secondary" onClick={() => void call(last.fn, last.args)}>
                Try again
              </Button>
            )
          })()}
        />
      )}

      {outputs !== null && !busy && (
        <Card variant="inset" padding="sm" className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Result</p>
          {outputs.length === 0 && (
            <p className="text-sm text-muted-foreground">The function returned no values.</p>
          )}
          {outputs.map((output) => (
            <div key={`${output.name}-${output.type}`} className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {output.name} <span className="font-mono">({output.type})</span>
              </p>
              <p className="break-all font-mono text-sm text-foreground">{output.value}</p>
            </div>
          ))}
        </Card>
      )}

      {outputs === null && !busy && !error && history.length === 0 && (
        <EmptyState
          icon={<FileCode className="h-6 w-6" aria-hidden="true" />}
          title="No call made yet"
          description="Paste a contract ABI, pick a read function, and press Call. Nothing you enter here can change chain state — only view and pure functions are callable."
        />
      )}

      {history.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Recent calls</p>
            <button
              type="button"
              onClick={() => setHistory([])}
              className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Clear history
            </button>
          </div>
          <ul className="space-y-1.5">
            {history.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start justify-between gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-xs"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-mono text-foreground">{entry.signature}</p>
                  <p className="text-muted-foreground">
                    {entry.network} · {formatRelativeTime(entry.at)}
                  </p>
                  <p className={`truncate ${entry.ok ? "text-muted-foreground" : "text-destructive"}`}>
                    {entry.summary}
                  </p>
                </div>
                <Badge tone={entry.ok ? "success" : "danger"}>{entry.ok ? "ok" : "failed"}</Badge>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Kept in memory only, never stored.</p>
        </div>
      )}
    </form>
  )
}
