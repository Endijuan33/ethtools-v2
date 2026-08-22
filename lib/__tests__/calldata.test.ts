import { test } from "node:test"
import assert from "node:assert/strict"

import { AbiCoder, Interface } from "ethers"

import type { CalldataResult } from "../calldata"
import {
  ERROR_STRING_SELECTOR,
  KNOWN_SELECTORS,
  KNOWN_SIGNATURES,
  PANIC_CODES,
  PANIC_SELECTOR,
  computeSelector,
  decodeCalldata,
  decodeRevertReason,
  extractSelector,
  parseAbiFunctions,
  splitHexIntoWords,
} from "../calldata"

/** A checksummed address used across the decode fixtures. */
const RECIPIENT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72"

/** Real `transfer(address,uint256)` calldata moving 1e18 units to RECIPIENT. */
const TRANSFER_CALLDATA =
  "0xa9059cbb" +
  "0000000000000000000000008ba1f109551bd432803012645ac136ddd64dba72" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000"

/**
 * Unwrap a successful result, failing the test with the error message otherwise.
 */
function expectOk<T>(result: CalldataResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected a success but got: ${result.error}`)
  }
  return result.value
}

/**
 * Unwrap a failed result, failing the test when the operation unexpectedly succeeded.
 */
function expectError<T>(result: CalldataResult<T>): string {
  if (result.ok) {
    assert.fail("expected a failure but the operation succeeded")
  }
  return result.error
}

/**
 * ABI-encode revert data for `Error(string)`.
 */
function encodeErrorString(reason: string): string {
  return ERROR_STRING_SELECTOR + AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2)
}

/**
 * ABI-encode revert data for `Panic(uint256)`.
 */
function encodePanic(code: bigint): string {
  return PANIC_SELECTOR + AbiCoder.defaultAbiCoder().encode(["uint256"], [code]).slice(2)
}

// ---------- selector derivation ----------

test("computeSelector reproduces the well-known ERC-20 selectors", () => {
  assert.equal(computeSelector("transfer(address,uint256)"), "0xa9059cbb")
  assert.equal(computeSelector("approve(address,uint256)"), "0x095ea7b3")
  assert.equal(computeSelector("balanceOf(address)"), "0x70a08231")
  assert.equal(computeSelector("transferFrom(address,address,uint256)"), "0x23b872dd")
})

test("computeSelector returns exactly four bytes of lowercase hex", () => {
  for (const signature of KNOWN_SIGNATURES) {
    const selector = computeSelector(signature)
    assert.equal(selector.length, 10, signature)
    assert.match(selector, /^0x[0-9a-f]{8}$/, signature)
  }
})

test("the standard revert envelopes hash to their documented selectors", () => {
  assert.equal(ERROR_STRING_SELECTOR, "0x08c379a0")
  assert.equal(PANIC_SELECTOR, "0x4e487b71")
})

// ---------- KNOWN_SELECTORS table ----------

test("KNOWN_SELECTORS is derived from KNOWN_SIGNATURES with no collisions", () => {
  assert.equal(KNOWN_SELECTORS.size, KNOWN_SIGNATURES.length)
  for (const signature of KNOWN_SIGNATURES) {
    assert.equal(KNOWN_SELECTORS.get(computeSelector(signature)), signature)
  }
})

test("KNOWN_SELECTORS covers the required token functions", () => {
  const signatures = new Set(KNOWN_SELECTORS.values())
  const required = [
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "allowance(address,address)",
    "totalSupply()",
    "name()",
    "symbol()",
    "decimals()",
    "safeTransferFrom(address,address,uint256)",
    "safeTransferFrom(address,address,uint256,bytes)",
    "setApprovalForAll(address,bool)",
    "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
    "multicall(bytes[])",
  ]
  for (const signature of required) {
    assert.equal(signatures.has(signature), true, `missing ${signature}`)
  }
})

test("KNOWN_SELECTORS agrees with the canonical hex published for these functions", () => {
  assert.equal(KNOWN_SELECTORS.get("0xa9059cbb"), "transfer(address,uint256)")
  assert.equal(KNOWN_SELECTORS.get("0x095ea7b3"), "approve(address,uint256)")
  assert.equal(KNOWN_SELECTORS.get("0x18160ddd"), "totalSupply()")
  assert.equal(KNOWN_SELECTORS.get("0xa22cb465"), "setApprovalForAll(address,bool)")
  assert.equal(KNOWN_SELECTORS.get("0xac9650d8"), "multicall(bytes[])")
})

// ---------- extractSelector ----------

test("extractSelector accepts calldata with or without a prefix and in any case", () => {
  const withPrefix = expectOk(extractSelector(TRANSFER_CALLDATA))
  assert.equal(withPrefix.selector, "0xa9059cbb")
  assert.equal(withPrefix.byteLength, 68)
  assert.equal(withPrefix.wordAligned, true)
  assert.equal(withPrefix.payload.length, 2 + 128)

  const withoutPrefix = expectOk(extractSelector(TRANSFER_CALLDATA.slice(2)))
  assert.deepEqual(withoutPrefix, withPrefix)

  const upperCase = expectOk(extractSelector(TRANSFER_CALLDATA.toUpperCase().replace("0X", "0x")))
  assert.deepEqual(upperCase, withPrefix)

  // Line breaks survive copying a blob out of an explorer, so they are stripped.
  const wrapped = expectOk(extractSelector(`0xa9059cbb\n${TRANSFER_CALLDATA.slice(10)}  `))
  assert.deepEqual(wrapped, withPrefix)
})

test("extractSelector handles a bare selector with no arguments", () => {
  const bare = expectOk(extractSelector("0x18160ddd"))
  assert.equal(bare.selector, "0x18160ddd")
  assert.equal(bare.payload, "0x")
  assert.equal(bare.byteLength, 4)
  assert.equal(bare.wordAligned, true)
})

test("extractSelector reports a payload that is not word aligned", () => {
  const ragged = expectOk(extractSelector("0xa9059cbb00112233"))
  assert.equal(ragged.wordAligned, false)
  assert.equal(ragged.byteLength, 8)
})

test("extractSelector rejects empty calldata", () => {
  assert.match(expectError(extractSelector("")), /Enter some calldata/)
  assert.match(expectError(extractSelector("0x")), /Enter some calldata/)
  assert.match(expectError(extractSelector("   ")), /Enter some calldata/)
})

test("extractSelector rejects non-hex characters", () => {
  assert.match(expectError(extractSelector("0xzzzzzzzz")), /hexadecimal/)
  assert.match(expectError(extractSelector("0xa9059cbg")), /hexadecimal/)
  assert.match(expectError(extractSelector("hello world")), /hexadecimal/)
  // A non-hex character is named before the odd length, being the deeper problem.
  assert.match(expectError(extractSelector("0xa9059cbz0")), /hexadecimal/)
})

test("extractSelector rejects an odd number of hex digits", () => {
  const error = expectError(extractSelector("0xa9059cbbb"))
  assert.match(error, /odd number of hex digits/)
  assert.match(error, /\(9\)/)
})

test("extractSelector rejects calldata shorter than a selector", () => {
  assert.match(expectError(extractSelector("0xa9")), /at least 4 bytes/)
  const error = expectError(extractSelector("0xa90559"))
  assert.match(error, /at least 4 bytes/)
  assert.match(error, /3 bytes/)
  assert.match(expectError(extractSelector("0x11")), /1 byte\b/)
})

// ---------- splitHexIntoWords ----------

test("splitHexIntoWords groups a payload into 32-byte words", () => {
  const payload = expectOk(extractSelector(TRANSFER_CALLDATA)).payload
  const words = splitHexIntoWords(payload)
  assert.equal(words.length, 2)
  assert.equal(words[0], "0x0000000000000000000000008ba1f109551bd432803012645ac136ddd64dba72")
  assert.equal(words[1], "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000")
})

test("splitHexIntoWords keeps a trailing partial word visible", () => {
  assert.deepEqual(splitHexIntoWords("0x"), [])
  assert.deepEqual(splitHexIntoWords(""), [])
  assert.deepEqual(splitHexIntoWords("0xAABB"), ["0xaabb"])
  assert.equal(splitHexIntoWords(`${"00".repeat(32)}ff`).length, 2)
  assert.equal(splitHexIntoWords(`${"00".repeat(32)}ff`)[1], "0xff")
})

// ---------- decodeCalldata with an ABI ----------

test("decodeCalldata decodes real transfer calldata against a supplied signature", () => {
  const decoded = expectOk(
    decodeCalldata(TRANSFER_CALLDATA, ["function transfer(address to, uint256 amount) returns (bool)"])
  )
  assert.equal(decoded.kind, "function")
  if (decoded.kind !== "function") {
    return
  }
  assert.equal(decoded.selector, "0xa9059cbb")
  assert.equal(decoded.name, "transfer")
  assert.equal(decoded.signature, "transfer(address,uint256)")
  assert.equal(decoded.source, "abi")
  assert.deepEqual(decoded.args, [
    { name: "to", type: "address", value: RECIPIENT },
    { name: "amount", type: "uint256", value: "1000000000000000000" },
  ])
})

test("decodeCalldata renders every argument as a string, never a bigint", () => {
  const decoded = expectOk(decodeCalldata(TRANSFER_CALLDATA, ["transfer(address,uint256)"]))
  assert.equal(decoded.kind, "function")
  if (decoded.kind !== "function") {
    return
  }
  for (const arg of decoded.args) {
    assert.equal(typeof arg.value, "string", `${arg.name} leaked a ${typeof arg.value}`)
    assert.equal(typeof arg.name, "string")
    assert.equal(typeof arg.type, "string")
  }
  // An unnamed ABI still yields stable positional names.
  assert.deepEqual(
    decoded.args.map((arg) => arg.name),
    ["arg0", "arg1"]
  )
})

test("decodeCalldata accepts a bare signature, a newline-separated block and a JSON ABI", () => {
  const bare = expectOk(decodeCalldata(TRANSFER_CALLDATA, "transfer(address,uint256)"))
  assert.equal(bare.kind, "function")

  const block = expectOk(
    decodeCalldata(TRANSFER_CALLDATA, "function balanceOf(address)\nfunction transfer(address,uint256)")
  )
  assert.equal(block.kind, "function")

  const json = JSON.stringify([
    {
      type: "function",
      name: "transfer",
      inputs: [
        { name: "recipient", type: "address" },
        { name: "value", type: "uint256" },
      ],
      outputs: [{ name: "", type: "bool" }],
      stateMutability: "nonpayable",
    },
  ])
  const fromJson = expectOk(decodeCalldata(TRANSFER_CALLDATA, json))
  assert.equal(fromJson.kind, "function")
  if (fromJson.kind !== "function") {
    return
  }
  assert.deepEqual(
    fromJson.args.map((arg) => arg.name),
    ["recipient", "value"]
  )
  assert.equal(fromJson.args[1].value, "1000000000000000000")
})

test("decodeCalldata checksums addresses and renders arrays and tuples recursively", () => {
  const iface = new Interface([
    "function batch((address account, uint256 amount)[] entries, uint256[] ids, bytes payload, bool flag, int256 delta)",
  ])
  const calldata = iface.encodeFunctionData("batch", [
    [
      ["0x8ba1f109551bd432803012645ac136ddd64dba72", 1n],
      ["0x0000000000000000000000000000000000000001", 2n],
    ],
    [7n, 8n],
    "0xABCD",
    true,
    -5n,
  ])

  const decoded = expectOk(decodeCalldata(calldata, [iface.getFunction("batch")?.format("full") ?? ""]))
  assert.equal(decoded.kind, "function")
  if (decoded.kind !== "function") {
    return
  }
  assert.deepEqual(decoded.args, [
    {
      name: "entries",
      type: "(address,uint256)[]",
      value: `[(${RECIPIENT}, 1), (0x0000000000000000000000000000000000000001, 2)]`,
    },
    { name: "ids", type: "uint256[]", value: "[7, 8]" },
    { name: "payload", type: "bytes", value: "0xabcd" },
    { name: "flag", type: "bool", value: "true" },
    { name: "delta", type: "int256", value: "-5" },
  ])
})

test("decodeCalldata reports a broken ABI rather than silently ignoring it", () => {
  // ethers drops an unparseable fragment with only a console warning, so a
  // typo in a human-readable ABI has to be caught explicitly.
  const perLine = expectError(decodeCalldata(TRANSFER_CALLDATA, ["function transfer(address,uint256)", "function ("]))
  assert.match(perLine, /could not be parsed at "function \("/)
  assert.match(expectError(decodeCalldata(TRANSFER_CALLDATA, "garbage")), /could not be parsed at/)

  assert.match(expectError(decodeCalldata(TRANSFER_CALLDATA, "[not json")), /valid JSON ABI/)
  assert.match(expectError(decodeCalldata(TRANSFER_CALLDATA, "[{\"type\":")), /valid JSON ABI/)
  assert.match(expectError(decodeCalldata(TRANSFER_CALLDATA, "[]")), /does not declare any usable fragments/)
  assert.match(expectError(decodeCalldata(TRANSFER_CALLDATA, "")), /empty/)
  assert.match(expectError(decodeCalldata(TRANSFER_CALLDATA, [])), /empty/)
})

test("decodeCalldata still fails on unusable calldata even with a valid ABI", () => {
  assert.match(expectError(decodeCalldata("0x", ["transfer(address,uint256)"])), /Enter some calldata/)
  assert.match(expectError(decodeCalldata("0xnothex", ["transfer(address,uint256)"])), /hexadecimal/)
})

// ---------- decodeCalldata without an ABI ----------

test("decodeCalldata falls back to the built-in table when no ABI is supplied", () => {
  const decoded = expectOk(decodeCalldata(TRANSFER_CALLDATA))
  assert.equal(decoded.kind, "function")
  if (decoded.kind !== "function") {
    return
  }
  assert.equal(decoded.name, "transfer")
  assert.equal(decoded.signature, "transfer(address,uint256)")
  assert.equal(decoded.source, "known-selectors")
  assert.deepEqual(decoded.args, [
    { name: "arg0", type: "address", value: RECIPIENT },
    { name: "arg1", type: "uint256", value: "1000000000000000000" },
  ])
})

test("decodeCalldata falls back to the built-in table when the ABI lacks the selector", () => {
  const decoded = expectOk(decodeCalldata(TRANSFER_CALLDATA, ["function totalSupply()"]))
  assert.equal(decoded.kind, "function")
  if (decoded.kind !== "function") {
    return
  }
  assert.equal(decoded.source, "known-selectors")
  assert.equal(decoded.signature, "transfer(address,uint256)")
})

test("decodeCalldata decodes a zero-argument known function", () => {
  const decoded = expectOk(decodeCalldata("0x18160ddd"))
  assert.equal(decoded.kind, "function")
  if (decoded.kind !== "function") {
    return
  }
  assert.equal(decoded.name, "totalSupply")
  assert.deepEqual(decoded.args, [])
})

test("decodeCalldata returns raw words for an unknown selector", () => {
  const payload = `${"00".repeat(31)}2a${"11".repeat(32)}`
  const decoded = expectOk(decodeCalldata(`0xdeadbeef${payload}`))
  assert.equal(decoded.kind, "raw")
  if (decoded.kind !== "raw") {
    return
  }
  assert.equal(decoded.selector, "0xdeadbeef")
  assert.equal(decoded.signature, null)
  assert.equal(decoded.wordAligned, true)
  assert.equal(decoded.words.length, 2)
  assert.equal(decoded.words[0], `0x${"00".repeat(31)}2a`)
  assert.equal(decoded.words[1], `0x${"11".repeat(32)}`)
  assert.match(decoded.note, /built-in table/)
})

test("decodeCalldata keeps a known selector visible when its arguments will not decode", () => {
  // The transfer selector followed by a single truncated word cannot decode.
  const decoded = expectOk(decodeCalldata("0xa9059cbb0011"))
  assert.equal(decoded.kind, "raw")
  if (decoded.kind !== "raw") {
    return
  }
  assert.equal(decoded.selector, "0xa9059cbb")
  assert.equal(decoded.signature, "transfer(address,uint256)")
  assert.equal(decoded.wordAligned, false)
  assert.deepEqual(decoded.words, ["0x0011"])
  assert.match(decoded.note, /do not decode/)
})

test("decodeCalldata mentions the supplied ABI in the note when nothing matched", () => {
  const decoded = expectOk(decodeCalldata("0xdeadbeef", ["function totalSupply()"]))
  assert.equal(decoded.kind, "raw")
  if (decoded.kind !== "raw") {
    return
  }
  assert.match(decoded.note, /neither the supplied ABI nor the built-in table/)
  assert.deepEqual(decoded.words, [])
})

// ---------- parseAbiFunctions ----------

test("parseAbiFunctions lists the canonical signatures an ABI declares, sorted", () => {
  // ethers enumerates an interface sorted by signature, not in declaration order.
  const signatures = expectOk(
    parseAbiFunctions("function transfer(address to, uint256 amount) returns (bool)\nbalanceOf(address)")
  )
  assert.deepEqual(signatures, ["balanceOf(address)", "transfer(address,uint256)"])
})

test("parseAbiFunctions ignores non-function fragments and rejects a broken ABI", () => {
  const signatures = expectOk(
    parseAbiFunctions(["event Transfer(address indexed from, address indexed to, uint256 value)", "decimals()"])
  )
  assert.deepEqual(signatures, ["decimals()"])
  assert.match(expectError(parseAbiFunctions("function (")), /could not be parsed at/)
  assert.match(expectError(parseAbiFunctions("[]")), /usable fragments/)
})

// ---------- decodeRevertReason ----------

test("decodeRevertReason reads an Error(string) revert", () => {
  const reason = expectOk(decodeRevertReason(encodeErrorString("ERC20: transfer amount exceeds balance")))
  assert.equal(reason.kind, "error-string")
  if (reason.kind !== "error-string") {
    return
  }
  assert.equal(reason.reason, "ERC20: transfer amount exceeds balance")
})

test("decodeRevertReason reads an empty Error(string) message and a unicode one", () => {
  const empty = expectOk(decodeRevertReason(encodeErrorString("")))
  assert.deepEqual(empty, { kind: "error-string", reason: "" })

  const unicode = expectOk(decodeRevertReason(encodeErrorString("nicht genügend Guthaben")))
  assert.deepEqual(unicode, { kind: "error-string", reason: "nicht genügend Guthaben" })
})

test("decodeRevertReason maps the common Panic(uint256) codes", () => {
  const expectations: ReadonlyArray<readonly [bigint, RegExp]> = [
    [0x01n, /assert\(\) condition/],
    [0x11n, /overflow or underflow/],
    [0x12n, /Division or modulo by zero/],
    [0x32n, /out of bounds/],
  ]
  for (const [code, pattern] of expectations) {
    const reason = expectOk(decodeRevertReason(encodePanic(code)))
    assert.equal(reason.kind, "panic")
    if (reason.kind !== "panic") {
      continue
    }
    assert.equal(reason.code, code)
    assert.match(reason.description, pattern)
    assert.equal(reason.description, PANIC_CODES.get(code))
  }
})

test("decodeRevertReason renders the panic code as hex and survives an unlisted code", () => {
  const overflow = expectOk(decodeRevertReason(encodePanic(0x11n)))
  assert.equal(overflow.kind, "panic")
  if (overflow.kind !== "panic") {
    return
  }
  assert.equal(overflow.codeHex, "0x11")

  const unlisted = expectOk(decodeRevertReason(encodePanic(0xffn)))
  assert.equal(unlisted.kind, "panic")
  if (unlisted.kind !== "panic") {
    return
  }
  assert.equal(unlisted.code, 0xffn)
  assert.equal(unlisted.codeHex, "0xff")
  assert.match(unlisted.description, /Unrecognised panic code/)
})

test("decodeRevertReason treats empty data as no reason given", () => {
  assert.deepEqual(expectOk(decodeRevertReason("")), { kind: "none" })
  assert.deepEqual(expectOk(decodeRevertReason("0x")), { kind: "none" })
  assert.deepEqual(expectOk(decodeRevertReason("  \n ")), { kind: "none" })
})

test("decodeRevertReason returns raw words for revert data it cannot identify", () => {
  const reason = expectOk(decodeRevertReason(`0xdeadbeef${"00".repeat(32)}`))
  assert.equal(reason.kind, "unknown")
  if (reason.kind !== "unknown") {
    return
  }
  assert.equal(reason.selector, "0xdeadbeef")
  assert.deepEqual(reason.words, [`0x${"00".repeat(32)}`])
})

test("decodeRevertReason decodes a custom error when the ABI declares it", () => {
  const iface = new Interface(["error InsufficientBalance(uint256 available, uint256 required)"])
  const data = iface.encodeErrorResult("InsufficientBalance", [1n, 2n])

  const reason = expectOk(
    decodeRevertReason(data, ["error InsufficientBalance(uint256 available, uint256 required)"])
  )
  assert.equal(reason.kind, "custom-error")
  if (reason.kind !== "custom-error") {
    return
  }
  assert.equal(reason.name, "InsufficientBalance")
  assert.equal(reason.signature, "InsufficientBalance(uint256,uint256)")
  assert.deepEqual(reason.args, [
    { name: "available", type: "uint256", value: "1" },
    { name: "required", type: "uint256", value: "2" },
  ])

  // Without the ABI the same data is unidentifiable but still inspectable.
  const blind = expectOk(decodeRevertReason(data))
  assert.equal(blind.kind, "unknown")
})

test("decodeRevertReason rejects data that is neither empty nor a whole selector", () => {
  assert.match(expectError(decodeRevertReason("0x08c3")), /at least 4 bytes/)
  assert.match(expectError(decodeRevertReason("0xzz")), /hexadecimal/)
  assert.match(expectError(decodeRevertReason("0x08c379a")), /odd number of hex digits/)
})

test("decodeRevertReason reports a truncated Error(string) payload instead of guessing", () => {
  assert.match(expectError(decodeRevertReason(ERROR_STRING_SELECTOR)), /Error\(string\)/)
  assert.match(expectError(decodeRevertReason(PANIC_SELECTOR)), /Panic\(uint256\)/)
})
