/**
 * ENS forward and reverse resolution.
 *
 * The ENS registry lives on Ethereum mainnet. Names do not resolve on Sepolia,
 * on an L2, or on whatever network the connected wallet happens to be pointing
 * at, so every function here takes a `mainnetProvider` parameter and the caller
 * is responsible for handing it a mainnet provider regardless of the wallet's
 * current selection. Resolving against the wrong chain silently returns
 * "not found", which is exactly the kind of confusing dead end this naming is
 * meant to prevent.
 *
 * The provider is a parameter rather than an import, typed against the minimal
 * structural interface actually used, so this module needs no provider
 * plumbing of its own and is trivial to test with a plain object.
 *
 * No provider rejection ever escapes: every network call is wrapped in a
 * timeout and mapped onto a result variant.
 *
 * This is a leaf module: it imports from `ethers` only.
 */

import { ensNormalize, getAddress, isAddress } from "ethers"

/** The chain ID ENS resolution must run against. */
export const ENS_CHAIN_ID = 1

/** Default per-call timeout, in milliseconds. */
export const DEFAULT_ENS_TIMEOUT_MS = 10000

/**
 * The slice of a provider this module needs.
 *
 * An ethers `AbstractProvider` satisfies this structurally, and so does a hand
 * written object in a test. Whatever is passed **must** be connected to
 * Ethereum mainnet; see the module documentation.
 */
export interface EnsProvider {
  /**
   * Resolve an ENS name to an address.
   *
   * @param name - The ENS name to resolve
   * @returns The address, or null when the name has no resolver or no address record
   */
  resolveName(name: string): Promise<string | null>
  /**
   * Look up the primary ENS name of an address.
   *
   * @param address - The address to look up
   * @returns The reverse record, or null when the address has none
   */
  lookupAddress(address: string): Promise<string | null>
}

/** Options shared by the lookup functions. */
export interface EnsLookupOptions {
  /**
   * Timeout applied to each individual network call, in milliseconds.
   *
   * Defaults to {@link DEFAULT_ENS_TIMEOUT_MS}. A reverse lookup that
   * forward-confirms makes two calls, so its worst case is twice this value.
   */
  timeoutMs?: number
  /**
   * Forward-confirm a reverse record before trusting it. Defaults to true.
   *
   * Only meaningful for {@link lookupEnsAddress}.
   */
  confirmReverseRecord?: boolean
}

/** What a piece of user input turned out to be. */
export type EnsInput =
  /** A well-formed address, EIP-55 checksummed. */
  | { kind: "address"; address: string }
  /** A well-formed ENS name, ENSIP-15 normalized. */
  | { kind: "name"; name: string }
  /** Neither; `error` is a user-presentable sentence. */
  | { kind: "invalid"; error: string }

/** Outcome of resolving a name to an address. */
export type EnsForwardResult =
  /** The name resolves to `address`, EIP-55 checksummed. */
  | { status: "resolved"; name: string; address: string }
  /** The name is well-formed but has no resolver or no address record on mainnet. */
  | { status: "not-found"; name: string }
  /** The input is not a usable ENS name; nothing was sent to the network. */
  | { status: "invalid"; error: string }
  /** The provider did not answer within the timeout. */
  | { status: "timeout"; name: string; timeoutMs: number }
  /** The provider rejected the request. */
  | { status: "error"; name: string; error: string }

/** Outcome of looking up the primary name of an address. */
export type EnsReverseResult =
  /** The address has a reverse record; check `forwardVerified` before trusting `name`. */
  | {
      status: "resolved"
      address: string
      name: string
      /** True only when forward-resolving `name` returned `address`. */
      forwardVerified: boolean
      /** What `name` forward-resolves to, or null when the check was skipped or failed. */
      forwardAddress: string | null
      /** Why the confirmation could not be completed, or null when it ran to a conclusion. */
      verificationError: string | null
    }
  /** The address has no reverse record on mainnet. */
  | { status: "not-found"; address: string }
  /** The input is not a usable address; nothing was sent to the network. */
  | { status: "invalid"; error: string }
  /** The provider did not answer within the timeout. */
  | { status: "timeout"; address: string; timeoutMs: number }
  /** The provider rejected the request. */
  | { status: "error"; address: string; error: string }

/** Outcome of a lookup where the direction was chosen from the input. */
export type EnsLookupResult =
  | { direction: "forward"; result: EnsForwardResult }
  | { direction: "reverse"; result: EnsReverseResult }
  | { direction: "invalid"; error: string }

/** Internal outcome of a single timed network call. */
type TimedOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "error"; message: string }

/**
 * Test whether a string is a well-formed 20-byte hex address with a valid checksum.
 *
 * An all-lowercase or all-uppercase address passes, because it carries no
 * checksum to verify. A mixed-case address with a broken checksum fails, which
 * is what catches a mistyped digit. ICAP addresses are rejected: this is a hex
 * address test only.
 *
 * @param value - The string to test
 * @returns True when `value` is a usable hex address
 */
export function isHexAddress(value: string): boolean {
  const trimmed = value.trim()
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) && isAddress(trimmed)
}

/**
 * Test whether a string looks like an ENS name.
 *
 * Requires at least two non-empty labels, so `foo.eth` passes and `foo` does
 * not; a bare label cannot be resolved usefully in the UI. Leading and trailing
 * dots, empty labels and whitespace are rejected, as is anything ENSIP-15
 * normalization refuses.
 *
 * @param value - The string to test
 * @returns True when `value` is a resolvable ENS name
 */
export function isEnsName(value: string): boolean {
  return normalizeEnsName(value) !== null
}

/**
 * Decide whether user input is an address, an ENS name, or neither.
 *
 * An address is returned EIP-55 checksummed; a name is returned ENSIP-15
 * normalized. Leading and trailing whitespace is trimmed first; whitespace
 * anywhere else is rejected.
 *
 * @param value - The raw user input
 * @returns The classification; see {@link EnsInput}
 */
export function classifyEnsInput(value: string): EnsInput {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { kind: "invalid", error: "Enter an ENS name or an address." }
  }

  if (/^0x/i.test(trimmed)) {
    const address = toChecksumAddress(trimmed)
    return address === null
      ? { kind: "invalid", error: describeInvalidAddress(trimmed) }
      : { kind: "address", address }
  }

  const name = normalizeEnsName(trimmed)
  return name === null
    ? { kind: "invalid", error: describeInvalidEnsName(trimmed) }
    : { kind: "name", name }
}

/**
 * Resolve an ENS name to an address on Ethereum mainnet.
 *
 * @param mainnetProvider - A provider connected to Ethereum mainnet; see {@link EnsProvider}
 * @param name - The ENS name to resolve; normalized and validated first
 * @param options - Optional timeout; see {@link EnsLookupOptions}
 * @returns The outcome; see {@link EnsForwardResult}. Never rejects for a provider failure
 * @throws {RangeError} If `options.timeoutMs` is not a positive finite number
 */
export async function resolveEnsName(
  mainnetProvider: EnsProvider,
  name: string,
  options: EnsLookupOptions = {}
): Promise<EnsForwardResult> {
  const timeoutMs = resolveTimeout(options.timeoutMs)

  const normalized = normalizeEnsName(name)
  if (normalized === null) {
    return { status: "invalid", error: describeInvalidEnsName(name) }
  }

  const outcome = await withTimeout(() => mainnetProvider.resolveName(normalized), timeoutMs)
  if (outcome.status === "timeout") {
    return { status: "timeout", name: normalized, timeoutMs }
  }
  if (outcome.status === "error") {
    return { status: "error", name: normalized, error: outcome.message }
  }
  if (outcome.value === null) {
    return { status: "not-found", name: normalized }
  }

  const address = toChecksumAddress(outcome.value)
  if (address === null) {
    return {
      status: "error",
      name: normalized,
      error: "The resolver returned something that is not a valid address.",
    }
  }
  return { status: "resolved", name: normalized, address }
}

/**
 * Look up the primary ENS name of an address on Ethereum mainnet.
 *
 * A reverse record is set by the address owner and is not authoritative on its
 * own: anyone can point a reverse record at a name they do not control. It is
 * only trustworthy when forward-resolving the returned name yields the original
 * address, so that check is performed by default and its outcome is reported in
 * `forwardVerified`. Do not display a reverse name as verified identity unless
 * that flag is true.
 *
 * @param mainnetProvider - A provider connected to Ethereum mainnet; see {@link EnsProvider}
 * @param address - The address to look up
 * @param options - Optional timeout and confirmation behaviour; see {@link EnsLookupOptions}
 * @returns The outcome; see {@link EnsReverseResult}. Never rejects for a provider failure
 * @throws {RangeError} If `options.timeoutMs` is not a positive finite number
 */
export async function lookupEnsAddress(
  mainnetProvider: EnsProvider,
  address: string,
  options: EnsLookupOptions = {}
): Promise<EnsReverseResult> {
  const timeoutMs = resolveTimeout(options.timeoutMs)
  const { confirmReverseRecord = true } = options

  const checksummed = toChecksumAddress(address)
  if (checksummed === null) {
    return { status: "invalid", error: describeInvalidAddress(address) }
  }

  const outcome = await withTimeout(() => mainnetProvider.lookupAddress(checksummed), timeoutMs)
  if (outcome.status === "timeout") {
    return { status: "timeout", address: checksummed, timeoutMs }
  }
  if (outcome.status === "error") {
    return { status: "error", address: checksummed, error: outcome.message }
  }
  if (outcome.value === null) {
    return { status: "not-found", address: checksummed }
  }

  const name = outcome.value
  if (!confirmReverseRecord) {
    return {
      status: "resolved",
      address: checksummed,
      name,
      forwardVerified: false,
      forwardAddress: null,
      verificationError: "Forward confirmation was skipped, so this name is unverified.",
    }
  }

  const confirmation = await resolveEnsName(mainnetProvider, name, { timeoutMs })
  if (confirmation.status === "resolved") {
    return {
      status: "resolved",
      address: checksummed,
      name,
      forwardVerified: confirmation.address === checksummed,
      forwardAddress: confirmation.address,
      verificationError:
        confirmation.address === checksummed
          ? null
          : "The reverse record points at a name that resolves to a different address, so it cannot be trusted.",
    }
  }

  return {
    status: "resolved",
    address: checksummed,
    name,
    forwardVerified: false,
    forwardAddress: null,
    verificationError: describeFailedConfirmation(confirmation),
  }
}

/**
 * Resolve user input in whichever direction it implies.
 *
 * An ENS name is resolved forward to an address; an address is looked up in
 * reverse to a name.
 *
 * @param mainnetProvider - A provider connected to Ethereum mainnet; see {@link EnsProvider}
 * @param input - The raw user input
 * @param options - Optional timeout and confirmation behaviour; see {@link EnsLookupOptions}
 * @returns The direction taken and its outcome; see {@link EnsLookupResult}
 * @throws {RangeError} If `options.timeoutMs` is not a positive finite number
 */
export async function lookupEns(
  mainnetProvider: EnsProvider,
  input: string,
  options: EnsLookupOptions = {}
): Promise<EnsLookupResult> {
  const classified = classifyEnsInput(input)
  if (classified.kind === "invalid") {
    return { direction: "invalid", error: classified.error }
  }
  if (classified.kind === "address") {
    return {
      direction: "reverse",
      result: await lookupEnsAddress(mainnetProvider, classified.address, options),
    }
  }
  return {
    direction: "forward",
    result: await resolveEnsName(mainnetProvider, classified.name, options),
  }
}

/**
 * Normalize an ENS name, requiring at least two non-empty labels.
 *
 * @param value - The candidate name
 * @returns The ENSIP-15 normalized name, or null when it is not a resolvable ENS name
 */
function normalizeEnsName(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return null
  }
  if (!trimmed.includes(".") || trimmed.startsWith(".") || trimmed.endsWith(".")) {
    return null
  }
  if (/^0x/i.test(trimmed)) {
    return null
  }

  try {
    const normalized = ensNormalize(trimmed)
    const labels = normalized.split(".")
    if (labels.length < 2 || labels.some((label) => label.length === 0)) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

/**
 * Explain why a string is not a usable hex address.
 *
 * @param value - The rejected candidate
 * @returns A user-presentable sentence
 */
function describeInvalidAddress(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return "Enter an address."
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return "That looks like an address, but its checksum is invalid. Check for a mistyped character."
  }
  if (/^0x/i.test(trimmed)) {
    const body = trimmed.slice(2)
    return body.length === 40
      ? "An address must be 0x followed by 40 hex digits, but this one contains characters outside 0-9 and a-f."
      : `An address must be 0x followed by 40 hex digits, but this one has ${body.length}.`
  }
  return "An address must start with 0x and be followed by 40 hex digits."
}

/**
 * Explain why a string is not a usable ENS name.
 *
 * @param value - The rejected candidate
 * @returns A user-presentable sentence
 */
function describeInvalidEnsName(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return "Enter an ENS name."
  }
  if (/\s/.test(trimmed)) {
    return "An ENS name cannot contain spaces."
  }
  if (/^0x/i.test(trimmed)) {
    return "That looks like an address, not an ENS name."
  }
  if (!trimmed.includes(".")) {
    return "An ENS name needs a suffix, for example vitalik.eth."
  }
  if (trimmed.startsWith(".") || trimmed.endsWith(".") || trimmed.includes("..")) {
    return "An ENS name cannot have an empty label or a leading or trailing dot."
  }
  return "That is not a valid ENS name."
}

/**
 * Checksum an address, tolerating surrounding whitespace.
 *
 * @param value - The candidate address
 * @returns The EIP-55 checksummed address, or null when `value` is not a usable hex address
 */
function toChecksumAddress(value: string): string | null {
  const trimmed = value.trim()
  if (!isHexAddress(trimmed)) {
    return null
  }
  try {
    return getAddress(trimmed)
  } catch {
    return null
  }
}

/**
 * Validate a caller-supplied timeout.
 *
 * A bad timeout is a programmer error rather than user input, so it throws.
 *
 * @param timeoutMs - The requested timeout, or undefined for the default
 * @returns The timeout to use, in milliseconds
 * @throws {RangeError} If `timeoutMs` is not a positive finite number
 */
function resolveTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_ENS_TIMEOUT_MS
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number of milliseconds.")
  }
  return timeoutMs
}

/**
 * Run a network call under a timeout, converting any rejection into a value.
 *
 * The work promise is settled before the race, so a provider rejection that
 * arrives after the timeout has already won cannot surface as an unhandled
 * rejection. The timer is always cleared, so a resolved call does not keep the
 * process or the tab awake.
 *
 * @param operation - Starts the network call
 * @param timeoutMs - How long to wait, in milliseconds
 * @returns The outcome; see {@link TimedOutcome}. Never rejects
 */
async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<TimedOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<TimedOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs)
  })

  const work = (async (): Promise<TimedOutcome<T>> => {
    try {
      return { status: "ok", value: await operation() }
    } catch (cause) {
      return { status: "error", message: describeError(cause) }
    }
  })()

  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * Explain why a reverse record could not be forward-confirmed.
 *
 * @param confirmation - The non-resolved forward outcome
 * @returns A user-presentable sentence
 */
function describeFailedConfirmation(confirmation: EnsForwardResult): string {
  switch (confirmation.status) {
    case "not-found":
      return "The reverse record points at a name that does not resolve to any address, so it cannot be trusted."
    case "timeout":
      return "The forward confirmation timed out, so this name is unverified."
    case "invalid":
      return "The reverse record is not a valid ENS name, so it cannot be trusted."
    case "error":
      return `The forward confirmation failed, so this name is unverified: ${confirmation.error}`
    default:
      return "The forward confirmation did not complete, so this name is unverified."
  }
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
