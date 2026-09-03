
import { test } from "node:test"
import assert from "node:assert/strict"

import { AbiCoder } from "ethers"
import type { Result } from "ethers"

import {
  callViewFunction,
  formatCallResult,
  parseAbiFunctions,
  type ContractReadResult,
  type ParsedAbi,
  type ReadFunction,
} from "../contractReader"

/** A checksummed address used across the fixtures. */
const RECIPIENT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72"

/**
 * Unwrap a successful parse, failing the test with the error message otherwise.
 */
function expectParsed(abiText: string): ParsedAbi {
  const result = parseAbiFunctions(abiText)
  if (!result.ok) assert.fail(`expected a success but got: ${result.error}`)
  return result.value
}

/**
 * Unwrap a failed parse, failing the test when it unexpectedly succeeded.
 */
function expectError<T>(result: ContractReadResult<T>): string {
  if (result.ok) assert.fail("expected a failure but the operation succeeded")
  return result.error
}

/** A minimal ERC-20 ABI: one read, one write, one event. */
const ERC20_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }] },
])

// ---------- parseAbiFunctions ----------

test("parseAbiFunctions keeps view and pure functions and lists writes as unsupported", () => {
  const parsed = expectParsed(ERC20_ABI)
  assert.equal(parsed.functions.length, 1)
  assert.equal(parsed.unsupported.length, 1)

  const fn = parsed.functions[0]
  assert.equal(fn.name, "balanceOf")
  assert.equal(fn.signature, "balanceOf(address)")
  assert.equal(fn.selector, "0x70a08231")
  assert.equal(fn.stateMutability, "view")
  assert.deepEqual(
    fn.inputs.map((input) => [input.name, input.type]),
    [["account", "address"]]
  )
  assert.deepEqual(
    fn.outputs.map((output) => [output.name, output.type]),
    [["", "uint256"]]
  )
  assert.equal(fn.readable, "function balanceOf(address account) view returns (uint256)")

  assert.equal(parsed.unsupported[0].name, "transfer")
  assert.equal(parsed.unsupported[0].stateMutability, "nonpayable")
})

test("parseAbiFunctions accepts a single fragment object", () => {
  const parsed = expectParsed(
    JSON.stringify({
      type: "function",
      name: "totalSupply",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "pure",
    })
  )
  assert.equal(parsed.functions.length, 1)
  assert.equal(parsed.functions[0].name, "totalSupply")
  assert.equal(parsed.unsupported.length, 0)
})

test("parseAbiFunctions keeps overloads apart by selector", () => {
  const parsed = expectParsed(
    JSON.stringify([
      {
        type: "function",
        name: "foo",
        inputs: [{ name: "", type: "uint256" }],
        outputs: [],
        stateMutability: "view",
      },
      {
        type: "function",
        name: "foo",
        inputs: [{ name: "", type: "string" }],
        outputs: [],
        stateMutability: "view",
      },
    ])
  )
  assert.equal(parsed.functions.length, 2)
  const selectors = new Set(parsed.functions.map((fn) => fn.selector))
  assert.equal(selectors.size, 2)
})

test("parseAbiFunctions reports precise errors for unusable input", () => {
  assert.match(expectError(parseAbiFunctions("")), /Enter a contract ABI/)
  assert.match(
    expectError(parseAbiFunctions("balanceOf(address)")),
    /must be a JSON array of fragments or a single fragment object/
  )
  assert.match(expectError(parseAbiFunctions("[not json")), /not valid JSON/)
  assert.match(expectError(parseAbiFunctions("[1, 2]")), /must be a JSON object/)
  assert.match(expectError(parseAbiFunctions("[]")), /does not declare any usable fragments/)
  // ethers drops a fragment it cannot parse with only a console warning;
  // this module must report it instead.
  assert.match(
    expectError(
      parseAbiFunctions('[{"type":"function","name":"?","inputs":[],"stateMutability":"view"}]')
    ),
    /could not be parsed at entry 0/
  )
})

test("parseAbiFunctions accepts an ABI with no read functions", () => {
  const parsed = expectParsed(
    JSON.stringify([
      {
        type: "function",
        name: "transfer",
        inputs: [],
        outputs: [],
        stateMutability: "payable",
      },
    ])
  )
  assert.deepEqual(parsed.functions, [])
  assert.equal(parsed.unsupported.length, 1)
  assert.equal(parsed.unsupported[0].stateMutability, "payable")
})

// ---------- formatCallResult ----------

/** Decode a fixture with the ABI coder to obtain a genuine ethers `Result`. */
function decodeFixture(types: string[], values: unknown[]): Result {
  const coder = AbiCoder.defaultAbiCoder()
  return coder.decode(types as string[], coder.encode(types, values))
}

test("formatCallResult renders scalars per type", () => {
  const types = ["uint256", "int8", "address", "bool", "bytes", "bytes4", "string"]
  const values = [
    123456789012345678901234567890n,
    -42n,
    RECIPIENT.toLowerCase(),
    true,
    "0xDeadBeef",
    "0xAbCdEf01",
    "hello world",
  ]
  const outputs = types.map((type) => ({ name: "", type }))
  const rendered = formatCallResult(decodeFixture(types, values), outputs)
  assert.deepEqual(rendered, [
    "123456789012345678901234567890",
    "-42",
    RECIPIENT,
    "true",
    "0xdeadbeef",
    "0xabcdef01",
    "hello world",
  ])
})

test("formatCallResult renders false as false, not an empty string", () => {
  const rendered = formatCallResult(decodeFixture(["bool"], [false]), [{ name: "", type: "bool" }])
  assert.equal(rendered[0], "false")
})

test("formatCallResult renders arrays as JSON with the same element rules", () => {
  const rendered = formatCallResult(
    decodeFixture(["uint256[]", "address[]"], [
      [1n, 2n, 3n],
      [RECIPIENT.toLowerCase()],
    ]),
    [
      { name: "amounts", type: "uint256[]" },
      { name: "", type: "address[]" },
    ]
  )
  assert.equal(rendered[0], '["1","2","3"]')
  assert.equal(rendered[1], `["${RECIPIENT}"]`)
})

test("formatCallResult renders tuples as JSON keyed by component name", () => {
  const rendered = formatCallResult(
    decodeFixture(["(uint256 amount, address to)"], [[5n, RECIPIENT.toLowerCase()]]),
    [
      {
        name: "detail",
        type: "(uint256,address)",
        components: [
          { name: "amount", type: "uint256" },
          { name: "to", type: "address" },
        ],
      },
    ]
  )
  assert.equal(rendered[0], `{"amount":"5","to":"${RECIPIENT}"}`)
})

test("formatCallResult renders nested structures recursively", () => {
  const tupleType = "(uint256,address)"
  const rendered = formatCallResult(
    decodeFixture([`${tupleType}[]`], [[[7n, RECIPIENT.toLowerCase()]]]),
    [
      {
        name: "rows",
        type: "(uint256,address)[]",
        components: [
          { name: "amount", type: "uint256" },
          { name: "to", type: "address" },
        ],
      },
    ]
  )
  assert.equal(rendered[0], `[{"amount":"7","to":"${RECIPIENT}"}]`)
})

test("formatCallResult renders fixed-length arrays as JSON", () => {
  const rendered = formatCallResult(decodeFixture(["uint256[3]"], [[1n, 2n, 3n]]), [
    { name: "", type: "uint256[3]" },
  ])
  assert.equal(rendered[0], '["1","2","3"]')
})

// ---------- callViewFunction (offline failure paths) ----------

/** The parsed `balanceOf` read function from the ERC-20 fixture. */
function balanceOfFunction(): ReadFunction {
  const parsed = expectParsed(ERC20_ABI)
  return parsed.functions.find((fn) => fn.name === "balanceOf") ?? parsed.functions[0]
}

test("callViewFunction rejects an invalid contract address before any request", async () => {
  const outcome = await callViewFunction("mainnet", "0x1234", balanceOfFunction(), [RECIPIENT])
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.error, /Enter a valid contract address/)
})

test("callViewFunction rejects a mismatched argument count", async () => {
  const outcome = await callViewFunction("mainnet", RECIPIENT, balanceOfFunction(), [])
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.error, /Expected 1 argument/)
})

test("callViewFunction reports a bad argument value with the argument's name", async () => {
  const outcome = await callViewFunction(
    "mainnet",
    RECIPIENT,
    balanceOfFunction(),
    ["not-an-address"]
  )
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.match(outcome.error, /account/)
    assert.match(outcome.error, /not a valid Ethereum address/)
  }
})

test("callViewFunction accepts a checksummable argument and fails on the network instead", async () => {
  // The address and arguments are valid, so the failure comes from the
  // (nonexistent) network rather than from validation.
  const outcome = await callViewFunction(
    "definitely-not-a-network",
    RECIPIENT,
    balanceOfFunction(),
    [RECIPIENT.toLowerCase()]
  )
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.error, /no usable RPC endpoints/)
})
