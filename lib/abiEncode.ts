/**
 * ABI encoding for transaction calldata.
 *
 * The counterpart of `lib/calldata.ts`: that module decodes calldata into
 * display-safe strings, this one turns a function ABI plus argument text into
 * the calldata a transaction would carry. It is pure — no provider, no network —
 * and every failure carries a user-presentable message naming the argument at
 * fault.
 *
 * Argument values are parsed from text so the UI can offer one plain input per
 * ABI parameter: integers accept decimal or `0x` hex, booleans `true`/`false`,
 * byte types `0x`-prefixed hex, and arrays and tuples either comma-separated
 * values or a JSON array (JSON is required whenever elements contain commas or
 * nest).
 */

import { AbiCoder, Fragment, getAddress, Interface } from "ethers"
import type { FunctionFragment, ParamType } from "ethers"

/**
 * Outcome of an operation that can legitimately fail because of user input.
 *
 * On failure, `error` is a complete, user-presentable English sentence.
 */
export type AbiEncodeResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** An encoded function call, broken down for display. */
export interface EncodedCall {
  /** The canonical signature, e.g. `transfer(address,uint256)`. */
  signature: string
  /** The 4-byte selector as lowercase `0x`-prefixed hex. */
  selector: string
  /** The full calldata: selector followed by the ABI-encoded arguments. */
  calldata: string
}

// ===== ABI parsing =====

/**
 * Parse a user-supplied single-function ABI.
 *
 * Accepts a JSON ABI array, a single JSON fragment object, a bare signature
 * such as `transfer(address,uint256)`, or one signature with the `function`
 * keyword — the same shapes `CalldataDecoder` accepts, minus its tolerance for
 * multiple entries: the encoder needs to know exactly which function to encode.
 *
 * @param abi - The ABI text
 * @returns The function fragment, or a failure carrying a user-presentable message
 */
export function parseFunctionAbi(abi: string): AbiEncodeResult<FunctionFragment> {
  const trimmed = abi.trim()
  if (trimmed === "") {
    return { ok: false, error: "Enter a function ABI or signature." }
  }

  if (trimmed.startsWith("[")) {
    let iface: Interface
    try {
      iface = new Interface(trimmed)
    } catch (cause) {
      return { ok: false, error: `The ABI is not valid JSON ABI: ${describeError(cause)}` }
    }
    return pickSingleFunction(iface)
  }

  if (trimmed.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (cause) {
      return { ok: false, error: `The fragment is not valid JSON: ${describeError(cause)}` }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "The fragment must be a JSON object." }
    }
    let iface: Interface
    try {
      iface = new Interface([parsed])
    } catch (cause) {
      return { ok: false, error: `The fragment is not a valid ABI fragment: ${describeError(cause)}` }
    }
    return pickSingleFunction(iface)
  }

  // Human-readable form: exactly one entry, with the `function` keyword added
  // when absent because ethers requires an explicit fragment keyword.
  const entries = trimmed
    .split(/[\r\n;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (entries.length > 1) {
    return {
      ok: false,
      error: `Enter a single function; got ${entries.length} entries. Remove the extras or use the calldata decoder, which accepts a whole ABI.`,
    }
  }
  const entry = entries[0]
  const signature = /^(function|error|event|constructor|fallback|receive|struct)\b/.test(entry)
    ? entry
    : `function ${entry}`

  let fragment: Fragment
  try {
    fragment = Fragment.from(signature)
  } catch (cause) {
    return {
      ok: false,
      error: `The signature could not be parsed: ${describeError(cause)}`,
    }
  }
  if (fragment.type !== "function") {
    return {
      ok: false,
      error: `This is a ${fragment.type} fragment, not a function. The encoder needs a function.`,
    }
  }
  return { ok: true, value: fragment as FunctionFragment }
}

/**
 * Pick the one function out of a compiled interface.
 *
 * Events and errors in the JSON are harmless and ignored; zero or several
 * functions are not, because both would leave the UI guessing which inputs to
 * render.
 *
 * @param iface - The compiled interface
 * @returns The single function fragment, or a failure carrying a user-presentable message
 */
function pickSingleFunction(iface: Interface): AbiEncodeResult<FunctionFragment> {
  const functions = iface.fragments.filter(
    (fragment): fragment is FunctionFragment => fragment.type === "function"
  )
  if (functions.length === 0) {
    return { ok: false, error: "The ABI does not declare any functions." }
  }
  if (functions.length > 1) {
    const names = functions.map((fragment) => fragment.format("sighash")).join(", ")
    return {
      ok: false,
      error: `The ABI declares ${functions.length} functions (${names}). The encoder needs exactly one; the calldata decoder accepts a whole ABI.`,
    }
  }
  return { ok: true, value: functions[0] }
}

// ===== Argument parsing =====

/**
 * Parse one argument's text (or JSON value) into the JS value `AbiCoder` expects.
 *
 * `raw` is a string for hand-typed input and an already-typed value when it
 * came from a JSON array — which is why large integers are only trusted in
 * string form: `JSON.parse` turns `1000000000000000001` into a `Number` that
 * has already lost precision, and that must be reported, not encoded.
 *
 * @param param - The ABI parameter the value is parsed against
 * @param raw - The raw text or JSON value
 * @param label - How to name the argument in error messages, e.g. `"to"` or `argument #0`
 * @returns The parsed value, or a failure carrying a user-presentable message
 */
export function parseArgumentValue(
  param: ParamType,
  raw: unknown,
  label: string
): AbiEncodeResult<unknown> {
  // Arrays and tuples recurse; every other type is a leaf.
  if (param.isArray()) {
    return parseArrayValue(param, raw, label)
  }
  if (param.isTuple()) {
    return parseTupleValue(param, raw, label)
  }
  return parseLeafValue(param, raw, label)
}

/**
 * Parse an array argument: comma-separated text or a JSON array.
 *
 * @param param - The array parameter
 * @param raw - The raw text or JSON value
 * @param label - How to name the argument in error messages
 * @returns The parsed array, or a failure carrying a user-presentable message
 */
function parseArrayValue(
  param: ParamType & { arrayChildren: ParamType; arrayLength: number },
  raw: unknown,
  label: string
): AbiEncodeResult<unknown> {
  const children = param.arrayChildren
  const expected = param.arrayLength

  let items: readonly unknown[]
  if (typeof raw === "string") {
    const text = raw.trim()
    if (text === "") {
      return { ok: false, error: `${label} (${param.format("sighash")}): enter at least one value.` }
    }
    if (text.startsWith("[")) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (cause) {
        return {
          ok: false,
          error: `${label} (${param.format("sighash")}): the JSON array is not valid: ${describeError(cause)}`,
        }
      }
      if (!Array.isArray(parsed)) {
        return {
          ok: false,
          error: `${label} (${param.format("sighash")}): the value must be a JSON array.`,
        }
      }
      items = parsed
    } else if (children.isArray() || children.baseType === "tuple") {
      return {
        ok: false,
        error: `${label} (${param.format("sighash")}): nested values must be given as a JSON array, e.g. [[1, 2], [3]].`,
      }
    } else {
      items = text.split(",")
    }
  } else if (Array.isArray(raw)) {
    items = raw
  } else {
    return {
      ok: false,
      error: `${label} (${param.format("sighash")}): the value must be an array.`,
    }
  }

  if (expected !== -1 && items.length !== expected) {
    return {
      ok: false,
      error: `${label} (${param.format("sighash")}): expected exactly ${expected} element${expected === 1 ? "" : "s"}, got ${items.length}.`,
    }
  }

  const values: unknown[] = []
  for (const [index, item] of items.entries()) {
    const parsed = parseArgumentValue(children, item, `${label}[${index}]`)
    if (!parsed.ok) {
      return parsed
    }
    values.push(parsed.value)
  }
  return { ok: true, value: values }
}

/**
 * Parse a tuple argument: a JSON array with one entry per component.
 *
 * @param param - The tuple parameter
 * @param raw - The raw text or JSON value
 * @param label - How to name the argument in error messages
 * @returns The parsed tuple as a plain array, or a failure carrying a user-presentable message
 */
function parseTupleValue(
  param: ParamType & { components: ReadonlyArray<ParamType> },
  raw: unknown,
  label: string
): AbiEncodeResult<unknown> {
  const components = param.components
  let items: readonly unknown[]
  if (typeof raw === "string") {
    const text = raw.trim()
    if (!text.startsWith("[")) {
      return {
        ok: false,
        error: `${label} (${param.format("sighash")}): a tuple must be a JSON array with ${components.length} value${components.length === 1 ? "" : "s"}, e.g. ["0x…", 5].`,
      }
    }
    try {
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) {
        return {
          ok: false,
          error: `${label} (${param.format("sighash")}): a tuple must be a JSON array.`,
        }
      }
      items = parsed
    } catch (cause) {
      return {
        ok: false,
        error: `${label} (${param.format("sighash")}): the JSON array is not valid: ${describeError(cause)}`,
      }
    }
  } else if (Array.isArray(raw)) {
    items = raw
  } else {
    return {
      ok: false,
      error: `${label} (${param.format("sighash")}): the value must be a JSON array.`,
    }
  }

  if (items.length !== components.length) {
    return {
      ok: false,
      error: `${label} (${param.format("sighash")}): expected ${components.length} component${components.length === 1 ? "" : "s"}, got ${items.length}.`,
    }
  }

  const values: unknown[] = []
  for (const [index, item] of items.entries()) {
    const parsed = parseArgumentValue(
      components[index],
      item,
      `${label}[${index}]`
    )
    if (!parsed.ok) {
      return parsed
    }
    values.push(parsed.value)
  }
  return { ok: true, value: values }
}

/**
 * Parse a leaf value: address, bool, string, bytesN, or an integer type.
 *
 * @param param - The leaf parameter
 * @param raw - The raw text or JSON value
 * @param label - How to name the argument in error messages
 * @returns The parsed value, or a failure carrying a user-presentable message
 */
function parseLeafValue(
  param: ParamType,
  raw: unknown,
  label: string
): AbiEncodeResult<unknown> {
  const type = param.format("sighash")
  const fail = (message: string): { ok: false; error: string } => ({
    ok: false,
    error: `${label} (${type}): ${message}`,
  })

  if (param.baseType === "address") {
    if (typeof raw !== "string" || raw.trim() === "") {
      return fail("enter a 0x-prefixed address.")
    }
    try {
      return { ok: true, value: getAddress(raw.trim()) }
    } catch {
      return fail(`"${raw.trim()}" is not a valid Ethereum address.`)
    }
  }

  if (param.baseType === "bool") {
    if (typeof raw === "boolean") {
      return { ok: true, value: raw }
    }
    if (typeof raw === "string") {
      const lowered = raw.trim().toLowerCase()
      if (lowered === "true") return { ok: true, value: true }
      if (lowered === "false") return { ok: true, value: false }
    }
    return fail("enter true or false.")
  }

  if (param.baseType === "string") {
    if (typeof raw !== "string") {
      return fail("the value must be a string.")
    }
    return { ok: true, value: raw }
  }

  if (param.baseType.startsWith("bytes")) {
    if (typeof raw !== "string" || raw.trim() === "") {
      return fail("enter 0x-prefixed hex data.")
    }
    const text = raw.trim()
    const match = /^0x([0-9a-fA-F]*)$/.exec(text)
    if (match === null || match[1].length % 2 !== 0) {
      return fail("the value must be 0x-prefixed hexadecimal with a whole number of bytes.")
    }
    const bytes = match[1].length / 2
    if (param.baseType !== "bytes" && bytes !== Number(param.baseType.slice(5))) {
      return fail(`${param.baseType} expects exactly ${param.baseType.slice(5)} byte${param.baseType === "bytes1" ? "" : "s"}, got ${describeByteCount(bytes)}.`)
    }
    return { ok: true, value: text.toLowerCase() }
  }

  if (param.baseType.startsWith("uint") || param.baseType.startsWith("int")) {
    const bits = param.baseType === "uint" || param.baseType === "int" ? 256 : Number(param.baseType.replace(/^u?int/, ""))
    const signed = param.baseType.startsWith("int")

    let text: string
    if (typeof raw === "bigint") {
      text = raw.toString()
    } else if (typeof raw === "number") {
      if (!Number.isSafeInteger(raw)) {
        return fail("this number is too large for JSON; pass it as a string to keep full precision.")
      }
      text = String(raw)
    } else if (typeof raw === "string") {
      text = raw.trim()
    } else {
      return fail("enter a decimal or 0x-hexadecimal integer.")
    }

    if (text === "") {
      return fail("enter a decimal or 0x-hexadecimal integer.")
    }
    if (!/^-?(0x[0-9a-fA-F]+|\d+)$/.test(text)) {
      return fail(`"${text}" is not a decimal or 0x-hexadecimal integer.`)
    }
    let value: bigint
    try {
      value = BigInt(text)
    } catch {
      return fail(`"${text}" is not an integer.`)
    }

    const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n
    const min = signed ? -(2n ** BigInt(bits - 1)) : 0n
    if (value < min || value > max) {
      return fail(`${value.toString()} does not fit in ${param.baseType} (${min.toString()} to ${max.toString()}).`)
    }
    return { ok: true, value }
  }

  return fail("this type is not supported.")
}

// ===== Encoding =====

/**
 * Encode a call to a parsed function.
 *
 * @param fragment - The function fragment, from {@link parseFunctionAbi}
 * @param values - One parsed value per input, positionally aligned
 * @returns The selector and full calldata, or a failure carrying a user-presentable message
 */
export function encodeFunctionCall(
  fragment: FunctionFragment,
  values: readonly unknown[]
): AbiEncodeResult<EncodedCall> {
  const signature = fragment.format("sighash")
  if (values.length !== fragment.inputs.length) {
    return {
      ok: false,
      error: `The function ${signature} takes ${fragment.inputs.length} argument${fragment.inputs.length === 1 ? "" : "s"}, but ${values.length} ${values.length === 1 ? "was" : "were"} provided.`,
    }
  }

  try {
    const encoded = AbiCoder.defaultAbiCoder().encode(fragment.inputs, values)
    return {
      ok: true,
      value: { signature, selector: fragment.selector, calldata: `${fragment.selector}${encoded.slice(2)}` },
    }
  } catch (cause) {
    // Defensive net: per-argument parsing should have caught anything that
    // reaches here, but an AbiCoder failure must still read as a sentence.
    return { ok: false, error: `The arguments could not be encoded: ${describeError(cause)}` }
  }
}

/**
 * Parse an ABI and argument texts and encode the call in one step.
 *
 * Convenience wrapper for callers that do not need to render the inputs
 * themselves; the UI drives {@link parseFunctionAbi} and
 * {@link parseArgumentValue} individually for live per-field feedback.
 *
 * @param abi - The ABI text; see {@link parseFunctionAbi}
 * @param argumentTexts - One raw text per function input
 * @returns The selector and full calldata, or a failure carrying a user-presentable message
 */
export function encodeAbiCall(
  abi: string,
  argumentTexts: readonly string[]
): AbiEncodeResult<EncodedCall> {
  const parsed = parseFunctionAbi(abi)
  if (!parsed.ok) {
    return parsed
  }

  const values: unknown[] = []
  for (const [index, input] of parsed.value.inputs.entries()) {
    const label = input.name !== "" ? `"${input.name}"` : `argument #${index}`
    const value = parseArgumentValue(input, argumentTexts[index] ?? "", label)
    if (!value.ok) {
      return value
    }
    values.push(value.value)
  }
  return encodeFunctionCall(parsed.value, values)
}

// ===== Error helpers =====

/**
 * Pluralise a byte count for an error message.
 *
 * @param byteLength - The number of bytes
 * @returns `"1 byte"` or `"N bytes"`
 */
function describeByteCount(byteLength: number): string {
  return byteLength === 1 ? "1 byte" : `${byteLength} bytes`
}

/**
 * Extract a readable message from an unknown thrown value.
 *
 * @param cause - The thrown value
 * @returns The most specific message available
 */
function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    if ("shortMessage" in cause && typeof cause.shortMessage === "string") {
      return cause.shortMessage
    }
    return cause.message
  }
  return String(cause)
}
