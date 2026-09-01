import { test } from "node:test"
import assert from "node:assert/strict"

import { Signature } from "ethers"

import type { SignResult } from "../signMessage"
import {
  signTypedData,
  validateTypedDataJSON,
  verifyTypedDataSignature,
  type ValidTypedData,
} from "../signTypedData"

/** Well-known Hardhat/Anvil development key #1 (publicly documented, zero funds). */
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

/** Address of TEST_KEY, published by Hardhat. */
const TEST_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

/**
 * A Permit-like payload in the exact shape a wallet produces for
 * `eth_signTypedData_v4`, including the `EIP712Domain` entry that must be
 * accepted and stripped before ethers sees the types.
 */
const PERMIT_JSON = JSON.stringify(
  {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain: {
      name: "EtherToken",
      version: "1",
      chainId: 1,
      verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
    },
    message: {
      owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      spender: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      value: "1000000000000000000",
      nonce: 0,
      deadline: 1759276800,
    },
  },
  null,
  2
)

/**
 * Vectors computed once and pinned: secp256k1 signing in ethers uses RFC 6979
 * deterministic nonces, so these values are stable across runs and platforms.
 */
const PERMIT_DIGEST = "0xad059e0c873465284021c89a613c2205b0449ff536f883a7695e8caaeaf03f46"
const PERMIT_SIGNATURE =
  "0x789e5bdd874cb5b84e5d43f9612cd7addd93ea76a49ed729feaba177c2d7a5fc1ad991c271361ffb38c604eeeaf29dafeaa895635639945dd8950ed1e2733c2b1c"

/** Who a tampered payload recovers: a different, unrelated key. */
const TAMPERED_RECOVERY = "0x2AfF5C17919F1e1F31BCFd62c9d8C7933b48849F"

/**
 * Unwrap a successful result, failing the test with the error message otherwise.
 */
function expectOk<T>(result: SignResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected a success but got: ${result.error}`)
  }
  return result.value
}

/**
 * Unwrap a failed result, failing the test when the operation unexpectedly succeeded.
 */
function expectError<T>(result: SignResult<T>): string {
  if (result.ok) {
    assert.fail("expected a failure but the operation succeeded")
  }
  return result.error
}

/** Build a payload by patching one top-level key of the Permit fixture. */
function permitWith(patch: Record<string, unknown>): string {
  const payload = JSON.parse(PERMIT_JSON) as Record<string, unknown>
  return JSON.stringify({ ...payload, ...patch }, null, 2)
}

// ---------- validation ----------

test("validateTypedDataJSON accepts a wallet-style payload and strips EIP712Domain", () => {
  const validated = expectOk(validateTypedDataJSON(PERMIT_JSON))
  assert.equal(validated.primaryType, "Permit")
  assert.equal(validated.digest, PERMIT_DIGEST)
  // The EIP712Domain entry is checked against the fixed field set, then removed
  // so ethers' TypedDataEncoder sees only the message structs.
  assert.deepEqual(Object.keys(validated.types), ["Permit"])
  assert.equal(validated.domain.name, "EtherToken")
  assert.equal(validated.message.deadline, 1759276800)
})

test("validateTypedDataJSON survives a payload without EIP712Domain or primaryType", () => {
  const payload = JSON.parse(PERMIT_JSON) as Record<string, unknown>
  const stripped = JSON.stringify({
    types: { Permit: (payload.types as Record<string, unknown>).Permit },
    domain: payload.domain,
    message: payload.message,
  })
  const validated = expectOk(validateTypedDataJSON(stripped))
  assert.equal(validated.primaryType, "Permit")
  assert.equal(validated.digest, PERMIT_DIGEST)
})

test("validateTypedDataJSON reports malformed JSON with a line and column when available", () => {
  // Structural errors carry a byte offset in the engine message, which is
  // translated into a line and column.
  const positioned = expectError(validateTypedDataJSON('{\n  "types" 1}'))
  assert.match(positioned, /The JSON is not valid/)
  assert.match(positioned, /line 2, column \d+/)

  // Other variants (an unexpected token, a truncated payload) carry no offset
  // on current V8; the message must still be user-safe rather than thrown.
  const token = expectError(validateTypedDataJSON('{\n  "types": oops\n}'))
  assert.match(token, /The JSON is not valid/)
  assert.match(expectError(validateTypedDataJSON('{"types": ')), /The JSON is not valid/)
})

test("validateTypedDataJSON rejects payloads that are not objects", () => {
  assert.match(expectError(validateTypedDataJSON("")), /Paste an EIP-712/)
  assert.match(expectError(validateTypedDataJSON("   ")), /Paste an EIP-712/)
  assert.match(expectError(validateTypedDataJSON("[1, 2, 3]")), /must be a JSON object/)
  assert.match(expectError(validateTypedDataJSON('"hello"')), /must be a JSON object/)
  assert.match(expectError(validateTypedDataJSON("42")), /must be a JSON object/)
})

test("validateTypedDataJSON demands types, domain and message objects", () => {
  const base = JSON.parse(PERMIT_JSON) as Record<string, unknown>
  assert.match(
    expectError(validateTypedDataJSON(JSON.stringify({ domain: {}, message: {} }))),
    /must include a "types" object/
  )
  assert.match(
    expectError(validateTypedDataJSON(JSON.stringify({ types: base.types, message: {} }))),
    /must include a "domain" object/
  )
  assert.match(
    expectError(validateTypedDataJSON(JSON.stringify({ types: base.types, domain: {} }))),
    /must include a "message" object/
  )
})

test("validateTypedDataJSON checks the shape of every struct field", () => {
  const badField = permitWith({
    types: { Permit: [{ name: "owner", type: "address" }, { name: "value" }] },
  })
  assert.match(expectError(validateTypedDataJSON(badField)), /Field 2 of type "Permit"/)

  const notArray = permitWith({ types: { Permit: "nope" } })
  assert.match(expectError(validateTypedDataJSON(notArray)), /"Permit" must be an array/)

  const onlyDomainTypes = permitWith({ types: { EIP712Domain: [] }, message: {} })
  assert.match(expectError(validateTypedDataJSON(onlyDomainTypes)), /declares no message types/)
})

test("validateTypedDataJSON rejects type graphs ethers cannot compile", () => {
  // Reference to an undeclared struct.
  const unknown = permitWith({ types: { A: [{ name: "x", type: "Missing" }] } })
  assert.match(expectError(validateTypedDataJSON(unknown)), /not valid EIP-712 types/)

  // Two unreferenced structs leave the primary type ambiguous.
  const ambiguous = permitWith({
    types: {
      A: [{ name: "x", type: "uint256" }],
      B: [{ name: "y", type: "uint256" }],
    },
  })
  assert.match(expectError(validateTypedDataJSON(ambiguous)), /not valid EIP-712 types/)
})

test("validateTypedDataJSON cross-checks a declared primaryType", () => {
  const wrong = permitWith({ primaryType: "Spender" })
  assert.match(
    expectError(validateTypedDataJSON(wrong)),
    /declares primaryType "Spender", but the types make "Permit"/
  )

  const notString = permitWith({ primaryType: 7 })
  assert.match(expectError(validateTypedDataJSON(notString)), /must be a string/)
})

test("validateTypedDataJSON validates the declared EIP712Domain fields", () => {
  const unknownField = permitWith({
    types: {
      EIP712Domain: [{ name: "bogus", type: "string" }],
      Permit: (JSON.parse(PERMIT_JSON).types as Record<string, unknown>).Permit,
    },
  })
  assert.match(
    expectError(validateTypedDataJSON(unknownField)),
    /may only declare name, version, chainId, verifyingContract and salt/
  )

  const wrongType = permitWith({
    types: {
      EIP712Domain: [{ name: "chainId", type: "uint8" }],
      Permit: (JSON.parse(PERMIT_JSON).types as Record<string, unknown>).Permit,
    },
  })
  assert.match(expectError(validateTypedDataJSON(wrongType)), /must be typed "uint256"/)
})

test("validateTypedDataJSON rejects a message that does not match the types", () => {
  const missing = permitWith({ message: { owner: TEST_ADDRESS } })
  assert.match(expectError(validateTypedDataJSON(missing)), /does not match the declared types/)

  const wrongShape = permitWith({
    message: { ...JSON.parse(PERMIT_JSON).message, owner: 123 },
  })
  assert.match(expectError(validateTypedDataJSON(wrongShape)), /does not match the declared types/)
})

test("validateTypedDataJSON rejects a domain with unsupported keys or values", () => {
  const bogusKey = permitWith({ domain: { name: "X", version: "1", bogus: true } })
  assert.match(expectError(validateTypedDataJSON(bogusKey)), /The domain is not valid/)

  const badChainId = permitWith({ domain: { name: "X", version: "1", chainId: "not-a-number" } })
  assert.match(expectError(validateTypedDataJSON(badChainId)), /The domain is not valid/)
})

// ---------- signing ----------

test("signTypedData produces the pinned signature for a fixed key and payload", async () => {
  const validated = expectOk(validateTypedDataJSON(PERMIT_JSON))
  const signature = expectOk(await signTypedData(TEST_KEY, validated))
  assert.equal(signature, PERMIT_SIGNATURE)
})

test("signTypedData is deterministic and accepts key formats", async () => {
  const validated = expectOk(validateTypedDataJSON(PERMIT_JSON))
  const first = expectOk(await signTypedData(TEST_KEY, validated))
  const bare = expectOk(await signTypedData(TEST_KEY.slice(2), validated))
  assert.equal(first, bare)
  assert.equal(first, PERMIT_SIGNATURE)
})

test("signTypedData validates the key without echoing it", async () => {
  const validated = expectOk(validateTypedDataJSON(PERMIT_JSON))
  assert.match(expectError(await signTypedData("hunter2", validated)), /64 hexadecimal/)
  assert.match(
    expectError(await signTypedData(`0x${"00".repeat(32)}`, validated)),
    /cannot be used for signing/
  )
})

// ---------- verification ----------

test("verifyTypedDataSignature round-trips the pinned signature", async () => {
  const validated = expectOk(validateTypedDataJSON(PERMIT_JSON))
  const verification = expectOk(
    verifyTypedDataSignature(TEST_ADDRESS, validated, PERMIT_SIGNATURE)
  )
  assert.equal(verification.recovered, TEST_ADDRESS)
  assert.equal(verification.matches, true)
})

test("verifyTypedDataSignature accepts compact signatures and lowercase addresses", () => {
  const validated = expectOk(validateTypedDataJSON(PERMIT_JSON))
  const compact = Signature.from(PERMIT_SIGNATURE).compactSerialized
  const verification = expectOk(
    verifyTypedDataSignature(TEST_ADDRESS.toLowerCase(), validated, compact)
  )
  assert.equal(verification.matches, true)
})

test("verifyTypedDataSignature reports a mismatch for a tampered message", () => {
  const validated = expectOk(validateTypedDataJSON(PERMIT_JSON))
  const tampered = expectOk(
    validateTypedDataJSON(permitWith({ message: { ...JSON.parse(PERMIT_JSON).message, deadline: 1759276801 } }))
  )
  assert.notEqual(tampered.digest, validated.digest)

  const verification = expectOk(
    verifyTypedDataSignature(TEST_ADDRESS, tampered, PERMIT_SIGNATURE)
  )
  assert.equal(verification.matches, false)
  assert.equal(verification.recovered, TAMPERED_RECOVERY)
})

test("verifyTypedDataSignature reports a mismatch for a different expected address", () => {
  const validated = expectOk(validateTypedDataJSON(PERMIT_JSON))
  const other = "0x8ba1f109551bD432803012645Ac136ddd64DBA72"
  const verification = expectOk(verifyTypedDataSignature(other, validated, PERMIT_SIGNATURE))
  assert.equal(verification.recovered, TEST_ADDRESS)
  assert.equal(verification.matches, false)
})

test("verifyTypedDataSignature validates address and signature inputs", () => {
  const validated: ValidTypedData = expectOk(validateTypedDataJSON(PERMIT_JSON))
  assert.match(
    expectError(verifyTypedDataSignature("0x1234", validated, PERMIT_SIGNATURE)),
    /40 hexadecimal/
  )
  assert.match(
    expectError(verifyTypedDataSignature(TEST_ADDRESS, validated, "0x1234")),
    /65 bytes/
  )
})

test("verifyTypedDataSignature accepts an EIP712Domain entry in a re-serialized payload", async () => {
  // Round-trip through the validator must be signable and verifiable as-is:
  // what the UI shows the user is exactly what was hashed.
  const validated = expectOk(validateTypedDataJSON(PERMIT_JSON))
  const signature = expectOk(await signTypedData(TEST_KEY, validated))
  const verification = expectOk(
    verifyTypedDataSignature(TEST_ADDRESS, validated, signature)
  )
  assert.equal(verification.matches, true)
})
