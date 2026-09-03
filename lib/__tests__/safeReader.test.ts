
import { test } from "node:test"
import assert from "node:assert/strict"

import { AbiCoder, getAddress } from "ethers"

import { decodeSafeOwners, decodeSafeString, decodeSafeUint, readSafe } from "../safeReader"

/** Two real, distinct addresses used across the fixtures. */
const OWNER_A = "0x8ba1f109551bD432803012645Ac136ddd64DBA72"
const OWNER_B = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"

/** Encode fixture values exactly as a Safe contract would return them. */
const coder = AbiCoder.defaultAbiCoder()

/** ABI-encode a `uint256`. */
function encodeUint(value: bigint): string {
  return coder.encode(["uint256"], [value])
}

/** ABI-encode an `address[]`. */
function encodeOwners(owners: readonly string[]): string {
  return coder.encode(["address[]"], [owners as string[]])
}

/** ABI-encode a `string`. */
function encodeString(value: string): string {
  return coder.encode(["string"], [value])
}

/** Pad a hex body with leading zeros into a full 32-byte word. */
function word(hexBody: string): string {
  return `0x${hexBody.padStart(64, "0")}`
}

// ---------- decodeSafeOwners ----------

test("decodeSafeOwners decodes a well-formed owner array, checksummed", () => {
  const decoded = decodeSafeOwners(encodeOwners([OWNER_A.toLowerCase(), OWNER_B.toLowerCase()]))
  assert.deepEqual(decoded, [getAddress(OWNER_A), getAddress(OWNER_B)])
})

test("decodeSafeOwners decodes an empty owner list", () => {
  assert.deepEqual(decodeSafeOwners(encodeOwners([])), [])
})

test("decodeSafeOwners rejects the empty result a contract-less address returns", () => {
  assert.equal(decodeSafeOwners("0x"), null)
})

test("decodeSafeOwners rejects malformed and hostile data", () => {
  // Not hex at all.
  assert.equal(decodeSafeOwners("0xzz"), null)
  // Missing the offset and count words.
  assert.equal(decodeSafeOwners(word("1")), null)
  // Offset pointing anywhere other than 32.
  assert.equal(decodeSafeOwners(word("20") + word("1") + word(OWNER_A.slice(2))), null)
  // Count claiming more owners than the data holds.
  const shortData = word("20") + word("3") + word(OWNER_A.slice(2))
  assert.equal(decodeSafeOwners(shortData), null)
  // Count claiming an absurd number of owners.
  const hugeCount = word("20") + word("1000000") + word(OWNER_A.slice(2))
  assert.equal(decodeSafeOwners(hugeCount), null)
  // Uppercase 0X prefix is not accepted either.
  assert.equal(decodeSafeOwners(encodeOwners([OWNER_A]).replace(/^0x/, "0X")), null)
})

// ---------- decodeSafeUint ----------

test("decodeSafeUint decodes a single 32-byte word", () => {
  assert.equal(decodeSafeUint(encodeUint(3n)), 3n)
  assert.equal(decodeSafeUint(encodeUint(0n)), 0n)
  assert.equal(decodeSafeUint(encodeUint(2n ** 128n)), 2n ** 128n)
})

test("decodeSafeUint rejects anything that is not exactly one word", () => {
  assert.equal(decodeSafeUint("0x"), null)
  assert.equal(decodeSafeUint(word("1") + word("2")), null)
  assert.equal(decodeSafeUint(`0x${"g".repeat(64)}`), null)
})

// ---------- decodeSafeString ----------

test("decodeSafeString decodes an ABI-encoded string", () => {
  assert.equal(decodeSafeString(encodeString("1.3.0")), "1.3.0")
  assert.equal(decodeSafeString(encodeString("")), "")
})

test("decodeSafeString rejects malformed and oversized data", () => {
  // Empty result.
  assert.equal(decodeSafeString("0x"), null)
  // Offset other than 32.
  assert.equal(decodeSafeString(word("40") + word("5") + "312e332e30".padEnd(64, "0")), null)
  // Length claiming more bytes than the data holds.
  assert.equal(decodeSafeString(word("20") + word("100") + "312e332e30".padEnd(64, "0")), null)
  // Length beyond the plausible bound for a version string.
  const hugeLength = word("20") + word("100000") + "0".repeat(200_000)
  assert.equal(decodeSafeString(hugeLength), null)
  // Non-hex body.
  assert.equal(decodeSafeString("0xgg"), null)
})

// ---------- readSafe (offline failure paths) ----------

test("readSafe rejects an invalid address before any request", async () => {
  const result = await readSafe("mainnet", "0x1234")
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /Enter a valid Safe address/)
})

test("readSafe reports an unconfigured network as a configuration error", async () => {
  const result = await readSafe("definitely-not-a-network", OWNER_A)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /no usable RPC endpoints/)
})
