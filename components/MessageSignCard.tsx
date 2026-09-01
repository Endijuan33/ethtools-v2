"use client"

/**
 * EIP-191 `personal_sign` tool.
 *
 * Sign mode turns a message plus a private key into a signature; verify mode
 * recovers the signer from a message and signature. Both run entirely in the
 * browser via `lib/signMessage.ts`.
 *
 * The private key lives only in component state, is wiped whenever the mode or
 * tool tab changes (switching tabs unmounts this card), and never appears in an
 * error. The live "signs as" badge is derived with the same validator the
 * converter uses, so a pasted key is checked before anything is signed with it.
 */

import { useCallback, useMemo, useState } from "react"
import { BadgeCheck, PenLine } from "lucide-react"
import Field, { monoInputClassName, secretInputProps } from "./ui/Field"
import Button from "./ui/Button"
import Card from "./ui/Card"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import CopyButton from "./ui/CopyButton"
import Tabs from "./ui/Tabs"
import { classifySecret, deriveFromPrivateKey } from "@/lib/hdWallet"
import {
  MAX_MESSAGE_BYTES,
  hashPersonalMessage,
  signPersonalMessage,
  utf8ByteLength,
  verifyPersonalSignature,
} from "@/lib/signMessage"

const MODES = [
  { id: "sign", label: "Sign", icon: PenLine },
  { id: "verify", label: "Verify", icon: BadgeCheck },
] as const

type Mode = (typeof MODES)[number]["id"]

/** What a successful sign produced, broken down for display. */
interface SignOutcome {
  signature: string
  digest: string
  signer: string | null
}

/** What a verification concluded. */
interface VerifyOutcome {
  recovered: string
  matches: boolean
  expected: string
}

export default function MessageSignCard() {
  const [mode, setMode] = useState<Mode>("sign")
  const [message, setMessage] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [address, setAddress] = useState("")
  const [signature, setSignature] = useState("")
  const [error, setError] = useState("")
  const [signing, setSigning] = useState(false)
  const [signOutcome, setSignOutcome] = useState<SignOutcome | null>(null)
  const [verifyOutcome, setVerifyOutcome] = useState<VerifyOutcome | null>(null)

  const resetResults = useCallback((): void => {
    setError("")
    setSignOutcome(null)
    setVerifyOutcome(null)
  }, [])

  const handleModeChange = useCallback(
    (next: Mode): void => {
      setMode(next)
      // The private key is wiped on any switch: it must not survive into a
      // mode (or later a tool tab) where it is not needed.
      setPrivateKey("")
      resetResults()
    },
    [resetResults]
  )

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

  /**
   * Live feedback on the pasted key, derived with the same classification the
   * converter uses. Surfacing the address before signing catches the classic
   * "signed with the wrong account" mistake while it is still fixable.
   */
  const keyFeedback = useMemo(() => {
    if (privateKey.trim() === "") return undefined
    const classification = classifySecret(privateKey)
    if (classification.kind === "private-key") {
      const derived = deriveFromPrivateKey(privateKey)
      if (derived.ok) {
        return <Badge tone="success">Signs as {derived.value.address}</Badge>
      }
      return <Badge tone="danger">Not a usable key</Badge>
    }
    if (classification.kind === "mnemonic") {
      return <Badge tone="warning">Use a single private key</Badge>
    }
    return <Badge tone="neutral">64 hex characters expected</Badge>
  }, [privateKey])

  const canSign = message !== "" && privateKey.trim() !== "" && !signing
  const canVerify = address.trim() !== "" && message !== "" && signature.trim() !== ""

  const handleSign = useCallback(async () => {
    resetResults()
    setSigning(true)
    try {
      const result = await signPersonalMessage(privateKey, message)
      if (!result.ok) {
        setError(result.error)
        return
      }
      const signer = deriveFromPrivateKey(privateKey)
      setSignOutcome({
        signature: result.value,
        digest: hashPersonalMessage(message),
        signer: signer.ok ? signer.value.address : null,
      })
    } finally {
      setSigning(false)
    }
  }, [message, privateKey, resetResults])

  const handleVerify = useCallback((): void => {
    resetResults()
    const result = verifyPersonalSignature(address, message, signature)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setVerifyOutcome({
      recovered: result.value.recovered,
      matches: result.value.matches,
      expected: address.trim(),
    })
  }, [address, message, resetResults, signature])

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (mode === "sign") {
          if (canSign) void handleSign()
        } else if (canVerify) {
          handleVerify()
        }
      }}
    >
      <Tabs
        items={MODES}
        value={mode}
        onChange={handleModeChange}
        label="Signing mode"
        layoutGroupId="sign-message-mode"
      />

      {mode === "sign" && (
        <Alert tone="warning" title="Your keys never leave this browser">
          Signing happens locally and nothing is transmitted. Even so, avoid entering a key that
          holds real funds on a shared or public device.
        </Alert>
      )}

      <Field
        label="Message"
        action={byteCounter}
        hint={
          mode === "sign"
            ? "The exact text that will be signed. Press Ctrl+Enter (Cmd+Enter on Mac) to sign."
            : "The message exactly as it was signed; any difference changes the recovered address."
        }
      >
        {(props) => (
          <textarea
            {...props}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              // A bare Enter stays a newline; only the chord submits.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                if (mode === "sign" && canSign) void handleSign()
                else if (mode === "verify" && canVerify) handleVerify()
              }
            }}
            rows={3}
            placeholder="Hello, EthTools!"
            className={`${monoInputClassName} resize-y text-sm`}
          />
        )}
      </Field>

      {mode === "sign" ? (
        <>
          <Field
            label="Private key"
            action={keyFeedback}
            hint="64 hexadecimal characters, with or without the 0x prefix. Used once, in memory, and cleared when you switch modes."
          >
            {(props) => (
              <input
                {...props}
                {...secretInputProps}
                type="text"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
                placeholder="0x…"
                className={monoInputClassName}
              />
            )}
          </Field>

          <Button
            type="submit"
            fullWidth
            icon={<PenLine className="h-4 w-4" aria-hidden="true" />}
            isLoading={signing}
            loadingLabel="Signing…"
            disabled={!canSign}
          >
            Sign message
          </Button>
        </>
      ) : (
        <>
          <Field label="Address" hint="The address the signature is claimed to belong to. Checksum optional.">
            {(props) => (
              <input
                {...props}
                type="text"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="0x…"
                spellCheck={false}
                className={monoInputClassName}
              />
            )}
          </Field>

          <Field label="Signature" hint="65 bytes of hex (0x followed by 130 characters). The compact form also works.">
            {(props) => (
              <textarea
                {...props}
                value={signature}
                onChange={(event) => setSignature(event.target.value)}
                rows={3}
                placeholder="0x…"
                spellCheck={false}
                className={`${monoInputClassName} resize-y text-xs`}
              />
            )}
          </Field>

          <Button
            type="submit"
            fullWidth
            icon={<BadgeCheck className="h-4 w-4" aria-hidden="true" />}
            disabled={!canVerify}
          >
            Verify signature
          </Button>
        </>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {signOutcome && (
        <Card variant="inset" padding="sm" className="space-y-3" role="status" aria-live="polite">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Signature</p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="min-w-0 break-all font-mono text-sm text-success">
                {signOutcome.signature}
              </p>
              <CopyButton value={signOutcome.signature} label="signature" />
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              EIP-191 digest
            </p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="min-w-0 break-all font-mono text-xs text-foreground">
                {signOutcome.digest}
              </p>
              <CopyButton value={signOutcome.digest} label="digest" />
            </div>
          </div>
          {signOutcome.signer && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Signer</p>
              <div className="mt-1 flex items-start justify-between gap-2">
                <p className="min-w-0 break-all font-mono text-sm text-foreground">
                  {signOutcome.signer}
                </p>
                <CopyButton value={signOutcome.signer} label="signer address" />
              </div>
            </div>
          )}
        </Card>
      )}

      {verifyOutcome && (
        <Card variant="inset" padding="sm" className="space-y-3" role="status" aria-live="polite">
          {verifyOutcome.matches ? (
            <Alert tone="success" title="Signature matches">
              The signature over this message was produced by {verifyOutcome.expected}.
            </Alert>
          ) : (
            <Alert tone="danger" title="Signature does not match">
              The signature recovers {verifyOutcome.recovered}, not {verifyOutcome.expected}. The
              message, the signature, or the expected address is wrong.
            </Alert>
          )}
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Recovered address
            </p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="min-w-0 break-all font-mono text-sm text-foreground">
                {verifyOutcome.recovered}
              </p>
              <CopyButton value={verifyOutcome.recovered} label="recovered address" />
            </div>
          </div>
        </Card>
      )}
    </form>
  )
}
