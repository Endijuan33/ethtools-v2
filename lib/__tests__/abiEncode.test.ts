import { test } from "node:test"
import assert from "node:assert/strict"

import { Interface } from "ethers"

import { decodeCalldata } from "../calldata"
import type { AbiEncodeResult } from "../abiEncode"
import {
  encodeAbiCall,
  encodeFunctionCall,
  parseArgumentValue,
  parseFunctionAbi,
} from "../abiEncode"

/** A checksummed address used across the fixtures. */
const RECIPIENT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72"

/**
 * Real `transfer(address,uint256)` calldata moving 1e18 units to RECIPIENT —
 * the same literal the decoder tests use, so the encoder is pinned against a
 * value that is independently known to be correct.
 */
const TRANSFER_CALLDATA =
  "0xa9059cbb" +
  "0000000000000000000000008ba1f109551bd432803012645ac136ddd64dba72" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000"

/** A JSON function fragment for `transfer`. */
const TRANSFER_JSON_FRAGMENT = JSON.stringify({
  type: "function",
  name: "transfer",
  inputs: [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
})

/**
 * Unwrap a successful result, failing the test with the error message otherwise.
 */
function expectOk<T>(result: AbiEncodeResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected a success but got: ${result.error}`)
  }
  return result.value
}

/**
 * Unwrap a failed result, failing the test when the operation unexpectedly succeeded.
 */
function expectError<T>(result: AbiEncodeResult<T>): string {
  if (result.ok) {
    assert.fail("expected a failure but the operation succeeded")
  }
  return result.error
}

/** The inputs of a parsed signature, e.g. `parseInputs("f(address,uint256)")`. */
function parseInputs(signature: string) {
  const parsed = expectOk(parseFunctionAbi(signature))
  return parsed.inputs
}

// ---------- parseFunctionAbi ----------

test("parseFunctionAbi accepts every accepted ABI shape for the same function", () => {
  const shapes = [
    "transfer(address,uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    TRANSFER_JSON_FRAGMENT,
    `[${TRANSFER_JSON_FRAGMENT}]`,
    `  ${TRANSFER_JSON_FRAGMENT}  `,
  ]
  for (const shape of shapes) {
    const fragment = expectOk(parseFunctionAbi(shape))
    assert.equal(fragment.name, "transfer", shape)
    assert.equal(fragment.format("sighash"), "transfer(address,uint256)", shape)
    assert.equal(fragment.selector, "0xa9059cbb", shape)
    assert.equal(fragment.inputs.length, 2, shape)
  }
})

test("parseFunctionAbi ignores non-function fragments but demands exactly one function", () => {
  const withEvent = JSON.stringify([
    { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }] },
    JSON.parse(TRANSFER_JSON_FRAGMENT),
  ])
  const fragment = expectOk(parseFunctionAbi(withEvent))
  assert.equal(fragment.name, "transfer")

  const twoFunctions = JSON.stringify([
    JSON.parse(TRANSFER_JSON_FRAGMENT),
    { type: "function", name: "approve", inputs: [{ name: "who", type: "address" }, { name: "amount", type: "uint256" }] },
  ])
  assert.match(expectError(parseFunctionAbi(twoFunctions)), /declares 2 functions/)

  const onlyEvent = JSON.stringify([{ type: "event", name: "Transfer", inputs: [] }])
  assert.match(expectError(parseFunctionAbi(onlyEvent)), /does not declare any functions/)
})

test("parseFunctionAbi rejects empty, broken and non-function input", () => {
  assert.match(expectError(parseFunctionAbi("")), /Enter a function ABI/)
  assert.match(expectError(parseFunctionAbi("   ")), /Enter a function ABI/)

  assert.match(expectError(parseFunctionAbi("[not json")), /not valid JSON ABI/)
  assert.match(expectError(parseFunctionAbi("[{}")), /not valid JSON ABI/)

  assert.match(expectError(parseFunctionAbi("{not json")), /not valid JSON/)
  // A JSON object with no usable fragment is reported, not silently accepted.
  assert.match(expectError(parseFunctionAbi('{"a": 1}')), /does not declare any functions/)

  assert.match(expectError(parseFunctionAbi("transfer(address,uint256")), /could not be parsed/)
  assert.match(expectError(parseFunctionAbi("garbage")), /could not be parsed/)

  // Human-readable input may not list several entries.
  assert.match(
    expectError(parseFunctionAbi("transfer(address,uint256)\napprove(address,uint256)")),
    /Enter a single function/
  )

  // An event keyword is an event, not a function.
  assert.match(
    expectError(parseFunctionAbi("event Transfer(address indexed from, address indexed to, uint256 value)")),
    /not a function/
  )
})

// ---------- encodeAbiCall: known calldata and round trips ----------

test("encodeAbiCall reproduces known transfer calldata from a bare signature", () => {
  const encoded = expectOk(encodeAbiCall("transfer(address,uint256)", [RECIPIENT, "1000000000000000000"]))
  assert.equal(encoded.signature, "transfer(address,uint256)")
  assert.equal(encoded.selector, "0xa9059cbb")
  assert.equal(encoded.calldata, TRANSFER_CALLDATA)
})

test("encodeAbiCall agrees across decimal, hex and JSON-fragment input forms", () => {
  const fromDecimal = expectOk(encodeAbiCall("transfer(address,uint256)", [RECIPIENT, "1000000000000000000"]))
  const fromHex = expectOk(encodeAbiCall("transfer(address,uint256)", [RECIPIENT.toLowerCase(), "0x0de0b6b3a7640000"]))
  const fromJson = expectOk(encodeAbiCall(TRANSFER_JSON_FRAGMENT, [RECIPIENT, "1000000000000000000"]))
  assert.equal(fromHex.calldata, fromDecimal.calldata)
  assert.equal(fromJson.calldata, fromDecimal.calldata)
})

test("encodeAbiCall output decodes back through the calldata decoder", () => {
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["transfer(address,uint256)", [RECIPIENT, "1000000000000000000"]],
    ["approve(address,uint256)", [RECIPIENT, "0"]],
    ["setName(string)", ["nicht genügend Guthaben"]],
    ["setFlag(bool)", ["true"]],
    ["hashIt(bytes32)", ["0x" + "ab".repeat(32)]],
    ["sweep(uint256[])", ["1, 2, 3"]],
    ["batch((address,uint256)[])", ['[["' + RECIPIENT + '", 5]]']],
    ["mix(int256)", ["-42"]],
  ]
  for (const [abi, args] of cases) {
    const encoded = expectOk(encodeAbiCall(abi, args))
    const decoded = expectOk(decodeCalldata(encoded.calldata, [encoded.signature]))
    assert.equal(decoded.kind, "function", abi)
    if (decoded.kind !== "function") {
      continue
    }
    assert.equal(decoded.signature, encoded.signature, abi)
    assert.equal(decoded.args.length, args.length, abi)
  }
})

test("encodeAbiCall reports the first faulty argument by name or position", () => {
  const named = expectError(encodeAbiCall(TRANSFER_JSON_FRAGMENT, ["0x1234", "1"]))
  assert.match(named, /"to"/)
  assert.match(named, /not a valid Ethereum address/)

  const positional = expectError(encodeAbiCall("transfer(address,uint256)", [RECIPIENT, "1.5"]))
  assert.match(positional, /argument #1/)
  assert.match(positional, /decimal or 0x-hexadecimal integer/)
})

test("encodeAbiCall requires every argument to be present", () => {
  // A missing argument is reported against its own field, which points the
  // user at the input that needs filling.
  const missing = expectError(encodeAbiCall(TRANSFER_JSON_FRAGMENT, [RECIPIENT, ""]))
  assert.match(missing, /"amount"/)
  const none = expectError(encodeAbiCall("transfer(address,uint256)", []))
  assert.match(none, /argument #0/)
  assert.match(none, /enter a 0x-prefixed address/)
})

// ---------- parseArgumentValue: leaf types ----------

test("parseArgumentValue accepts decimal, hex and negative integers within range", () => {
  const [uint] = parseInputs("f(uint256)")
  assert.equal(expectOk(parseArgumentValue(uint, "0", "x")), 0n)
  assert.equal(expectOk(parseArgumentValue(uint, "1000000000000000000", "x")), 1000000000000000000n)
  assert.equal(expectOk(parseArgumentValue(uint, "0x0de0b6b3a7640000", "x")), 1000000000000000000n)
  assert.equal(expectOk(parseArgumentValue(uint, 7, "x")), 7n)

  const [int] = parseInputs("f(int256)")
  assert.equal(expectOk(parseArgumentValue(int, "-42", "x")), -42n)

  const [small] = parseInputs("f(uint8)")
  assert.equal(expectOk(parseArgumentValue(small, "255", "x")), 255n)
  assert.match(expectError(parseArgumentValue(small, "256", "x")), /does not fit in uint8/)
  assert.match(expectError(parseArgumentValue(uint, "-1", "x")), /does not fit in uint256/)

  // 2^255 boundaries for int256.
  const max = 2n ** 255n - 1n
  const min = -(2n ** 255n)
  assert.equal(expectOk(parseArgumentValue(int, max.toString(), "x")), max)
  assert.equal(expectOk(parseArgumentValue(int, min.toString(), "x")), min)
  assert.match(expectError(parseArgumentValue(int, (max + 1n).toString(), "x")), /does not fit in int256/)
})

test("parseArgumentValue flags floats, junk and precision-losing JSON numbers", () => {
  const [uint] = parseInputs("f(uint256)")
  assert.match(expectError(parseArgumentValue(uint, "1.5", "x")), /decimal or 0x-hexadecimal integer/)
  assert.match(expectError(parseArgumentValue(uint, "12abc", "x")), /decimal or 0x-hexadecimal integer/)
  assert.match(expectError(parseArgumentValue(uint, "0x", "x")), /decimal or 0x-hexadecimal integer/)
  assert.match(expectError(parseArgumentValue(uint, true, "x")), /decimal or 0x-hexadecimal integer/)
  assert.match(expectError(parseArgumentValue(uint, "", "x")), /decimal or 0x-hexadecimal integer/)

  // JSON.parse has already rounded this number; encoding it would silently sign
  // the wrong amount.
  const lossy = JSON.parse("[1000000000000000001]")[0]
  assert.match(
    expectError(parseArgumentValue(uint, lossy, "x")),
    /too large for JSON; pass it as a string/
  )
})

test("parseArgumentValue validates addresses, booleans, strings and byte types", () => {
  const [address] = parseInputs("f(address)")
  assert.equal(expectOk(parseArgumentValue(address, RECIPIENT, "x")), RECIPIENT)
  assert.equal(expectOk(parseArgumentValue(address, RECIPIENT.toLowerCase(), "x")), RECIPIENT)
  assert.match(expectError(parseArgumentValue(address, "0x1234", "x")), /not a valid Ethereum address/)

  const [bool] = parseInputs("f(bool)")
  assert.equal(expectOk(parseArgumentValue(bool, "true", "x")), true)
  assert.equal(expectOk(parseArgumentValue(bool, "FALSE", "x")), false)
  assert.equal(expectOk(parseArgumentValue(bool, true, "x")), true)
  assert.match(expectError(parseArgumentValue(bool, "yes", "x")), /enter true or false/)

  const [str] = parseInputs("f(string)")
  assert.equal(expectOk(parseArgumentValue(str, "hello, world", "x")), "hello, world")
  assert.equal(expectOk(parseArgumentValue(str, "", "x")), "")

  const [bytes] = parseInputs("f(bytes)")
  assert.equal(expectOk(parseArgumentValue(bytes, "0xABCD", "x")), "0xabcd")
  assert.match(expectError(parseArgumentValue(bytes, "0xABC", "x")), /whole number of bytes/)
  assert.match(expectError(parseArgumentValue(bytes, "ABCD", "x")), /0x-prefixed/)

  const [fixed] = parseInputs("f(bytes32)")
  assert.equal(expectOk(parseArgumentValue(fixed, "0x" + "ab".repeat(32), "x")), "0x" + "ab".repeat(32))
  assert.match(expectError(parseArgumentValue(fixed, "0x" + "ab".repeat(31), "x")), /expects exactly 32 bytes, got 31 bytes/)
  assert.match(expectError(parseArgumentValue(fixed, "0x" + "ab".repeat(33), "x")), /expects exactly 32 bytes, got 33 bytes/)
})

// ---------- parseArgumentValue: composites ----------

test("parseArgumentValue accepts comma-separated and JSON arrays", () => {
  const [ids] = parseInputs("f(uint256[])")
  assert.deepEqual(expectOk(parseArgumentValue(ids, "1, 2, 3", "x")), [1n, 2n, 3n])
  assert.deepEqual(expectOk(parseArgumentValue(ids, "[1, 2, 3]", "x")), [1n, 2n, 3n])
  assert.deepEqual(expectOk(parseArgumentValue(ids, ["1", "2"], "x")), [1n, 2n])
  assert.deepEqual(expectOk(parseArgumentValue(ids, "[]", "x")), [])
  assert.match(expectError(parseArgumentValue(ids, "", "x")), /enter at least one value/)

  const [addresses] = parseInputs("f(address[])")
  assert.deepEqual(
    expectOk(parseArgumentValue(addresses, `${RECIPIENT}, ${RECIPIENT.toLowerCase()}`, "x")),
    [RECIPIENT, RECIPIENT]
  )

  // A string element containing a comma needs the JSON form.
  const [words] = parseInputs("f(string[])")
  assert.deepEqual(expectOk(parseArgumentValue(words, '["a,b", "c"]', "x")), ["a,b", "c"])
})

test("parseArgumentValue enforces fixed array lengths", () => {
  const [pair] = parseInputs("f(uint256[2])")
  assert.deepEqual(expectOk(parseArgumentValue(pair, "1, 2", "x")), [1n, 2n])
  assert.match(expectError(parseArgumentValue(pair, "1", "x")), /expected exactly 2 elements, got 1/)
  assert.match(expectError(parseArgumentValue(pair, "1, 2, 3", "x")), /expected exactly 2 elements, got 3/)
})

test("parseArgumentValue handles nested arrays and tuples via JSON", () => {
  const [grid] = parseInputs("f(uint256[][])")
  assert.deepEqual(expectOk(parseArgumentValue(grid, "[[1, 2], [3]]", "x")), [[1n, 2n], [3n]])
  assert.match(expectError(parseArgumentValue(grid, "1, 2, 3", "x")), /must be given as a JSON array/)

  const [entry] = parseInputs("f((address,uint256))")
  assert.deepEqual(expectOk(parseArgumentValue(entry, `["${RECIPIENT}", 5]`, "x")), [RECIPIENT, 5n])
  assert.match(expectError(parseArgumentValue(entry, `"${RECIPIENT}"`, "x")), /must be a JSON array/)
  assert.match(expectError(parseArgumentValue(entry, "[]", "x")), /expected 2 components, got 0/)

  const [entries] = parseInputs("f((address,uint256)[])")
  const value = expectOk(parseArgumentValue(entries, ` [["${RECIPIENT}", 1], ["${RECIPIENT}", 2]] `, "x"))
  assert.deepEqual(value, [
    [RECIPIENT, 1n],
    [RECIPIENT, 2n],
  ])
})

test("parseArgumentValue names the offending element inside a composite", () => {
  const [ids] = parseInputs("f(uint256[])")
  const error = expectError(parseArgumentValue(ids, "1, two, 3", "x"))
  assert.match(error, /x\[1\] \(uint256\)/)
  assert.match(error, /not a decimal or 0x-hexadecimal integer/)
})

// ---------- encodeFunctionCall ----------

test("encodeFunctionCall encodes a zero-argument function to its bare selector", () => {
  const fragment = expectOk(parseFunctionAbi("totalSupply()"))
  const encoded = expectOk(encodeFunctionCall(fragment, []))
  assert.equal(encoded.signature, "totalSupply()")
  assert.equal(encoded.selector, "0x18160ddd")
  assert.equal(encoded.calldata, "0x18160ddd")
})

test("encodeFunctionCall checks the argument count defensively", () => {
  const fragment = expectOk(parseFunctionAbi("transfer(address,uint256)"))
  assert.match(expectError(encodeFunctionCall(fragment, [RECIPIENT])), /takes 2 arguments/)
  assert.match(
    expectError(encodeFunctionCall(fragment, [RECIPIENT, 1n, 2n])),
    /takes 2 arguments, but 3 were provided/
  )
})

test("encoded output matches ethers' own Interface encoding", () => {
  const iface = new Interface(["function transfer(address to, uint256 amount) returns (bool)"])
  const expected = iface.encodeFunctionData("transfer", [RECIPIENT, 1000000000000000000n])
  const encoded = expectOk(encodeAbiCall("transfer(address,uint256)", [RECIPIENT, "1000000000000000000"]))
  assert.equal(encoded.calldata, expected.toLowerCase())
  assert.equal(encoded.calldata, TRANSFER_CALLDATA)
})
