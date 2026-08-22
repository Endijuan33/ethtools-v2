"use client"

import { useMemo, useState } from "react"
import Card, { CardHeader, CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Field, { inputClassName, secretInputProps } from "./ui/Field"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import Tabs from "./ui/Tabs"
import { classifySecret, MNEMONIC_WORD_COUNTS } from "@/lib/hdWallet"
import { cn } from "@/lib/utils"

type Network = "mainnet" | "testnet"

const NETWORKS = [
  { id: "mainnet", label: "Mainnet" },
  { id: "testnet", label: "Testnet" },
] as const

interface InputCardProps {
  onConvert: (input: string, network: Network) => void
  isLoading: boolean
}

/**
 * Secret entry for the converter.
 *
 * The live counter is driven by `classifySecret`, the same function the
 * conversion itself uses. Deriving it independently is what previously let the
 * counter disagree with the parser — it reported "15 / 12 words" for a phrase
 * length BIP-39 actually permits.
 */
export default function InputCard({ onConvert, isLoading }: InputCardProps) {
  const [inputValue, setInputValue] = useState("")
  const [network, setNetwork] = useState<Network>("mainnet")
  const [error, setError] = useState("")

  const classification = useMemo(() => classifySecret(inputValue), [inputValue])

  const handleConvert = (): void => {
    setError("")
    if (inputValue.trim() === "") {
      setError("Enter a recovery phrase or a private key.")
      return
    }
    onConvert(inputValue, network)
  }

  /** Live feedback on what the input currently looks like. */
  const counter =
    inputValue.trim() === "" ? undefined : classification.kind === "private-key" ? (
      <Badge tone="success">Private key</Badge>
    ) : classification.kind === "mnemonic" ? (
      <Badge tone="success">{classification.wordCount} words</Badge>
    ) : (
      <Badge tone="neutral">
        {classification.wordCount > 1 ? `${classification.wordCount} words` : "Unrecognized"}
      </Badge>
    )

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Key to address converter</CardTitle>
      </CardHeader>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          handleConvert()
        }}
      >
        <Alert tone="warning" title="Your keys never leave this browser">
          Derivation happens locally and nothing is transmitted. Even so, avoid entering a phrase
          that holds real funds on a shared or public device.
        </Alert>

        <Field
          label="Recovery phrase or private key"
          error={error}
          action={counter}
          hint={`Accepts ${MNEMONIC_WORD_COUNTS.join(", ")} words, or a 64-character private key. Press Ctrl+Enter (Cmd+Enter on Mac) to convert.`}
        >
          {(field) => (
            <textarea
              {...field}
              {...secretInputProps}
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                // A bare Enter must stay a newline: phrases are whitespace
                // delimited and are routinely pasted across multiple lines.
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  handleConvert()
                }
              }}
              placeholder="abandon ability able … or 0x…"
              className={cn(inputClassName, "h-32 resize-none font-mono text-sm")}
            />
          )}
        </Field>

        <Tabs
          items={NETWORKS}
          value={network}
          onChange={setNetwork}
          label="Explorer network"
          layoutGroupId="converter-network"
        />

        <Button
          type="submit"
          fullWidth
          isLoading={isLoading}
          loadingLabel="Converting…"
          disabled={isLoading || inputValue.trim() === ""}
        >
          Convert
        </Button>
      </form>
    </Card>
  )
}
