/**
 * Transaction calldata and revert-data decoding.
 *
 * Everything here is pure: no provider, no network, no state. Selectors for the
 * built-in table are derived from their signature strings at module load with
 * `id(...)`, so a hand-typed hex constant can never drift out of sync with the
 * signature it claims to describe.
 *
 * Decoded argument values are always rendered to display-safe strings. A
 * `bigint` becomes a decimal string, so an amount can be shown verbatim without
 * a lossy `Number` conversion anywhere in the UI.
 *
 * This is a leaf module: it imports from `ethers` only.
 */

import { AbiCoder, Fragment, Interface, getAddress, id } from "ethers"
import type { FunctionFragment, ParamType } from "ethers"

/**
 * Outcome of an operation that can legitimately fail because of user input.
 *
 * On failure, `error` is a complete, user-presentable English sentence.
 */
export type CalldataResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * An ABI supplied by the user.
 *
 * Accepts a JSON ABI array (as a string starting with `[`), a single
 * human-readable signature, several signatures separated by newlines or
 * semicolons, or an array of human-readable signatures. A bare signature such
 * as `transfer(address,uint256)` is treated as a function.
 */
export type AbiInput = string | readonly string[]

/** How a decoded call was identified. */
export type DecodeSource = "abi" | "known-selectors"

/** A validated 4-byte selector and the argument payload that follows it. */
export interface CalldataSelector {
  /** The 4-byte selector as lowercase `0x`-prefixed hex (10 characters). */
  selector: string
  /** Everything after the selector as lowercase `0x`-prefixed hex; `"0x"` when there are no arguments. */
  payload: string
  /** Total calldata length in bytes, including the 4 selector bytes. */
  byteLength: number
  /** True when the payload is a whole number of 32-byte words, as a well-formed ABI encoding is. */
  wordAligned: boolean
}

/** One decoded call argument, rendered for display. */
export interface DecodedArgument {
  /** The ABI parameter name, or `arg0`, `arg1`, ... when the ABI omits names. */
  name: string
  /** Canonical Solidity type, e.g. `uint256`, `address`, `(address,uint256)[]`. */
  type: string
  /**
   * Display-safe rendering of the value.
   *
   * Integers are decimal strings, addresses are EIP-55 checksummed, `bytes` are
   * lowercase hex, arrays render as `[a, b]` and tuples as `(a, b)`.
   */
  value: string
}

/** A call whose selector and arguments were both decoded. */
export interface DecodedFunctionCall {
  kind: "function"
  /** The 4-byte selector as lowercase `0x`-prefixed hex. */
  selector: string
  /** The function name, e.g. `transfer`. */
  name: string
  /** The canonical signature, e.g. `transfer(address,uint256)`. */
  signature: string
  /** The decoded arguments in declaration order. */
  args: DecodedArgument[]
  /**
   * Where the match came from.
   *
   * `known-selectors` means the signature came from the local table rather than
   * a user-supplied ABI, so it is a best guess: distinct functions can share a
   * selector.
   */
  source: DecodeSource
}

/** A call that could not be fully decoded, presented as raw 32-byte words. */
export interface RawCall {
  kind: "raw"
  /** The 4-byte selector as lowercase `0x`-prefixed hex. */
  selector: string
  /** The canonical signature when the selector was recognised but its arguments would not decode, otherwise null. */
  signature: string | null
  /** Everything after the selector as lowercase `0x`-prefixed hex. */
  payload: string
  /** The payload split into `0x`-prefixed 32-byte words; a trailing partial word is kept as-is. */
  words: string[]
  /** True when the payload is a whole number of 32-byte words. */
  wordAligned: boolean
  /** A user-presentable explanation of why the arguments are not decoded. */
  note: string
}

/** The outcome of decoding calldata. */
export type DecodedCalldata = DecodedFunctionCall | RawCall

/** The outcome of decoding revert data returned by a failed call. */
export type RevertReason =
  /** The call reverted without any reason data. */
  | { kind: "none" }
  /** A `require(cond, "message")` or `revert("message")`, i.e. `Error(string)`. */
  | { kind: "error-string"; reason: string }
  /** A compiler-generated `Panic(uint256)`. */
  | { kind: "panic"; code: bigint; codeHex: string; description: string }
  /** A custom error matched against the supplied ABI. */
  | { kind: "custom-error"; selector: string; name: string; signature: string; args: DecodedArgument[] }
  /** Revert data whose selector matched nothing available. */
  | { kind: "unknown"; selector: string; payload: string; words: string[] }

/**
 * Human-readable signatures of the common token and multicall functions.
 *
 * Signatures are canonical: no parameter names, no spaces, no return types,
 * which is exactly what the selector is hashed from.
 */
export const KNOWN_SIGNATURES: readonly string[] = [
  // ERC-20
  "totalSupply()",
  "balanceOf(address)",
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "approve(address,uint256)",
  "allowance(address,address)",
  "name()",
  "symbol()",
  "decimals()",
  // ERC-165
  "supportsInterface(bytes4)",
  // ERC-721
  "ownerOf(uint256)",
  "getApproved(uint256)",
  "isApprovedForAll(address,address)",
  "setApprovalForAll(address,bool)",
  "safeTransferFrom(address,address,uint256)",
  "safeTransferFrom(address,address,uint256,bytes)",
  "tokenURI(uint256)",
  // ERC-1155
  "balanceOf(address,uint256)",
  "balanceOfBatch(address[],uint256[])",
  "safeTransferFrom(address,address,uint256,uint256,bytes)",
  "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
  "uri(uint256)",
  // Multicall
  "multicall(bytes[])",
  "multicall(uint256,bytes[])",
]

/**
 * Compute the 4-byte function or error selector of a canonical signature.
 *
 * The signature must already be canonical, e.g. `transfer(address,uint256)`.
 * Parameter names or stray whitespace change the hash and therefore the
 * selector.
 *
 * @param signature - A canonical Solidity signature
 * @returns The selector as lowercase `0x`-prefixed hex (10 characters)
 */
export function computeSelector(signature: string): string {
  return id(signature).slice(0, 10)
}

/**
 * Selector to canonical signature for every entry in {@link KNOWN_SIGNATURES}.
 *
 * Built at module load from the signature strings, so the hex can never drift.
 * Selectors are lowercase `0x`-prefixed hex.
 */
export const KNOWN_SELECTORS: ReadonlyMap<string, string> = buildKnownSelectors()

/** Selector of the standard `Error(string)` revert, i.e. `0x08c379a0`. */
export const ERROR_STRING_SELECTOR = computeSelector("Error(string)")

/** Selector of the compiler-generated `Panic(uint256)` revert, i.e. `0x4e487b71`. */
export const PANIC_SELECTOR = computeSelector("Panic(uint256)")

/**
 * Solidity panic codes and what they mean.
 *
 * These are the codes the compiler emits via `Panic(uint256)`; see the Solidity
 * documentation on error handling.
 */
export const PANIC_CODES: ReadonlyMap<bigint, string> = new Map([
  [0x00n, "Generic compiler-inserted panic."],
  [0x01n, "An assert() condition evaluated to false."],
  [0x11n, "Arithmetic overflow or underflow outside an unchecked block."],
  [0x12n, "Division or modulo by zero."],
  [0x21n, "A value was converted to an enum that has no such member."],
  [0x22n, "A storage byte array is incorrectly encoded."],
  [0x31n, "pop() was called on an empty array."],
  [0x32n, "An array, bytesN or array slice index is out of bounds."],
  [0x41n, "Too much memory was allocated, or an array was created that is too large."],
  [0x51n, "A zero-initialised variable of internal function type was called."],
])

/**
 * Extract and validate the 4-byte function selector from a hex calldata string.
 *
 * The `0x` prefix is optional and case is ignored. Whitespace, including the
 * line breaks that survive copying a blob out of a block explorer, is stripped
 * before validation.
 *
 * @param calldata - Hex calldata, with or without a `0x` prefix
 * @returns The selector and its payload, or a failure carrying a user-presentable message
 */
export function extractSelector(calldata: string): CalldataResult<CalldataSelector> {
  const normalized = normalizeHex(calldata, "Calldata")
  if (!normalized.ok) {
    return normalized
  }

  const hex = normalized.value
  if (hex.length === 0) {
    return { ok: false, error: "Enter some calldata to decode." }
  }
  if (hex.length < 8) {
    const byteLength = hex.length / 2
    return {
      ok: false,
      error: `Calldata must be at least 4 bytes long to contain a function selector, but only ${describeBytes(byteLength)} were given.`,
    }
  }

  const payloadHex = hex.slice(8)
  return {
    ok: true,
    value: {
      selector: `0x${hex.slice(0, 8)}`,
      payload: `0x${payloadHex}`,
      byteLength: hex.length / 2,
      wordAligned: payloadHex.length % 64 === 0,
    },
  }
}

/**
 * Split hex data into `0x`-prefixed 32-byte words for manual inspection.
 *
 * A trailing group shorter than 32 bytes is returned as-is rather than padded,
 * so a malformed payload stays visibly malformed.
 *
 * @param hex - Hex data, with or without a `0x` prefix
 * @returns One entry per 32-byte word; empty when `hex` holds no data
 */
export function splitHexIntoWords(hex: string): string[] {
  const stripped = stripHexPrefix(hex.replace(/\s+/g, "")).toLowerCase()
  const words: string[] = []
  for (let offset = 0; offset < stripped.length; offset += 64) {
    words.push(`0x${stripped.slice(offset, offset + 64)}`)
  }
  return words
}

/**
 * List the canonical function signatures declared by an ABI.
 *
 * Useful for showing the user what a pasted ABI actually contains, and for
 * validating it before a decode is attempted. Non-function fragments such as
 * events and errors are omitted.
 *
 * Signatures come back sorted by signature rather than in declaration order,
 * which is how ethers enumerates an interface.
 *
 * @param abi - The ABI to inspect; see {@link AbiInput}
 * @returns The canonical signatures sorted by signature, or a failure carrying a user-presentable message
 */
export function parseAbiFunctions(abi: AbiInput): CalldataResult<readonly string[]> {
  const created = createInterface(abi)
  if (!created.ok) {
    return created
  }

  const signatures: string[] = []
  created.value.forEachFunction((fragment) => {
    signatures.push(fragment.format("sighash"))
  })
  return { ok: true, value: signatures }
}

/**
 * Decode transaction calldata.
 *
 * When `abi` is supplied it is tried first. If the selector is absent from that
 * ABI, or no ABI was supplied at all, the local {@link KNOWN_SELECTORS} table is
 * consulted; a match there is reported with `source: "known-selectors"` because
 * distinct functions can in principle share a selector.
 *
 * When nothing matches, the call is still returned as a {@link RawCall} carrying
 * the selector and the payload split into 32-byte words, which is enough to
 * eyeball an unknown call by hand.
 *
 * @param calldata - Hex calldata, with or without a `0x` prefix
 * @param abi - Optional ABI or signature list to decode against; see {@link AbiInput}
 * @returns The decoded call, or a failure when the calldata or the ABI is unusable
 */
export function decodeCalldata(calldata: string, abi?: AbiInput): CalldataResult<DecodedCalldata> {
  const extracted = extractSelector(calldata)
  if (!extracted.ok) {
    return extracted
  }

  const { selector, payload, wordAligned } = extracted.value
  const fullCalldata = `${selector}${stripHexPrefix(payload)}`

  if (abi !== undefined) {
    const created = createInterface(abi)
    if (!created.ok) {
      return created
    }
    const decoded = decodeWithInterface(created.value, selector, fullCalldata, "abi")
    if (decoded !== null) {
      return { ok: true, value: decoded }
    }
  }

  const knownSignature = KNOWN_SELECTORS.get(selector)
  if (knownSignature !== undefined) {
    const created = createInterface([knownSignature])
    if (created.ok) {
      const decoded = decodeWithInterface(created.value, selector, fullCalldata, "known-selectors")
      if (decoded !== null) {
        return { ok: true, value: decoded }
      }
    }
    return {
      ok: true,
      value: {
        kind: "raw",
        selector,
        signature: knownSignature,
        payload,
        words: splitHexIntoWords(payload),
        wordAligned,
        note: `The selector matches ${knownSignature}, but the arguments do not decode against it. The payload is shown as raw 32-byte words.`,
      },
    }
  }

  return {
    ok: true,
    value: {
      kind: "raw",
      selector,
      signature: null,
      payload,
      words: splitHexIntoWords(payload),
      wordAligned,
      note:
        abi === undefined
          ? "This selector is not in the built-in table. Supply an ABI to decode the arguments; until then the payload is shown as raw 32-byte words."
          : "This selector is in neither the supplied ABI nor the built-in table. The payload is shown as raw 32-byte words.",
    },
  }
}

/**
 * Decode the revert data returned by a failed call.
 *
 * Handles the standard `Error(string)` and `Panic(uint256)` envelopes, and
 * matches custom errors when an ABI is supplied. Empty data is reported as
 * `kind: "none"`, which is what a bare `revert()`, an `assert` in an old
 * compiler, or an out-of-gas failure looks like.
 *
 * @param data - The returned error data as hex, with or without a `0x` prefix
 * @param abi - Optional ABI to match custom errors against; see {@link AbiInput}
 * @returns The revert reason, or a failure when the data is not usable hex
 */
export function decodeRevertReason(data: string, abi?: AbiInput): CalldataResult<RevertReason> {
  const normalized = normalizeHex(data, "Revert data")
  if (!normalized.ok) {
    return normalized
  }

  const hex = normalized.value
  if (hex.length === 0) {
    return { ok: true, value: { kind: "none" } }
  }
  if (hex.length < 8) {
    return {
      ok: false,
      error: `Revert data must be empty or at least 4 bytes long, but ${describeBytes(hex.length / 2)} were given.`,
    }
  }

  const selector = `0x${hex.slice(0, 8)}`
  const payload = `0x${hex.slice(8)}`

  if (selector === ERROR_STRING_SELECTOR) {
    const decoded = decodeSingleAbiValue("string", payload)
    if (decoded === null || typeof decoded !== "string") {
      return {
        ok: false,
        error: "The revert data is tagged as Error(string) but its message could not be decoded.",
      }
    }
    return { ok: true, value: { kind: "error-string", reason: decoded } }
  }

  if (selector === PANIC_SELECTOR) {
    const decoded = decodeSingleAbiValue("uint256", payload)
    if (decoded === null || typeof decoded !== "bigint") {
      return {
        ok: false,
        error: "The revert data is tagged as Panic(uint256) but its code could not be decoded.",
      }
    }
    return {
      ok: true,
      value: {
        kind: "panic",
        code: decoded,
        codeHex: `0x${decoded.toString(16).padStart(2, "0")}`,
        description:
          PANIC_CODES.get(decoded) ?? "Unrecognised panic code; check the Solidity release notes.",
      },
    }
  }

  if (abi !== undefined) {
    const created = createInterface(abi)
    if (!created.ok) {
      return created
    }
    const custom = decodeCustomError(created.value, selector, `${selector}${hex.slice(8)}`)
    if (custom !== null) {
      return { ok: true, value: custom }
    }
  }

  return {
    ok: true,
    value: { kind: "unknown", selector, payload, words: splitHexIntoWords(payload) },
  }
}

/**
 * Build the selector table from {@link KNOWN_SIGNATURES}.
 *
 * The first signature wins if two ever hash to the same selector, so the table
 * stays deterministic rather than throwing at module load and breaking the app.
 *
 * @returns Selector to canonical signature
 */
function buildKnownSelectors(): ReadonlyMap<string, string> {
  const table = new Map<string, string>()
  for (const signature of KNOWN_SIGNATURES) {
    const selector = computeSelector(signature)
    if (!table.has(selector)) {
      table.set(selector, signature)
    }
  }
  return table
}

/**
 * Build an ethers `Interface` from a user-supplied ABI.
 *
 * Human-readable entries are validated one at a time, because the `Interface`
 * constructor drops a fragment it cannot parse and only writes a console
 * warning; without this check a typo would silently vanish from the decode
 * instead of being reported. A JSON ABI is passed through to ethers, since
 * older ABIs legitimately contain fragments ethers skips, but an ABI that
 * yields nothing usable at all is reported rather than silently accepted.
 *
 * @param abi - The ABI to compile; see {@link AbiInput}
 * @returns The interface, or a failure carrying a user-presentable message
 */
function createInterface(abi: AbiInput): CalldataResult<Interface> {
  if (typeof abi === "string" && abi.trim().startsWith("[")) {
    let fromJson: Interface
    try {
      fromJson = new Interface(abi.trim())
    } catch (cause) {
      return { ok: false, error: `The ABI is not valid JSON ABI: ${describeError(cause)}` }
    }
    if (fromJson.fragments.length === 0) {
      return { ok: false, error: "The JSON ABI does not declare any usable fragments." }
    }
    return { ok: true, value: fromJson }
  }

  const entries = typeof abi === "string" ? splitSignatures(abi) : abi
  if (entries.length === 0) {
    return { ok: false, error: "The ABI is empty." }
  }

  const fragments: Fragment[] = []
  for (const entry of entries) {
    try {
      fragments.push(Fragment.from(withFragmentKeyword(entry)))
    } catch (cause) {
      return {
        ok: false,
        error: `The ABI could not be parsed at "${entry}": ${describeError(cause)}`,
      }
    }
  }

  try {
    return { ok: true, value: new Interface(fragments) }
  } catch (cause) {
    return { ok: false, error: `The ABI could not be parsed: ${describeError(cause)}` }
  }
}

/**
 * Split a pasted block of human-readable signatures into individual entries.
 *
 * @param abi - Signatures separated by line breaks or semicolons
 * @returns The non-empty trimmed entries
 */
function splitSignatures(abi: string): readonly string[] {
  return abi
    .split(/[\r\n;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Prepend `function ` to a bare signature, since ethers requires an explicit
 * fragment keyword in human-readable ABIs.
 *
 * @param signature - A human-readable signature, with or without a keyword
 * @returns The signature with a fragment keyword
 */
function withFragmentKeyword(signature: string): string {
  return /^(function|error|event|constructor|fallback|receive|struct)\b/.test(signature)
    ? signature
    : `function ${signature}`
}

/**
 * Decode calldata against a compiled interface.
 *
 * @param iface - The compiled interface
 * @param selector - The 4-byte selector as lowercase `0x`-prefixed hex
 * @param calldata - The full normalized calldata as `0x`-prefixed hex
 * @param source - Where the interface came from
 * @returns The decoded call, or null when the selector is absent or the arguments will not decode
 */
function decodeWithInterface(
  iface: Interface,
  selector: string,
  calldata: string,
  source: DecodeSource
): DecodedFunctionCall | null {
  let fragment: FunctionFragment | null = null
  try {
    fragment = iface.getFunction(selector)
  } catch {
    return null
  }
  if (fragment === null) {
    return null
  }

  try {
    const decoded = iface.decodeFunctionData(fragment, calldata)
    return {
      kind: "function",
      selector,
      name: fragment.name,
      signature: fragment.format("sighash"),
      args: buildArguments(fragment.inputs, decoded),
      source,
    }
  } catch {
    return null
  }
}

/**
 * Decode revert data as a custom error declared by an interface.
 *
 * @param iface - The compiled interface
 * @param selector - The 4-byte selector as lowercase `0x`-prefixed hex
 * @param data - The full normalized revert data as `0x`-prefixed hex
 * @returns The decoded custom error, or null when it does not match
 */
function decodeCustomError(
  iface: Interface,
  selector: string,
  data: string
): Extract<RevertReason, { kind: "custom-error" }> | null {
  try {
    const described = iface.parseError(data)
    if (described === null) {
      return null
    }
    return {
      kind: "custom-error",
      selector,
      name: described.name,
      signature: described.fragment.format("sighash"),
      args: buildArguments(described.fragment.inputs, described.args),
    }
  } catch {
    return null
  }
}

/**
 * Decode a single ABI value from a payload.
 *
 * @param type - The Solidity type to decode
 * @param payload - The `0x`-prefixed payload following the selector
 * @returns The decoded value, or null when the payload will not decode
 */
function decodeSingleAbiValue(type: string, payload: string): unknown {
  try {
    const decoded = AbiCoder.defaultAbiCoder().decode([type], payload)
    return decoded.length === 1 ? decoded[0] : null
  } catch {
    return null
  }
}

/**
 * Render decoded values into display-safe {@link DecodedArgument} entries.
 *
 * @param inputs - The ABI parameter definitions
 * @param values - The decoded values, positionally aligned with `inputs`
 * @returns One entry per parameter
 */
function buildArguments(
  inputs: readonly ParamType[],
  values: ArrayLike<unknown>
): DecodedArgument[] {
  return inputs.map((input, index) => ({
    name: input.name.length > 0 ? input.name : `arg${index}`,
    type: input.format("sighash"),
    value: renderAbiValue(values[index], input),
  }))
}

/**
 * Render one decoded ABI value as a display-safe string.
 *
 * Integers become decimal strings so no `Number` conversion is ever needed,
 * addresses are EIP-55 checksummed, `bytes` are lowercase hex, arrays render as
 * `[a, b]` and tuples as `(a, b)`, both recursively.
 *
 * @param value - The decoded value
 * @param type - The parameter definition, or null when the type is unknown
 * @returns The rendered value
 */
function renderAbiValue(value: unknown, type: ParamType | null): string {
  if (typeof value === "bigint") {
    return value.toString()
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false"
  }
  if (typeof value === "number") {
    return value.toString()
  }
  if (typeof value === "string") {
    return renderStringValue(value, type)
  }
  if (Array.isArray(value)) {
    const arrayChildren = type === null ? null : type.arrayChildren
    if (arrayChildren !== null) {
      const items = value.map((item: unknown) => renderAbiValue(item, arrayChildren))
      return `[${items.join(", ")}]`
    }

    const components = type === null ? null : type.components
    if (components !== null) {
      const items = value.map((item: unknown, index: number) =>
        renderAbiValue(item, index < components.length ? components[index] : null)
      )
      return `(${items.join(", ")})`
    }

    const items = value.map((item: unknown) => renderAbiValue(item, null))
    return `[${items.join(", ")}]`
  }
  if (value === null) {
    return "null"
  }
  if (value === undefined) {
    return ""
  }
  return String(value)
}

/**
 * Normalize a decoded string value for display.
 *
 * @param value - The decoded string
 * @param type - The parameter definition, or null when the type is unknown
 * @returns A checksummed address, lowercase hex for byte types, or the string unchanged
 */
function renderStringValue(value: string, type: ParamType | null): string {
  const solidityType = type === null ? "" : type.type

  if (solidityType === "address" || (solidityType === "" && isAddressShaped(value))) {
    try {
      return getAddress(value)
    } catch {
      return value
    }
  }
  if (solidityType === "bytes" || /^bytes([1-9]|[12][0-9]|3[0-2])$/.test(solidityType)) {
    return value.toLowerCase()
  }
  return value
}

/**
 * Test whether a string has the shape of a 20-byte hex address.
 *
 * @param value - The string to test
 * @returns True when `value` is `0x` followed by exactly 40 hex digits
 */
function isAddressShaped(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}

/**
 * Validate and normalize a hex string.
 *
 * Whitespace is stripped, an optional `0x` prefix is removed and the remainder
 * is lowercased. Non-hex characters and an odd digit count are rejected, in
 * that order, so the message names the more fundamental problem first.
 *
 * @param input - The hex string to normalize
 * @param label - How to refer to the input in error messages
 * @returns Lowercase hex without a `0x` prefix, possibly empty, or a failure carrying a user-presentable message
 */
function normalizeHex(input: string, label: string): CalldataResult<string> {
  const compact = input.replace(/\s+/g, "")
  const body = stripHexPrefix(compact).toLowerCase()

  if (!/^[0-9a-f]*$/.test(body)) {
    return {
      ok: false,
      error: `${label} must be hexadecimal, but it contains characters outside 0-9 and a-f.`,
    }
  }
  if (body.length % 2 !== 0) {
    return {
      ok: false,
      error: `${label} has an odd number of hex digits (${body.length}), so it does not describe whole bytes.`,
    }
  }
  return { ok: true, value: body }
}

/**
 * Remove a leading `0x` or `0X` prefix.
 *
 * @param value - The hex string
 * @returns `value` without its prefix
 */
function stripHexPrefix(value: string): string {
  return /^0x/i.test(value) ? value.slice(2) : value
}

/**
 * Pluralise a byte count for an error message.
 *
 * @param byteLength - The number of bytes
 * @returns `"1 byte"` or `"N bytes"`
 */
function describeBytes(byteLength: number): string {
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
