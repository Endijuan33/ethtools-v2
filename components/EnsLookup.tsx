"use client"

/**
 * ENS forward and reverse lookup.
 *
 * ENS records live on Ethereum mainnet, so this always resolves against a mainnet
 * provider regardless of which network the wallet is using. That is stated in the
 * UI because resolving `name.eth` "on Optimism" is a common misconception.
 *
 * A reverse record is only meaningful if the name forward-resolves back to the
 * same address; anyone can point a reverse record at any name. The result surfaces
 * that verification explicitly rather than presenting an unverified name as fact.
 */

import { useCallback, useState } from "react"
import { Search, ShieldCheck } from "lucide-react"
import Field, { monoInputClassName } from "./ui/Field"
import Button from "./ui/Button"
import Card from "./ui/Card"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import CopyButton from "./ui/CopyButton"
import { Spinner } from "./ui/Feedback"
import { lookupEns, type EnsLookupResult, type EnsProvider } from "@/lib/ens"
import { RpcError, withProvider } from "@/lib/ethers"
import { describeError, logger } from "@/lib/logger"

/**
 * ENS resolver backed by the mainnet RPC pool.
 *
 * `lib/ens.ts` takes the provider as a structural parameter, so each call can be
 * routed through the pool independently. That means an ENS lookup inherits the
 * same retry and failover as every other request, rather than being pinned to one
 * endpoint. The network is hardcoded to mainnet because that is where ENS lives,
 * regardless of which network the wallet is using.
 */
const mainnetEnsProvider: EnsProvider = {
  resolveName: (name) => withProvider("mainnet", (provider) => provider.resolveName(name)),
  lookupAddress: (address) =>
    withProvider("mainnet", (provider) => provider.lookupAddress(address)),
}

/** Resolved value with a copy affordance. */
function Resolved({
  caption,
  value,
  copyLabel,
  children,
}: {
  caption: string
  value: string
  copyLabel: string
  children?: React.ReactNode
}) {
  return (
    <Card variant="inset" padding="sm" className="space-y-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{caption}</p>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-all font-mono text-sm text-success">{value}</p>
        <CopyButton value={value} label={copyLabel} />
      </div>
      {children}
    </Card>
  )
}

export default function EnsLookup() {
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<EnsLookupResult | null>(null)

  const handleLookup = useCallback(async () => {
    setError("")
    setResult(null)

    if (input.trim() === "") {
      setError("Enter an ENS name or an address.")
      return
    }

    setBusy(true)
    try {
      setResult(await lookupEns(mainnetEnsProvider, input))
    } catch (error) {
      logger.warn("ENS lookup failed", { error })
      setError(
        error instanceof RpcError
          ? error.userMessage
          : describeError(error, "Could not reach an Ethereum mainnet node. Check your connection.")
      )
    } finally {
      setBusy(false)
    }
  }, [input])

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void handleLookup()
      }}
      className="space-y-4"
    >
      <Field
        label="ENS name or address"
        hint="A name resolves forward to an address; an address resolves in reverse to its primary name."
        action={<Badge tone="info">Mainnet</Badge>}
      >
        {(props) => (
          <input
            {...props}
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="vitalik.eth or 0x…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={monoInputClassName}
          />
        )}
      </Field>

      <Button
        type="submit"
        isLoading={busy}
        loadingLabel="Resolving…"
        fullWidth
        icon={<Search className="h-4 w-4" aria-hidden="true" />}
      >
        Look up
      </Button>

      {error && <Alert tone="danger">{error}</Alert>}

      {busy && <Spinner label="Resolving on Ethereum mainnet…" />}

      {result?.direction === "invalid" && <Alert tone="warning">{result.error}</Alert>}

      {result?.direction === "forward" &&
        (result.result.status === "resolved" ? (
          <Resolved
            caption={`${result.result.name} resolves to`}
            value={result.result.address}
            copyLabel="address"
          />
        ) : result.result.status === "not-found" ? (
          <Alert tone="warning" title="No address record.">
            {result.result.name} exists but has no address set on mainnet.
          </Alert>
        ) : result.result.status === "timeout" ? (
          <Alert tone="danger" title="Lookup timed out.">
            No response after {result.result.timeoutMs / 1000} seconds. The node may be
            unresponsive.
          </Alert>
        ) : result.result.status === "invalid" ? (
          <Alert tone="warning">{result.result.error}</Alert>
        ) : (
          <Alert tone="danger" title="Lookup failed.">
            {result.result.error}
          </Alert>
        ))}

      {result?.direction === "reverse" &&
        (result.result.status === "resolved" ? (
          <Resolved caption="Primary name" value={result.result.name} copyLabel="name">
            {result.result.forwardVerified ? (
              <p className="flex items-center gap-1.5 text-xs text-success">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Verified — this name resolves back to the same address.
              </p>
            ) : (
              <Alert tone="warning" title="Unverified name.">
                This name does not resolve back to the address you entered
                {result.result.forwardAddress
                  ? ` — it points to ${result.result.forwardAddress}`
                  : ""}
                {result.result.verificationError
                  ? `. ${result.result.verificationError}`
                  : ". Anyone can set a reverse record, so do not treat this as identity."}
              </Alert>
            )}
          </Resolved>
        ) : result.result.status === "not-found" ? (
          <Alert tone="warning" title="No primary name.">
            This address has not set a reverse ENS record.
          </Alert>
        ) : result.result.status === "timeout" ? (
          <Alert tone="danger" title="Lookup timed out.">
            No response after {result.result.timeoutMs / 1000} seconds.
          </Alert>
        ) : result.result.status === "invalid" ? (
          <Alert tone="warning">{result.result.error}</Alert>
        ) : (
          <Alert tone="danger" title="Lookup failed.">
            {result.result.error}
          </Alert>
        ))}
    </form>
  )
}
