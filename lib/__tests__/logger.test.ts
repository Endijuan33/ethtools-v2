import { test } from "node:test"
import assert from "node:assert/strict"
import {
  describeError,
  logger,
  redactString,
  redactValue,
  REDACTED,
  setLogSink,
  type LogContext,
  type LogLevel,
} from "../logger"

const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const BARE_KEY = PRIVATE_KEY.slice(2)
const INFURA_URL = "https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161"

/** Capture emitted entries instead of writing to the console. */
function withCapture(
  run: (entries: { level: LogLevel; message: string; context?: LogContext }[]) => void
): void {
  const entries: { level: LogLevel; message: string; context?: LogContext }[] = []
  setLogSink((level, message, context) => entries.push({ level, message, context }))
  try {
    run(entries)
  } finally {
    setLogSink(null)
  }
}

test("redacts a private key in either form", () => {
  assert.equal(redactString(PRIVATE_KEY), REDACTED)
  assert.equal(redactString(BARE_KEY), REDACTED)
  assert.equal(
    redactString(`key is ${PRIVATE_KEY} ok`),
    `key is ${REDACTED} ok`,
    "surrounding text should survive"
  )
})

test("redacts an API key embedded in an RPC URL", () => {
  const out = redactString(INFURA_URL)
  assert.equal(out.includes("9aa3d95b3bc440fa88ea12eaa4456161"), false)
  assert.ok(out.startsWith("https://mainnet.infura.io"), "the host stays diagnosable")
})

test("redacts credentials in a query string but keeps the parameter name", () => {
  const out = redactString("https://rpc.example.com/?apiKey=sk_live_abcdef123456&x=1")
  assert.equal(out.includes("sk_live_abcdef123456"), false)
  assert.ok(out.includes("apiKey="))
})

test("leaves ordinary text and addresses alone", () => {
  // An address is public and is needed to make a log useful.
  const address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  assert.equal(redactString(address), address)
  assert.equal(redactString("Balance fetch failed on mainnet"), "Balance fetch failed on mainnet")
})

test("redacts by key name regardless of the value shape", () => {
  const out = redactValue({
    mnemonic: "test test test test test test test test test test test junk",
    mnemonicPassphrase: "extra",
    privateKey: PRIVATE_KEY,
    apiKey: "plainish",
    network: "mainnet",
  })

  assert.deepEqual(out, {
    mnemonic: REDACTED,
    mnemonicPassphrase: REDACTED,
    privateKey: REDACTED,
    apiKey: REDACTED,
    network: "mainnet",
  })
})

test("redacts nested structures and scrubs error stacks", () => {
  const error = new Error(`failed for ${PRIVATE_KEY}`)
  error.stack = `Error: failed for ${PRIVATE_KEY}\n    at somewhere`

  const out = redactValue({ outer: { inner: { error } } }) as Record<string, unknown>
  const serialized = JSON.stringify(out)

  assert.equal(serialized.includes(BARE_KEY), false, "no key material may survive nesting")
  assert.ok(serialized.includes(REDACTED))
})

test("bounds depth, array length, and string length", () => {
  const deep = { a: { b: { c: { d: { e: "too deep" } } } } }
  assert.ok(JSON.stringify(redactValue(deep)).includes("[truncated]"))

  const long = Array.from({ length: 100 }, (_, index) => index)
  const redactedArray = redactValue(long)
  assert.ok(Array.isArray(redactedArray))
  assert.ok(redactedArray.length <= 21, "array must be capped")

  const huge = "x".repeat(5000)
  assert.ok(redactString(huge).length < 600)
})

test("serializes bigint without throwing", () => {
  // JSON.stringify throws on bigint, so an unhandled one would break logging.
  assert.equal(redactValue(10n ** 18n), "1000000000000000000n")
})

test("logger scrubs both the message and the context", () => {
  withCapture((entries) => {
    logger.error(`send failed for ${PRIVATE_KEY}`, {
      privateKey: PRIVATE_KEY,
      url: INFURA_URL,
      network: "mainnet",
    })

    assert.equal(entries.length, 1)
    const entry = entries[0]
    assert.equal(entry.level, "error")
    assert.equal(entry.message.includes(BARE_KEY), false)

    const serialized = JSON.stringify(entry.context)
    assert.equal(serialized.includes(BARE_KEY), false)
    assert.equal(serialized.includes("9aa3d95b3bc440fa88ea12eaa4456161"), false)
    assert.ok(serialized.includes("mainnet"), "non-secret context is preserved")
  })
})

test("every severity reaches the sink in development", () => {
  withCapture((entries) => {
    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")
    assert.deepEqual(
      entries.map((entry) => entry.level),
      ["debug", "info", "warn", "error"]
    )
  })
})

test("describeError never returns key material", () => {
  assert.equal(describeError(new Error(`bad ${PRIVATE_KEY}`), "fallback").includes(BARE_KEY), false)
  assert.equal(describeError(null, "fallback"), "fallback")
  assert.equal(describeError("a string", "fallback"), "fallback")
  // An absurdly long message is not a usable sentence, so the fallback wins.
  assert.equal(describeError(new Error("x".repeat(400)), "fallback"), "fallback")
  assert.equal(describeError(new Error("Insufficient funds"), "fallback"), "Insufficient funds")
})
