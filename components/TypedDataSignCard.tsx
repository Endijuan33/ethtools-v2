"use client"

/**
 * EIP-712 typed-data tool.
 *
 * The payload textarea is validated live with `validateTypedDataJSON`, so a
 * pasted wallet payload is checked (and its digest shown) before any key is
 * entered. Sign and verify then run entirely in the browser via
 * `lib/signTypedData.ts`.
 *
 * The private key lives only in component state, is wiped whenever the mode or
 * tool tab changes (switching tabs unmounts this card), and never appears in an
 * error.
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
  signTypedData,
  validateTypedDataJSON,
  verifyTypedDataSignature,
  type ValidTypedData,
} from "@/lib/signTypedData"

const MODES = [
  { id: "sign", label: "Sign", icon: PenLine },
  { id: "verify", label: "Verify", icon: BadgeCheck },
] as const

type Mode = (typeof MODES)[number]["id"]

/** A minimal wallet-style payload to prefill on first use. */
const EXAMPLE_PAYLOAD = `{
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" },
      { "name": "verifyingContract", "type": "address" }
    ],
    "Mail": [
      { "name": "from", "type": "address" },
      { "name": "contents", "type": "string" }
    ]
  },
  "primaryType": "Mail",
  "domain": {
    "name": "Ether Mail",
    "version": "1",
    "chainId": 1,
    "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
  },
  "message": {
    "from": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "contents": "Hello, EthTools!"
  }
}`

/** What a successful sign produced, broken down for display. */
interface SignOutcome {
  signature: string
  signer: string | null
}

/** What a verification concluded. */
interface VerifyOutcome {
  recovered: string
  matches: boolean
  expected: string
}

export default function TypedDataSignCard() {
  const [mode, setMode] = useState<Mode>("sign")
  const [payload, setPayload] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [address, setAddress] = useState("")
  const [signature, setSignature] = useState("")
  const [error, setError] = useState("")
  const [signing, setSigning] = useState(false)
  const [signOutcome, setSignOutcome] = useState<SignOutcome | null>(null)
  const [verifyOutcome, setVerifyOutcome] = useState<VerifyOutcome | null>(null)

  /**
   * Live validation, memoized per keystroke. A valid payload yields its primary
   * type and digest; anything else yields a precise, user-safe error that the
   * field shows in place of the hint.
   */
  const validation = useMemo(
    () => (payload.trim() === "" ? null : validateTypedDataJSON(payload)),
    [payload]
  )
  const typedData: ValidTypedData | null =
    validation !== null && validation.ok ? validation.value : null
  const payloadError = validation !== null && !validation.ok ? validation.error : undefined

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

  const canSign = typedData !== null && privateKey.trim() !== "" && !signing
  const canVerify = typedData !== null && address.trim() !== "" && signature.trim() !== ""

  const handleSign = useCallback(async () => {
    if (typedData === null) return
    resetResults()
    setSigning(true)
    try {
      const result = await signTypedData(privateKey, typedData)
      if (!result.ok) {
        setError(result.error)
        return
      }
      const signer = deriveFromPrivateKey(privateKey)
      setSignOutcome({
        signature: result.value,
        signer: signer.ok ? signer.value.address : null,
      })
    } finally {
      setSigning(false)
    }
  }, [privateKey, resetResults, typedData])

  const handleVerify = useCallback((): void => {
    if (typedData === null) return
    resetResults()
    const result = verifyTypedDataSignature(address, typedData, signature)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setVerifyOutcome({
      recovered: result.value.recovered,
      matches: result.value.matches,
      expected: address.trim(),
    })
  }, [address, resetResults, signature, typedData])

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
        label="Typed-data mode"
        layoutGroupId="typed-data-mode"
      />

      {mode === "sign" && (
        <Alert tone="warning" title="Your keys never leave this browser">
          Signing happens locally and nothing is transmitted. Even so, avoid entering a key that
          holds real funds on a shared or public device.
        </Alert>
      )}

      <Field
        label="EIP-712 payload"
        error={payloadError}
        action={
          typedData ? <Badge tone="success">{typedData.primaryType}</Badge> : undefined
        }
        hint={
          typedData
            ? undefined
            : 'The JSON a wallet shows for eth_signTypedData_v4: "types", "primaryType", "domain" and "message".'
        }
      >
        {(props) => (
          <textarea
            {...props}
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            rows={10}
            placeholder={EXAMPLE_PAYLOAD}
            spellCheck={false}
            className={`${monoInputClassName} resize-y text-xs`}
          />
        )}
      </Field>

      {typedData && (
        <div className="flex items-start justify-between gap-2 rounded-md border border-border/60 bg-background/40 p-2.5">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Digest</p>
            <p className="mt-1 break-all font-mono text-xs text-foreground">{typedData.digest}</p>
          </div>
          <CopyButton value={typedData.digest} label="digest" />
        </div>
      )}

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
            Sign typed data
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
              The signature over this payload was produced by {verifyOutcome.expected}.
            </Alert>
          ) : (
            <Alert tone="danger" title="Signature does not match">
              The signature recovers {verifyOutcome.recovered}, not {verifyOutcome.expected}. The
              payload, the signature, or the expected address is wrong.
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
