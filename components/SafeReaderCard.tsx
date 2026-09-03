"use client"

/**
 * Safe multisig reader tool card.
 *
 * Reads a Gnosis Safe's configuration — owners, threshold, nonce, version —
 * straight from the Safe contract via `lib/safeReader.ts`. No SDK, no API key:
 * five raw `eth_call`s against the shared RPC pool, one at a time per request,
 * with an abort guard so a slow response can never land for an address the
 * user has already replaced.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Shield, Users } from "lucide-react"
import Field, { monoInputClassName } from "./ui/Field"
import Button from "./ui/Button"
import Card from "./ui/Card"
import Badge from "./ui/Badge"
import CopyButton from "./ui/CopyButton"
import { EmptyState, ErrorState, Spinner } from "./ui/Feedback"
import { readSafe, type SafeInfo } from "@/lib/safeReader"
import { NETWORKS } from "@/lib/ethers"
import { logger } from "@/lib/logger"

/** Networks offered, mirroring the gas tracker's curated mainnet subset. */
const SAFE_NETWORK_KEYS = [
  "mainnet",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "bsc",
  "avalanche",
] as const

type SafeNetworkKey = (typeof SAFE_NETWORK_KEYS)[number]

const KNOWN_SAFE_NETWORKS: ReadonlySet<string> = new Set(SAFE_NETWORK_KEYS)

/** Select options, filtered through the built-in table like the gas tracker's. */
const NETWORK_OPTIONS = SAFE_NETWORK_KEYS.filter(
  (key): key is SafeNetworkKey => key in NETWORKS
).map((key) => ({ key, name: NETWORKS[key].name }))

export default function SafeReaderCard() {
  const [network, setNetwork] = useState<SafeNetworkKey>("mainnet")
  const [address, setAddress] = useState("")
  const [info, setInfo] = useState<SafeInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // One controller per in-flight read, superseded by the next one.
  const abortRef = useRef<AbortController | null>(null)

  // Abandon any in-flight read when the card unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  const read = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setBusy(true)
    setError("")
    try {
      const result = await readSafe(network, address, controller.signal)
      // The pool cannot cancel an already-sent HTTP request, so an aborted
      // read can still resolve; never let it land stale results.
      if (controller.signal.aborted) return
      if (result.ok) {
        setInfo(result.value)
      } else {
        setInfo(null)
        setError(result.error)
      }
    } catch (caught) {
      if (controller.signal.aborted) return
      setInfo(null)
      logger.warn("Safe read failed", { network, error: caught })
      setError("Could not read the Safe. Check your connection and try again.")
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [address, network])

  const selectNetwork = (next: string): void => {
    if (next === network || !KNOWN_SAFE_NETWORKS.has(next)) return
    // Results and errors belong to the previously selected network.
    abortRef.current?.abort()
    abortRef.current = null
    setNetwork(next as SafeNetworkKey)
    setInfo(null)
    setError("")
    setBusy(false)
  }

  const selectedName = NETWORK_OPTIONS.find((option) => option.key === network)?.name ?? network

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void read()
      }}
      className="space-y-4"
    >
      {/* Persistent announcement region. */}
      <p role="status" aria-live="polite" className="sr-only">
        {busy
          ? `Reading the Safe on ${selectedName}…`
          : info
            ? `Safe read: ${info.owners.length} owners, threshold ${info.threshold.toString()} of ${info.owners.length}, version ${info.version}.`
            : error}
      </p>

      <Field label="Network" hint="Major mainnets, matching the other developer tools.">
        {(props) => (
          <select
            {...props}
            value={network}
            onChange={(event) => selectNetwork(event.target.value)}
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

      <Field
        label="Safe address"
        hint="Example on mainnet: 0x0DA0C3e52C977Ed3cBc641fF02DD271c3ED55aFe"
      >
        {(props) => (
          <input
            {...props}
            type="text"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value)
              // A new address invalidates whatever was read before.
              abortRef.current?.abort()
              abortRef.current = null
              setInfo(null)
              setError("")
              setBusy(false)
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="0x…"
            className={monoInputClassName}
          />
        )}
      </Field>

      <Button
        type="submit"
        isLoading={busy}
        loadingLabel="Reading…"
        fullWidth
        disabled={address.trim() === ""}
        icon={<Shield className="h-4 w-4" aria-hidden="true" />}
      >
        Read Safe
      </Button>

      {busy && <Spinner label={`Reading the Safe on ${selectedName}…`} />}

      {error && !busy && (
        <ErrorState
          title="Could not read this Safe."
          description={error}
          action={
            <Button variant="secondary" onClick={() => void read()}>
              Try again
            </Button>
          }
        />
      )}

      {info === null && !busy && !error && (
        <EmptyState
          icon={<Shield className="h-6 w-6" aria-hidden="true" />}
          title="No Safe read yet"
          description="Enter a Safe address and press Read Safe. Owners, threshold, nonce and version are read from the Safe contract itself — nothing is sent anywhere else."
        />
      )}

      {info !== null && !busy && (
        <Card variant="inset" padding="sm" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="primary" dot>
              Safe v{info.version}
            </Badge>
            <Badge tone="neutral">
              {info.threshold.toString()} of {info.owners.length} signatures
            </Badge>
            <Badge tone="neutral">nonce {info.nonce.toString()}</Badge>
            {info.chainId !== null && <Badge tone="neutral">chain {info.chainId.toString()}</Badge>}
          </div>

          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              Owners ({info.owners.length}), in signing order
            </p>
            <ul className="space-y-1">
              {info.owners.map((owner, index) => (
                <li
                  key={owner}
                  className="flex min-h-[44px] items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/40 px-3"
                >
                  <span className="min-w-0 truncate font-mono text-sm text-foreground">
                    <span className="mr-2 text-xs text-muted-foreground">{index + 1}.</span>
                    {owner}
                  </span>
                  <CopyButton value={owner} label={`owner address ${index + 1}`} />
                </li>
              ))}
            </ul>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Read directly from the Safe contract on {selectedName}. A transaction needs{" "}
            {info.threshold.toString()} of {info.owners.length} owner signatures.
          </p>
        </Card>
      )}
    </form>
  )
}
