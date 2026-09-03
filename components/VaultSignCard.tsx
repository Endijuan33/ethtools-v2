"use client"

/**
 * "Sign with vault account" card for the unlocked vault view.
 *
 * The developer tools sign with a pasted private key — the last place in the
 * app where a key is typed by hand. While the vault is unlocked it already
 * holds the decrypted keys in memory, so this card signs with the active
 * account directly: the key arrives as a prop, is handed to the same local
 * signing functions the tools use, and is never rendered, persisted, or echoed
 * in an error. The visible identity is the account address and label —
 * "Signing as 0x…" — never the key.
 *
 * The parent keys this card by address, so an account switch remounts it with
 * clean state. The outcome guard below is a second line of defense for a call
 * site that forgets the key: a signature produced by the previous account must
 * never sit under the new account's badge.
 *
 * UX mirrors the tool cards: a live byte counter on messages, live EIP-712
 * validation with precise errors, Ctrl+Enter to sign, and the signature plus
 * digest in a copyable mono block announced as a status region. Verification
 * stays in the Tools section — this card only signs.
 */

import { useCallback, useId, useMemo, useState } from "react"
import { FileJson, MessageSquare, PenLine } from "lucide-react"
import Card, { CardDescription, CardHeader, CardTitle } from "./ui/Card"
import Field, { monoInputClassName } from "./ui/Field"
import Button from "./ui/Button"
import Badge from "./ui/Badge"
import Alert from "./ui/Alert"
import CopyButton from "./ui/CopyButton"
import Tabs, { TabPanel } from "./ui/Tabs"
import { truncateHex } from "@/lib/format"
import {
  MAX_MESSAGE_BYTES,
  hashPersonalMessage,
  signPersonalMessage,
  utf8ByteLength,
} from "@/lib/signMessage"
import {
  signTypedData,
  validateTypedDataJSON,
  type ValidTypedData,
} from "@/lib/signTypedData"

/** Payload formats the card can sign. */
const MODES = [
  { id: "message", label: "Message", icon: MessageSquare },
  { id: "typed-data", label: "Typed data", icon: FileJson },
] as const

type Mode = (typeof MODES)[number]["id"]

/** A minimal wallet-style payload shown as the textarea placeholder. */
const EXAMPLE_PAYLOAD = `{
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" }
    ],
    "Mail": [
      { "name": "from", "type": "address" },
      { "name": "contents", "type": "string" }
    ]
  },
  "primaryType": "Mail",
  "domain": { "name": "Ether Mail", "version": "1", "chainId": 1 },
  "message": {
    "from": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "contents": "Hello, EthTools!"
  }
}`

/** What a successful sign produced, kept with the account that produced it. */
interface SignOutcome {
  /** Address of the account whose key signed. */
  address: string
  /** Which payload format was signed, so the digest label stays truthful. */
  kind: Mode
  /** The 65-byte signature as `0x`-prefixed hex. */
  signature: string
  /** The digest that was signed: the EIP-191 message hash or the EIP-712 digest. */
  digest: string
}

export interface VaultSignCardProps {
  /**
   * The active vault account. The private key crosses this boundary only to
   * reach the local signing functions — it is never displayed or transmitted,
   * and no error ever echoes it.
   */
  account: { address: string; privateKey: string }
  /** Account label, shown beside the address so the identity is named, not just hex. */
  label?: string
}

export default function VaultSignCard({ account, label }: VaultSignCardProps) {
  const titleId = useId()
  const [mode, setMode] = useState<Mode>("message")
  const [message, setMessage] = useState("")
  const [payload, setPayload] = useState("")
  const [error, setError] = useState("")
  const [signing, setSigning] = useState(false)
  const [outcome, setOutcome] = useState<SignOutcome | null>(null)

  /**
   * Live EIP-712 validation, memoized per keystroke — the same pattern as
   * TypedDataSignCard. A valid payload yields its digest; anything else yields
   * a precise, user-safe error that the field shows in place of the hint.
   */
  const validation = useMemo(
    () => (payload.trim() === "" ? null : validateTypedDataJSON(payload)),
    [payload]
  )
  const typedData: ValidTypedData | null =
    validation !== null && validation.ok ? validation.value : null
  const payloadError = validation !== null && !validation.ok ? validation.error : undefined

  /** Live byte counter, so an oversized message is visible before submitting. */
  const byteCounter = useMemo(() => {
    if (message === "") return undefined
    const bytes = utf8ByteLength(message)
    return (
      <Badge tone={bytes > MAX_MESSAGE_BYTES ? "danger" : "neutral"}>
        {bytes.toLocaleString()} / {MAX_MESSAGE_BYTES.toLocaleString()} bytes
      </Badge>
    )
  }, [message])

  /** Drop the previous signature and error; any input change calls this. */
  const clearResult = useCallback((): void => {
    setError("")
    setOutcome(null)
  }, [])

  /**
   * The outcome is displayed only while it belongs to the account on screen.
   *
   * The parent remounts this card per account (keyed by address), so the guard
   * never fires in practice — but if a future call site forgets the key, a
   * signature from the previous account must not sit under the new account's
   * "Signing as" badge. A hidden signature is honest; a mismatched one is a
   * forgery.
   */
  const visibleOutcome =
    outcome !== null && outcome.address === account.address ? outcome : null

  const handleModeChange = useCallback(
    (next: Mode): void => {
      setMode(next)
      // A signature belongs to the payload and format that produced it; after
      // a format switch it would be ambiguous which one it covers. Drafts are
      // kept — only the result is dropped.
      clearResult()
    },
    [clearResult]
  )

  const canSignMessage = message !== "" && !signing
  const canSignTypedData = typedData !== null && !signing

  const handleSignMessage = useCallback(async () => {
    clearResult()
    setSigning(true)
    try {
      const result = await signPersonalMessage(account.privateKey, message)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setOutcome({
        address: account.address,
        kind: "message",
        signature: result.value,
        digest: hashPersonalMessage(message),
      })
    } finally {
      setSigning(false)
    }
  }, [account.address, account.privateKey, clearResult, message])

  const handleSignTypedData = useCallback(async () => {
    if (typedData === null) return
    clearResult()
    setSigning(true)
    try {
      const result = await signTypedData(account.privateKey, typedData)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setOutcome({
        address: account.address,
        kind: "typed-data",
        signature: result.value,
        digest: typedData.digest,
      })
    } finally {
      setSigning(false)
    }
  }, [account.address, account.privateKey, clearResult, typedData])

  return (
    <Card variant="inset" padding="sm" as="section" aria-labelledby={titleId}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle as="h3" className="text-base" id={titleId}>
            Sign message
          </CardTitle>
          <CardDescription>
            Sign a message or EIP-712 payload with the active vault account; no key entry needed.
          </CardDescription>

          {/* The visible identity is the address and label, never the key. The
              truncated form is what sighted users see; screen readers get the
              full address, and the title tooltip bridges the two. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span title={account.address}>
              <Badge tone="primary">
                <span aria-hidden="true">
                  Signing as {truncateHex(account.address, 6, 4)}
                </span>
                <span className="sr-only">Signing as {account.address}</span>
              </Badge>
            </span>
            {label && label.trim() !== "" && <Badge tone="neutral">{label}</Badge>}
          </div>
        </div>
      </CardHeader>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (mode === "message") {
            if (canSignMessage) void handleSignMessage()
          } else if (canSignTypedData) {
            void handleSignTypedData()
          }
        }}
      >
        <Tabs
          items={MODES}
          value={mode}
          onChange={handleModeChange}
          label="Signing format"
          layoutGroupId="vault-sign-format"
        />

        <Alert tone="info" title="Signing happens locally in this browser">
          Nothing is transmitted. The signature is safe to share; the private key that produced
          it never is.
        </Alert>

        {mode === "message" ? (
          <TabPanel id="message" className="space-y-4">
            <Field
              label="Message"
              action={byteCounter}
              hint="The exact text that will be signed. Press Ctrl+Enter (Cmd+Enter on Mac) to sign."
            >
              {(props) => (
                <textarea
                  {...props}
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value)
                    // Editing invalidates whatever was signed before.
                    clearResult()
                  }}
                  onKeyDown={(event) => {
                    // A bare Enter stays a newline; only the chord submits.
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      if (canSignMessage) void handleSignMessage()
                    }
                  }}
                  rows={3}
                  placeholder="Hello, EthTools!"
                  className={`${monoInputClassName} resize-y text-sm`}
                />
              )}
            </Field>

            <Button
              type="submit"
              fullWidth
              icon={<PenLine className="h-4 w-4" aria-hidden="true" />}
              isLoading={signing}
              loadingLabel="Signing…"
              disabled={!canSignMessage}
            >
              Sign message
            </Button>
          </TabPanel>
        ) : (
          <TabPanel id="typed-data" className="space-y-4">
            <Field
              label="EIP-712 payload"
              error={payloadError}
              action={
                typedData ? <Badge tone="primary">Valid EIP-712 payload</Badge> : undefined
              }
              hint={
                typedData
                  ? undefined
                  : 'The JSON a wallet shows for eth_signTypedData_v4: "types", "primaryType", "domain" and "message". Press Ctrl+Enter (Cmd+Enter on Mac) to sign.'
              }
            >
              {(props) => (
                <textarea
                  {...props}
                  value={payload}
                  onChange={(event) => {
                    setPayload(event.target.value)
                    // Editing invalidates whatever was signed before.
                    clearResult()
                  }}
                  onKeyDown={(event) => {
                    // A bare Enter stays a newline; only the chord submits.
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      if (canSignTypedData) void handleSignTypedData()
                    }
                  }}
                  rows={10}
                  placeholder={EXAMPLE_PAYLOAD}
                  spellCheck={false}
                  className={`${monoInputClassName} resize-y text-xs`}
                />
              )}
            </Field>

            {/* The digest is what the key actually vouches for; showing it
                before the button mirrors TypedDataSignCard so the user never
                signs a payload whose hash they have not seen. */}
            {typedData && (
              <div className="flex items-start justify-between gap-2 rounded-md border border-border/60 bg-background/40 p-2.5">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Digest</p>
                  <p className="mt-1 break-all font-mono text-xs text-foreground">
                    {typedData.digest}
                  </p>
                </div>
                <CopyButton value={typedData.digest} label="digest" />
              </div>
            )}

            <Button
              type="submit"
              fullWidth
              icon={<PenLine className="h-4 w-4" aria-hidden="true" />}
              isLoading={signing}
              loadingLabel="Signing…"
              disabled={!canSignTypedData}
            >
              Sign typed data
            </Button>
          </TabPanel>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        {visibleOutcome && (
          <div
            role="status"
            aria-live="polite"
            className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-2.5"
          >
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Signature</p>
              <div className="mt-1 flex items-start justify-between gap-2">
                <p className="min-w-0 break-all font-mono text-sm text-success">
                  {visibleOutcome.signature}
                </p>
                <CopyButton value={visibleOutcome.signature} label="signature" />
              </div>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {visibleOutcome.kind === "message" ? "EIP-191 digest" : "EIP-712 digest"}
              </p>
              <div className="mt-1 flex items-start justify-between gap-2">
                <p className="min-w-0 break-all font-mono text-xs text-foreground">
                  {visibleOutcome.digest}
                </p>
                <CopyButton value={visibleOutcome.digest} label="digest" />
              </div>
            </div>
          </div>
        )}
      </form>
    </Card>
  )
}
