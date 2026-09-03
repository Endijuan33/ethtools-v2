
/**
 * Read-only contract calls — a safe inspector, never a transaction sender.
 *
 * The split mirrors `lib/gasTracker.ts`: pure, synchronous ABI parsing and
 * result formatting that are unit-testable with plain fixtures, plus one thin
 * async call that encodes with `Interface.encodeFunctionData`, sends it via
 * `provider.call`, and decodes with `Interface.decodeFunctionResult`.
 *
 * Only `view` and `pure` functions are callable. State-changing functions are
 * parsed and listed as unsupported — a tool that silently hid `transfer` would
 * leave the user wondering whether the ABI was wrong, and a tool that could
 * *call* it would be a transaction sender wearing an inspector's badge.
 */

import { Fragment, getAddress, hexlify, Interface, isAddress } from "ethers"
import type { FunctionFragment, ParamType, Result } from "ethers"
import { RpcError, withProvider, type Network } from "./ethers"
import { decodeRevertReason } from "./calldata"
import { parseArgumentValue } from "./abiEncode"
import { describeError } from "./logger"

// ===== Types =====

/**
 * Outcome of an operation that can legitimately fail because of user input.
 *
 * On failure, `error` is a complete, user-presentable English sentence.
 */
export type ContractReadResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** One ABI parameter, kept as plain data so results can be rendered without ethers. */
export interface CallParam {
  /** Parameter name; empty string when the ABI omits it. */
  name: string
  /** Canonical Solidity type, e.g. `uint256`, `address`, `(uint256,address)[]`. */
  type: string
  /** Tuple components, present only for tuple (and tuple-array) types. */
  components?: CallParam[]
}

/** A `view` or `pure` function extracted from a user-supplied ABI. */
export interface ReadFunction {
  /** Function name, e.g. `balanceOf`. */
  name: string
  /** 4-byte selector as lowercase `0x`-prefixed hex. */
  selector: string
  /** Canonical signature, e.g. `balanceOf(address)`. */
  signature: string
  /**
   * Full human-readable form including outputs, e.g.
   * `function balanceOf(address account) view returns (uint256)`.
   *
   * Enough to rebuild a working `Interface` at call time, so the parsed form
   * can live in component state as plain data.
   */
  readable: string
  /** `view` or `pure`. */
  stateMutability: string
  inputs: CallParam[]
  outputs: CallParam[]
}

/** A state-changing function the playground refuses to call. */
export interface UnsupportedFunction {
  name: string
  signature: string
  stateMutability: string
}

/** What a parsed ABI contains. */
export interface ParsedAbi {
  /** Callable read functions, in ABI declaration order. */
  functions: ReadFunction[]
  /** State-changing functions, listed so the user knows they were seen. */
  unsupported: UnsupportedFunction[]
}

/** One rendered return value. */
export interface CallOutput {
  /** Output name, or `output 0`, `output 1`, … when the ABI omits names. */
  name: string
  /** Canonical Solidity type of the output. */
  type: string
  /** Human-readable rendering; see {@link formatCallResult}. */
  value: string
}

/** A completed view call. */
export type ViewCallOutcome = ContractReadResult<CallOutput[]>

// ===== Pure: ABI parsing =====

/**
 * Parse an ABI and split its functions into callable reads and unsupported writes.
 *
 * Accepts a JSON array of fragments or a single JSON fragment object. Events,
 * errors and constructors are ignored. Invalid JSON, a non-object fragment, or
 * an array ethers cannot compile all produce precise errors rather than a
 * silent empty result.
 *
 * @param abiText - Raw ABI text
 * @returns The parsed functions, or a failure carrying a user-presentable message
 */
export function parseAbiFunctions(abiText: string): ContractReadResult<ParsedAbi> {
  const trimmed = abiText.trim()
  if (trimmed === "") {
    return { ok: false, error: "Enter a contract ABI as a JSON array of fragments." }
  }

  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return {
      ok: false,
      error: "The ABI must be a JSON array of fragments or a single fragment object.",
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (cause) {
    return {
      ok: false,
      error: `The ABI is not valid JSON: ${describeError(cause, "Check that it is one JSON array of ABI fragments.")}`,
    }
  }

  // A leading "[" can only parse to an array; anything else is a single
  // fragment object, which is wrapped so both shapes share one path.
  const fragmentsInput: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
  for (const entry of fragmentsInput) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "Every ABI fragment must be a JSON object." }
    }
  }

  // Each entry is parsed individually rather than being handed to the
  // Interface constructor in bulk: ethers drops a fragment it cannot parse
  // with only a console warning, so a typo would silently vanish from the
  // function list instead of being reported.
  const fragments: Fragment[] = []
  for (const [index, entry] of fragmentsInput.entries()) {
    try {
      fragments.push(Fragment.from(entry as Record<string, unknown>))
    } catch (cause) {
      return {
        ok: false,
        error: `The ABI could not be parsed at entry ${index}: ${describeError(cause, "Check that every entry is a valid ABI fragment.")}`,
      }
    }
  }
  if (fragments.length === 0) {
    return { ok: false, error: "The ABI does not declare any usable fragments." }
  }

  let iface: Interface
  try {
    iface = new Interface(fragments)
  } catch (cause) {
    return {
      ok: false,
      error: `The ABI is not a valid contract ABI: ${describeError(cause, "Check that every entry is a valid ABI fragment.")}`,
    }
  }

  const functions: ReadFunction[] = []
  const unsupported: UnsupportedFunction[] = []
  for (const fragment of iface.fragments) {
    if (fragment.type !== "function") continue
    const fn = fragment as FunctionFragment
    const entry = {
      name: fn.name,
      signature: fn.format("sighash"),
      stateMutability: fn.stateMutability,
    }
    if (fn.stateMutability === "view" || fn.stateMutability === "pure") {
      functions.push({
        ...entry,
        selector: fn.selector,
        readable: fn.format("full"),
        inputs: fn.inputs.map(toCallParam),
        outputs: fn.outputs.map(toCallParam),
      })
    } else {
      unsupported.push(entry)
    }
  }

  return { ok: true, value: { functions, unsupported } }
}

/**
 * Convert one ethers parameter into plain data.
 *
 * @param param - The ethers parameter
 * @returns The plain parameter, with tuple components converted recursively
 */
function toCallParam(param: ParamType): CallParam {
  const converted: CallParam = {
    name: param.name,
    type: param.format("sighash"),
  }
  // Only tuples have components; copying them for every type would embed an
  // empty array where `undefined` is the honest answer.
  if (param.baseType === "tuple" && param.components !== null) {
    converted.components = param.components.map(toCallParam)
  }
  return converted
}

// ===== Pure: result formatting =====

/**
 * Render one decoded value for display.
 *
 * Integers become decimal strings (a `bigint` is never routed through
 * `Number`), addresses are EIP-55 checksummed, `bool` becomes `true`/`false`,
 * byte types become lowercase hex, and strings pass through. Arrays and tuples
 * are composed as JSON structures whose leaves follow these same rules, then
 * stringified once — so a tuple array renders as `[{"amount":"7"}]`, not as
 * JSON text nested inside JSON text.
 *
 * @param value - One decoded value
 * @param param - The parameter describing the value's type
 * @returns The rendered string
 */
function renderValue(value: unknown, param: CallParam | null): string {
  const rendered = renderJson(value, param)
  return typeof rendered === "string" ? rendered : JSON.stringify(rendered)
}

/**
 * Render one decoded value as display text or a JSON-ready structure.
 *
 * @param value - One decoded value
 * @param param - The parameter describing the value's type
 * @returns A string for scalars, an array or object for containers
 */
function renderJson(
  value: unknown,
  param: CallParam | null
): string | unknown[] | { [key: string]: unknown } {
  const type = param === null ? "" : param.type

  // Arrays first: dynamic ("uint256[]"), fixed ("bytes32[2]"), and nested
  // combinations all end in a bracket group. The child type is the same
  // string minus the final group, which stays correct for nesting.
  const arrayMatch = /^(.*)\[\d*]$/.exec(type)
  if (arrayMatch !== null && Array.isArray(value)) {
    const child: CallParam = { name: "", type: arrayMatch[1], components: param?.components }
    return value.map((item: unknown) => renderJson(item, child))
  }

  // Tuples: an object keyed by component name (or position when unnamed).
  if (type.startsWith("(") && param !== null && Array.isArray(value)) {
    const components = param.components ?? []
    const entries = value.map(
      (item: unknown, index: number) =>
        [
          components[index]?.name || `field${index}`,
          renderJson(item, components[index] ?? null),
        ] as const
    )
    return Object.fromEntries(entries)
  }

  if (type === "address" && typeof value === "string") {
    try {
      return getAddress(value)
    } catch {
      return value
    }
  }

  if (/^bytes([1-9]|[12][0-9]|3[0-2])?$/.test(type)) {
    if (typeof value === "string") return value.toLowerCase()
    if (value instanceof Uint8Array) return hexlify(value).toLowerCase()
  }

  if (/^u?int\d*$/.test(type)) {
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "number") return value.toString()
  }

  if (type === "bool") {
    return value === true ? "true" : value === false ? "false" : String(value)
  }

  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) return hexlify(value).toLowerCase()
  return String(value)
}

/**
 * Render a decoded call result, one string per declared output.
 *
 * @param value - The decoded result from `Interface.decodeFunctionResult`
 * @param outputs - The function's declared outputs
 * @returns One human-readable string per output
 */
export function formatCallResult(value: Result, outputs: readonly CallParam[]): string[] {
  return outputs.map((output, index) => renderValue(value[index], output))
}

// ===== Async: the call =====

/**
 * Call a read-only contract function and render its outputs.
 *
 * Argument text is parsed here rather than in the UI so the defensive boundary
 * is this module: an argument that does not match its declared type produces a
 * user-safe error naming the argument, never a thrown library exception.
 *
 * @param network - Network key to call on
 * @param contractAddress - The contract to call
 * @param read - The parsed function to call
 * @param args - Raw argument text, one entry per input, in order
 * @param signal - Optional cancellation signal
 * @returns The rendered outputs, or a failure carrying a user-presentable message
 */
export async function callViewFunction(
  network: Network,
  contractAddress: string,
  read: ReadFunction,
  args: readonly string[],
  signal?: AbortSignal
): Promise<ViewCallOutcome> {
  const trimmedAddress = contractAddress.trim()
  if (!isAddress(trimmedAddress)) {
    return { ok: false, error: "Enter a valid contract address." }
  }
  const to = getAddress(trimmedAddress)

  let iface: Interface
  try {
    iface = new Interface([read.readable])
  } catch {
    return { ok: false, error: "The function could not be rebuilt from the parsed ABI." }
  }

  const fragment = iface.getFunction(read.signature)
  if (fragment === null) {
    return { ok: false, error: "The function is not present in the parsed ABI." }
  }

  if (args.length !== fragment.inputs.length) {
    return {
      ok: false,
      error: `Expected ${fragment.inputs.length} argument${fragment.inputs.length === 1 ? "" : "s"}, got ${args.length}.`,
    }
  }

  const values: unknown[] = []
  for (const [index, param] of fragment.inputs.entries()) {
    const label = param.name !== "" ? param.name : `argument #${index}`
    const parsed = parseArgumentValue(param, args[index] ?? "", label)
    if (!parsed.ok) {
      return { ok: false, error: parsed.error }
    }
    values.push(parsed.value)
  }

  let data: string
  try {
    data = iface.encodeFunctionData(fragment, values)
  } catch (cause) {
    return { ok: false, error: describeError(cause, "The arguments could not be encoded.") }
  }

  let raw: string
  try {
    raw = await withProvider(network, (provider) => provider.call({ to, data }), signal)
  } catch (cause) {
    return { ok: false, error: describeCallFailure(cause, read.readable) }
  }

  if (raw === "0x") {
    return {
      ok: false,
      error: "The call returned no data. The address may have no contract code on this network.",
    }
  }

  let decoded: Result
  try {
    decoded = iface.decodeFunctionResult(fragment, raw)
  } catch {
    return {
      ok: false,
      error: "The contract returned data that does not match this function's declared outputs.",
    }
  }

  const rendered = formatCallResult(decoded, read.outputs)
  return {
    ok: true,
    value: read.outputs.map((output, index) => ({
      name: output.name !== "" ? output.name : `output ${index}`,
      type: output.type,
      value: rendered[index],
    })),
  }
}

/**
 * Map a failed `provider.call` to a user-safe message.
 *
 * A revert reason is extracted when the data carries one, because "execution
 * reverted" alone is useless for debugging a contract interaction — the
 * contract usually said exactly why.
 *
 * @param cause - The thrown error
 * @param readableAbi - The called function's readable form, for custom-error decoding
 * @returns A user-presentable message
 */
function describeCallFailure(cause: unknown, readableAbi: string): string {
  if (cause instanceof RpcError) return cause.userMessage

  const data = (cause as { data?: unknown }).data
  if (typeof data === "string" && data.length >= 10) {
    const reason = decodeRevertReason(data, [readableAbi])
    if (reason.ok) {
      if (reason.value.kind === "error-string") {
        return `The contract reverted: ${reason.value.reason}`
      }
      if (reason.value.kind === "panic") {
        return `The contract panicked: ${reason.value.description}`
      }
      if (reason.value.kind === "custom-error") {
        return `The contract reverted with ${reason.value.signature}.`
      }
    }
    return "The contract reverted without a reason."
  }

  const message = cause instanceof Error ? cause.message : ""
  if (message.includes("revert")) {
    return "The contract reverted without a reason."
  }
  return describeError(cause, "The call could not be made. Check your connection and try again.")
}
