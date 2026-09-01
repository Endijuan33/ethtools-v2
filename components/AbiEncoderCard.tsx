"use client"

/**
 * ABI encoder — the counterpart of the calldata decoder.
 *
 * Paste a single function ABI (or a bare signature) and one input per parameter
 * is rendered from it; the encoded calldata appears live as the arguments
 * become valid. Everything runs locally via `lib/abiEncode.ts`, and no secrets
 * are involved, so there is nothing to submit and nothing to clear.
 */

import { useEffect, useMemo, useState } from "react"
import type { ParamType } from "ethers"
import Field, { monoInputClassName } from "./ui/Field"
import Card from "./ui/Card"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import CopyButton from "./ui/CopyButton"
import {
  encodeFunctionCall,
  parseArgumentValue,
  parseFunctionAbi,
} from "@/lib/abiEncode"

/** How to present one ABI parameter in the form. */
function describeInput(param: ParamType): { hint: string; placeholder: string } {
  if (param.isArray()) {
    const child = param.arrayChildren.format("sighash")
    return {
      hint: `Comma-separated ${child} values, or a JSON array. Use JSON when elements contain commas or nest.`,
      placeholder: "1, 2, 3",
    }
  }
  if (param.isTuple()) {
    return {
      hint: `A JSON array with ${param.components.length} value${param.components.length === 1 ? "" : "s"}, one per component.`,
      placeholder: '["0x…", 5]',
    }
  }
  if (param.baseType === "address") {
    return { hint: "A 0x-prefixed address. Checksum optional.", placeholder: "0x…" }
  }
  if (param.baseType === "bool") {
    return { hint: "true or false.", placeholder: "true" }
  }
  if (param.baseType === "string") {
    return { hint: "Any text.", placeholder: "Some text" }
  }
  if (param.baseType.startsWith("bytes")) {
    const size = param.baseType === "bytes" ? "" : ` of exactly ${param.baseType.slice(5)} bytes`
    return { hint: `0x-prefixed hex${size}.`, placeholder: "0x…" }
  }
  // Everything left is an integer type.
  return { hint: "Decimal or 0x-hexadecimal.", placeholder: "12345" }
}

export default function AbiEncoderCard() {
  const [abiText, setAbiText] = useState("")
  /** One raw text per function input, keyed by input index. */
  const [values, setValues] = useState<Record<number, string>>({})

  const parsedAbi = useMemo(
    () => (abiText.trim() === "" ? null : parseFunctionAbi(abiText)),
    [abiText]
  )
  const fragment = parsedAbi !== null && parsedAbi.ok ? parsedAbi.value : null
  const abiError = parsedAbi !== null && !parsedAbi.ok ? parsedAbi.error : undefined

  // Argument values are dropped whenever the function being encoded changes,
  // so values typed against one signature never leak into another.
  const signature = fragment?.format("sighash") ?? ""
  useEffect(() => {
    setValues({})
  }, [signature])

  /**
   * Live per-argument parse and encode. An empty input shows its hint rather
   * than an error — the missing output panel is signal enough — while a
   * non-empty malformed value is reported immediately, naming the argument.
   */
  const attempt = useMemo(() => {
    if (fragment === null) return null

    const errors: (string | undefined)[] = []
    const parsed: unknown[] = []
    let complete = true
    fragment.inputs.forEach((input, index) => {
      const text = values[index] ?? ""
      const label = input.name !== "" ? `"${input.name}"` : `argument #${index}`
      const result = text.trim() === "" ? null : parseArgumentValue(input, text, label)
      if (result === null || !result.ok) {
        complete = false
        errors.push(result !== null ? result.error : undefined)
        parsed.push(undefined)
        return
      }
      errors.push(undefined)
      parsed.push(result.value)
    })

    if (!complete) {
      return { errors, encoded: null }
    }
    const encoded = encodeFunctionCall(fragment, parsed)
    return {
      errors,
      encoded: encoded.ok ? encoded.value : null,
      encodeError: encoded.ok ? undefined : encoded.error,
    }
  }, [fragment, values])

  return (
    <div className="space-y-4">
      <Field
        label="Function ABI or signature"
        error={abiError}
        action={fragment ? <Badge tone="success">{signature}</Badge> : undefined}
        hint={
          fragment
            ? undefined
            : "One function: a JSON fragment, a JSON ABI, or a signature such as transfer(address,uint256)."
        }
      >
        {(props) => (
          <textarea
            {...props}
            value={abiText}
            onChange={(event) => setAbiText(event.target.value)}
            rows={3}
            placeholder="transfer(address to, uint256 amount)"
            spellCheck={false}
            className={`${monoInputClassName} resize-y text-xs`}
          />
        )}
      </Field>

      {fragment && fragment.inputs.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Arguments · {fragment.inputs.length}
          </p>
          {fragment.inputs.map((input, index) => {
            const described = describeInput(input)
            const text = values[index] ?? ""
            return (
              <Field
                key={`${index}-${input.name}`}
                label={input.name !== "" ? input.name : `arg${index}`}
                error={attempt?.errors[index]}
                action={
                  <span className="font-mono text-xs text-muted-foreground">
                    {input.format("sighash")}
                  </span>
                }
                hint={described.hint}
              >
                {(props) => (
                  <input
                    {...props}
                    type="text"
                    value={text}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [index]: event.target.value }))
                    }
                    placeholder={described.placeholder}
                    spellCheck={false}
                    className={monoInputClassName}
                  />
                )}
              </Field>
            )
          })}
        </div>
      )}

      {fragment && fragment.inputs.length === 0 && (
        <p className="text-sm text-muted-foreground">This function takes no arguments.</p>
      )}

      {attempt?.encodeError && <Alert tone="danger">{attempt.encodeError}</Alert>}

      {attempt?.encoded && (
        // No live region here, unlike the signing tools: this panel mutates on
        // every keystroke, and re-announcing a 100-character hex blob per key
        // press would drown out everything else for a screen reader user.
        <Card variant="inset" padding="sm" className="space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Function</p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="min-w-0 break-all font-mono text-sm font-semibold text-success">
                {attempt.encoded.signature}
              </p>
              <CopyButton value={attempt.encoded.signature} label="signature" />
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {attempt.encoded.selector}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Calldata</p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="min-w-0 break-all font-mono text-sm text-foreground">
                {attempt.encoded.calldata}
              </p>
              <CopyButton value={attempt.encoded.calldata} label="calldata" />
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
