import { test } from "node:test"
import assert from "node:assert/strict"
import { Wallet } from "ethers"
import {
  estimateVanityAttempts,
  formatAttemptCount,
  matchesVanityAddress,
  MAX_VANITY_LENGTH,
  validateVanityPattern,
} from "../vanity"
import { runVanityBatch } from "../vanityEngine"

// ===== Pattern validation =====

test("accepts valid prefixes and normalizes case, whitespace, and optional 0x", () => {
  const cases: Array<[input: string, expected: string]> = [
    ["dead", "dead"],
    ["DEAD", "dead"],
    ["0xdead", "dead"],
    ["0xDEAD", "dead"],
    ["0XDeAd", "dead"],
    [" 0x0077 ", "0077"],
    ["0", "0"],
  ]
  for (const [input, expected] of cases) {
    const result = validateVanityPattern(input)
    assert.equal(result.ok, true, `should accept ${JSON.stringify(input)}`)
    if (result.ok) assert.equal(result.value, expected)
  }
})

test("rejects empty and 0x-only input", () => {
  for (const input of ["", "   ", "0x", "0X", " 0x "]) {
    const result = validateVanityPattern(input)
    assert.equal(result.ok, false, `should reject ${JSON.stringify(input)}`)
    if (!result.ok) assert.ok(result.error.length > 0)
  }
})

test("rejects non-hex characters", () => {
  for (const input of ["xyz", "0xzz", "de-ad", "dead!", "🎉", "d ead"]) {
    assert.equal(validateVanityPattern(input).ok, false, JSON.stringify(input))
  }
})

test("rejects prefixes longer than the cap, quoting the expected attempts", () => {
  assert.equal(MAX_VANITY_LENGTH, 4)

  // 5 characters ≈ 16^5 = 1,048,576 expected keys; the error must say so,
  // because the limit otherwise reads as arbitrary.
  const five = validateVanityPattern("abcde")
  assert.equal(five.ok, false)
  if (!five.ok) assert.match(five.error, /1,048,576/)

  const six = validateVanityPattern("0xabcdef")
  assert.equal(six.ok, false)
  if (!six.ok) assert.match(six.error, /16,777,216/)
})

test("survives overflow-length input without printing Infinity", () => {
  const result = validateVanityPattern("f".repeat(300))
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(!result.error.includes("Infinity"))
})

// ===== Prefix matching =====

test("matches prefixes case-insensitively on the hex body", () => {
  // ethers returns EIP-55 checksummed (mixed-case) addresses, so matching must
  // lowercase both sides.
  const address = "0xDEAdBEeF00000000000000000000000000000000"
  assert.equal(matchesVanityAddress(address, "dead"), true)
  assert.equal(matchesVanityAddress(address, "DEAD"), true)
  assert.equal(matchesVanityAddress(address, "de"), true)
  // "beef" occurs in the address but not at position 0: prefix-only match.
  assert.equal(matchesVanityAddress(address, "beef"), false)
  assert.equal(matchesVanityAddress(address, "f"), false)
})

test("matches an address given without the 0x prefix", () => {
  assert.equal(matchesVanityAddress("deadbeef00000000000000000000000000000000", "dead"), true)
})

// ===== Difficulty estimation =====

test("difficulty estimate is 16^n", () => {
  assert.equal(estimateVanityAttempts("d"), 16)
  assert.equal(estimateVanityAttempts("de"), 256)
  assert.equal(estimateVanityAttempts("dea"), 4096)
  assert.equal(estimateVanityAttempts("dead"), 65536)
})

test("attempt counts format deterministically and collapse huge values", () => {
  assert.equal(formatAttemptCount(0), "0")
  assert.equal(formatAttemptCount(65536), "65,536")
  assert.equal(formatAttemptCount(1048576), "1,048,576")
  assert.match(formatAttemptCount(16 ** 40), /^1\.5×10\^48$/)
  assert.equal(formatAttemptCount(Number.NaN), "unknown")
})

// ===== Batch generation =====

test("a batch returns a real, self-consistent key on a hit", () => {
  // An empty pattern matches every address, so the first key wins — this
  // exercises the whole path (entropy → wallet → matcher) deterministically.
  const batch = runVanityBatch("", 1)
  assert.equal(batch.attempts, 1)
  assert.ok(batch.hit)
  if (batch.hit) {
    const roundTrip = new Wallet(batch.hit.privateKey)
    assert.equal(roundTrip.address, batch.hit.address)
    assert.ok(batch.hit.privateKey.startsWith("0x"))
  }
})

test("a batch that cannot match reports the full batch and no key", () => {
  // "z" never occurs in a hex address, so this pattern cannot match and the
  // loop must run to the batch limit.
  const batch = runVanityBatch("zzzz", 7)
  assert.equal(batch.attempts, 7)
  assert.equal(batch.hit, null)
})
