/**
 * Application logger with mandatory secret redaction.
 *
 * Raw `console.*` calls are banned in this codebase for two reasons:
 *
 * 1. **Secret leakage.** A logged error object can carry a mnemonic, a private
 *    key, or an RPC URL containing an API key. Browser consoles persist, are
 *    readable by extensions, and are captured verbatim by session-replay and
 *    error-reporting tools. Every value passing through this module is scrubbed.
 * 2. **Noise in production.** Debug and info output is dropped outside
 *    development; warnings and errors are kept because they are actionable.
 *
 * The redaction is deliberately aggressive: it would rather mangle a harmless
 * string than let a 64-character hex key through.
 */

/** Severity levels, ordered from least to most severe. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const

/** A severity level. */
export type LogLevel = (typeof LOG_LEVELS)[number]

/** Structured context attached to a log entry. Values are redacted. */
export type LogContext = Readonly<Record<string, unknown>>

/** Placeholder substituted for anything that looks secret. */
export const REDACTED = "[redacted]"

/**
 * Patterns that must never reach the console.
 *
 * Ordered most specific first, so a private key is replaced by the dedicated
 * 64-hex rule before the generic blob rule can see it.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // 32-byte hex, with or without 0x: private keys and raw seeds.
  /\b(?:0x)?[0-9a-fA-F]{64}\b/g,
  // 64-byte hex: extended keys and signatures.
  /\b(?:0x)?[0-9a-fA-F]{128}\b/g,
  // API keys embedded in an RPC path, e.g. /v3/<32 hex>.
  /\/v[0-9]+\/[A-Za-z0-9_-]{16,}/g,
  // Query-string credentials.
  /([?&](?:api[-_]?key|key|token|secret|auth|password)=)[^&\s]+/gi,
]

/**
 * Long opaque blobs that are probably key material.
 *
 * Applied after {@link SECRET_PATTERNS} and deliberately **not** applied to pure
 * hex. A 40-character hex run is an Ethereum address, which is public information
 * and is the single most useful field for diagnosing which account a failure
 * concerns. Key-length hex is already gone by this point, so skipping hex here
 * loses no secrecy while keeping logs readable.
 */
const OPAQUE_BLOB = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g

/**
 * Whether a string is hexadecimal, ignoring an optional `0x` prefix.
 *
 * The prefix must be tolerated because {@link OPAQUE_BLOB} matches across it: the
 * run it captures for an address starts at the `0` of `0x`.
 */
function isPureHex(value: string): boolean {
  const body = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value
  return body.length > 0 && /^[0-9a-fA-F]+$/.test(body)
}

/**
 * Keys whose values are always replaced, regardless of shape.
 *
 * Matched case-insensitively against a substring of the key name, so
 * `mnemonicPassphrase` and `MNEMONIC` are both caught.
 */
const SECRET_KEY_HINTS: readonly string[] = [
  "mnemonic",
  "phrase",
  "privatekey",
  "private_key",
  "secret",
  "seed",
  "password",
  "passphrase",
  "entropy",
  "apikey",
  "api_key",
  "token",
  "auth",
  "credential",
  "signature",
  "vault",
]

/** Maximum characters retained from any single string value. */
const MAX_STRING_LENGTH = 512

/** Maximum depth walked when redacting a nested structure. */
const MAX_DEPTH = 4

/** Maximum array entries retained. */
const MAX_ARRAY_ITEMS = 20

function keyLooksSecret(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z_]/g, "")
  return SECRET_KEY_HINTS.some((hint) => normalized.includes(hint.replace(/[^a-z_]/g, "")))
}

/**
 * Scrub secret-looking substrings from a string.
 *
 * @param value - Text that may embed key material.
 */
export function redactString(value: string): string {
  let out = value
  for (const pattern of SECRET_PATTERNS) {
    // Patterns carry the global flag; reset so repeated use is deterministic.
    pattern.lastIndex = 0
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED
    )
  }

  OPAQUE_BLOB.lastIndex = 0
  out = out.replace(OPAQUE_BLOB, (match) => (isPureHex(match) ? match : REDACTED))

  return out.length > MAX_STRING_LENGTH ? `${out.slice(0, MAX_STRING_LENGTH)}…` : out
}

/**
 * Recursively scrub a value of any shape.
 *
 * Bounded in depth, array length, and string length so a hostile or merely huge
 * object cannot stall the main thread or flood the console.
 *
 * @param value - Arbitrary value to scrub.
 * @param depth - Internal recursion counter.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (depth >= MAX_DEPTH) return "[truncated]"

  switch (typeof value) {
    case "string":
      return redactString(value)
    case "number":
    case "boolean":
      return value
    case "bigint":
      return `${value.toString()}n`
    case "function":
      return "[function]"
    case "symbol":
      return "[symbol]"
    default:
      break
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      // Stacks routinely embed argument values, so scrub them too.
      stack: value.stack === undefined ? undefined : redactString(value.stack),
    }
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`…${value.length - MAX_ARRAY_ITEMS} more`)
    return items
  }

  if (value instanceof Map) return `[Map size=${value.size}]`
  if (value instanceof Set) return `[Set size=${value.size}]`

  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = keyLooksSecret(key) ? REDACTED : redactValue(entry, depth + 1)
    }
    return out
  }

  return "[unknown]"
}

/** A sink that receives finished log entries. */
export interface LogSink {
  (level: LogLevel, message: string, context?: LogContext): void
}

const isDevelopment = process.env.NODE_ENV !== "production"

/** Levels emitted in the current environment. */
function isEnabled(level: LogLevel): boolean {
  if (isDevelopment) return true
  // Debug and info are noise in production; warnings and errors are actionable.
  return level === "warn" || level === "error"
}

const consoleSink: LogSink = (level, message, context) => {
  const method =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "info"
          ? console.info
          : console.debug

  if (context === undefined) method(`[ethtools] ${message}`)
  else method(`[ethtools] ${message}`, context)
}

let sink: LogSink = consoleSink

/**
 * Replace the log sink. Intended for tests and for wiring an error reporter.
 *
 * A custom sink still receives already-redacted values, so a reporting service
 * can never be handed key material.
 *
 * @param next - Sink to use, or null to restore the console.
 */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? consoleSink
}

function emit(level: LogLevel, message: string, context?: LogContext): void {
  if (!isEnabled(level)) return

  const safeMessage = redactString(message)
  if (context === undefined) {
    sink(level, safeMessage)
    return
  }

  const safeContext: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context)) {
    safeContext[key] = keyLooksSecret(key) ? REDACTED : redactValue(value)
  }
  sink(level, safeMessage, safeContext)
}

/**
 * The application logger.
 *
 * Always prefer this over `console`. Messages should describe what failed and,
 * where useful, what the caller can do about it.
 */
export const logger = {
  /** Development-only detail. Dropped in production. */
  debug: (message: string, context?: LogContext) => emit("debug", message, context),
  /** Notable but expected events. Dropped in production. */
  info: (message: string, context?: LogContext) => emit("info", message, context),
  /** Recoverable problems, such as one RPC endpoint failing over. */
  warn: (message: string, context?: LogContext) => emit("warn", message, context),
  /** Failures the user is likely to notice. */
  error: (message: string, context?: LogContext) => emit("error", message, context),
} as const

/**
 * Reduce an unknown thrown value to a safe, user-presentable sentence.
 *
 * Never returns a raw library message, because those routinely embed the
 * offending argument. Use the returned string in the UI and log the original
 * through {@link logger} where it will be redacted.
 *
 * @param error - Value from a `catch` clause.
 * @param fallback - Sentence used when nothing better can be derived.
 */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0 && error.message.length < 200) {
    return redactString(error.message)
  }
  return fallback
}
