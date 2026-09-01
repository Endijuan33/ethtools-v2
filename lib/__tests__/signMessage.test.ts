import { test } from "node:test"
import assert from "node:assert/strict"

import { Signature } from "ethers"

import type { SignResult } from "../signMessage"
import {
  MAX_MESSAGE_BYTES,
  hashPersonalMessage,
  normalizeAddress,
  normalizePrivateKey,
  normalizeSignature,
  signPersonalMessage,
  utf8ByteLength,
  verifyPersonalSignature,
} from "../signMessage"

/**
 * Well-known Hardhat/Anvil development key #1 (publicly documented, zero
 * funds). Every fixture below derives from it.
 */
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

/** Address of TEST_KEY, published by Hardhat. */
const TEST_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

/**
 * Hardhat/Anvil development key #3, kept to pin the second address the tooling
 * docs publish; it guards against a regression in key→address derivation.
 */
const ALT_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
const ALT_ADDRESS = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"

/** A message with multi-byte UTF-8, so byte counting is exercised. */
const UNICODE_MESSAGE = "Payment for invoice #42 — değerlendirme ✓"

/**
 * Vectors computed once and pinned: secp256k1 signing in ethers uses RFC 6979
 * deterministic nonces, so these values are stable across runs and platforms.
 */
const HELLO_DIGEST = "0x69ffccc0c4228baa3086b437b61e0db5d65a640d9300d2ccd3567a4e9de529ec"
const HELLO_SIGNATURE =
  "0x64d1a99004290ca27e6a62381c82a754289bcbe47f553dc42ae34801eb32f0785c66ae71ce19d4cd44c0f816213c555902b759a24f71cb4cb3e3eb9480b2f6f31b"
const UNICODE_DIGEST = "0x7dc4c11923721f72a8598e959ef201b32fb17885d3270fee28a34a004a8ee7dc"
const UNICODE_SIGNATURE =
  "0x44549e21f314e6b5de7456e2f4afc8044f7e400890fbbb5e2894fc5fe5e325b77c41a3d74494cc48f62df65c6b42ac2838d342ee9b3aa48c194e5c9f3bbd8be91c"

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

// ---------- normalization ----------

test("normalizePrivateKey accepts 0x, bare, upper-case and whitespace-padded keys", () => {
  assert.equal(expectOk(normalizePrivateKey(TEST_KEY)), TEST_KEY)
  assert.equal(expectOk(normalizePrivateKey(TEST_KEY.slice(2))), TEST_KEY)
  assert.equal(expectOk(normalizePrivateKey(TEST_KEY.slice(2).toUpperCase())), TEST_KEY)
  assert.equal(expectOk(normalizePrivateKey(`  ${TEST_KEY}\n`)), TEST_KEY)
})

test("normalizePrivateKey rejects structurally invalid keys without echoing them", () => {
  for (const bad of ["hello", "0x1234", `${TEST_KEY}00`]) {
    const error = expectError(normalizePrivateKey(bad))
    assert.match(error, /64 hexadecimal/)
    assert.ok(!error.includes(bad.trim()), "the error must not echo the key")
  }
  // Empty input is a prompt, not a format complaint.
  assert.match(expectError(normalizePrivateKey("")), /Enter a private key/)
  assert.match(expectError(normalizePrivateKey("   ")), /Enter a private key/)
})

test("normalizeAddress checksums and rejects invalid or bad-checksum addresses", () => {
  assert.equal(expectOk(normalizeAddress(TEST_ADDRESS)), TEST_ADDRESS)
  assert.equal(expectOk(normalizeAddress(TEST_ADDRESS.toLowerCase())), TEST_ADDRESS)
  assert.equal(expectOk(normalizeAddress(`  ${TEST_ADDRESS}  `)), TEST_ADDRESS)

  assert.match(expectError(normalizeAddress("")), /Enter an Ethereum address/)
  assert.match(expectError(normalizeAddress("0x1234")), /40 hexadecimal/)
  assert.match(expectError(normalizeAddress("not-an-address")), /40 hexadecimal/)

  // Mixed case with a corrupted checksum is the typo worth catching: flip the
  // case of the first alphabetic character, which keeps the address valid hex.
  const badChecksum = flipFirstLetterCase(TEST_ADDRESS)
  assert.notEqual(badChecksum, TEST_ADDRESS)
  assert.match(expectError(normalizeAddress(badChecksum)), /checksum/)
})

/** Flip the case of the first letter in a hex string, corrupting its checksum. */
function flipFirstLetterCase(value: string): string {
  const chars = value.split("")
  const index = chars.findIndex((char) => /[a-fA-F]/.test(char))
  chars[index] = chars[index] === chars[index].toUpperCase() ? chars[index].toLowerCase() : chars[index].toUpperCase()
  return chars.join("")
}

test("normalizeSignature strips whitespace and accepts the compact 64-byte form", () => {
  assert.equal(
    expectOk(normalizeSignature(`\n${HELLO_SIGNATURE.toUpperCase()}  `)),
    HELLO_SIGNATURE
  )
  assert.equal(expectOk(normalizeSignature(HELLO_SIGNATURE.slice(2))), HELLO_SIGNATURE)

  const compact = Signature.from(HELLO_SIGNATURE).compactSerialized
  assert.equal(compact.length, 130) // 0x + 128 hex digits (64 bytes, EIP-2098)
  assert.equal(expectOk(normalizeSignature(compact)), compact)

  assert.match(expectError(normalizeSignature("0x1234")), /65 bytes/)
  assert.match(expectError(normalizeSignature("zz" + HELLO_SIGNATURE.slice(4))), /65 bytes/)
  assert.match(expectError(normalizeSignature("")), /65 bytes/)
})

// ---------- hashing ----------

test("hashPersonalMessage reproduces the pinned EIP-191 digests", () => {
  assert.equal(hashPersonalMessage("Hello, EthTools!"), HELLO_DIGEST)
  assert.equal(hashPersonalMessage(UNICODE_MESSAGE), UNICODE_DIGEST)
})

test("utf8ByteLength counts encoded bytes, not UTF-16 code units", () => {
  assert.equal(utf8ByteLength("abc"), 3)
  assert.equal(utf8ByteLength("é"), 2)
  assert.equal(utf8ByteLength("—"), 3)
  assert.equal(utf8ByteLength("✓"), 3)
  assert.equal(utf8ByteLength(UNICODE_MESSAGE), 46)
})

// ---------- signing ----------

test("signPersonalMessage produces the pinned signature for a fixed key and message", async () => {
  const signature = expectOk(await signPersonalMessage(TEST_KEY, "Hello, EthTools!"))
  assert.equal(signature, HELLO_SIGNATURE)

  const unicode = expectOk(await signPersonalMessage(TEST_KEY, UNICODE_MESSAGE))
  assert.equal(unicode, UNICODE_SIGNATURE)
})

test("signPersonalMessage is deterministic across calls and key formats", async () => {
  const first = expectOk(await signPersonalMessage(TEST_KEY, "Hello, EthTools!"))
  const second = expectOk(await signPersonalMessage(TEST_KEY, "Hello, EthTools!"))
  const bareKey = expectOk(await signPersonalMessage(TEST_KEY.slice(2), "Hello, EthTools!"))
  assert.equal(first, second)
  assert.equal(first, bareKey)
})

test("signPersonalMessage rejects bad keys and messages without echoing the key", async () => {
  assert.match(expectError(await signPersonalMessage("", "hi")), /Enter a private key/)
  const keyError = expectError(await signPersonalMessage("0xnot-a-key", "hi"))
  assert.match(keyError, /64 hexadecimal/)
  assert.ok(!keyError.includes("0xnot-a-key"), "the error must not echo the key")

  // Zero is a structurally valid 64-hex-digit scalar but unusable for signing.
  assert.match(
    expectError(await signPersonalMessage(`0x${"00".repeat(32)}`, "hi")),
    /cannot be used for signing/
  )

  assert.match(expectError(await signPersonalMessage(TEST_KEY, "")), /Enter a message/)
})

test("signPersonalMessage enforces the message size cap at exactly 10 KB", async () => {
  const atLimit = expectOk(await signPersonalMessage(TEST_KEY, "x".repeat(MAX_MESSAGE_BYTES)))
  assert.match(atLimit, /^0x[0-9a-f]{130}$/)

  const over = expectError(await signPersonalMessage(TEST_KEY, "x".repeat(MAX_MESSAGE_BYTES + 1)))
  assert.match(over, /limited to 10 KB/)

  // The cap counts UTF-8 bytes, not characters: 5000 "—" characters are 15 KB.
  assert.match(
    expectError(await signPersonalMessage(TEST_KEY, "—".repeat(5000))),
    /limited to 10 KB/
  )
})

// ---------- verification ----------

test("verifyPersonalSignature round-trips a signature produced by signPersonalMessage", () => {
  const verification = expectOk(
    verifyPersonalSignature(TEST_ADDRESS, "Hello, EthTools!", HELLO_SIGNATURE)
  )
  assert.equal(verification.recovered, TEST_ADDRESS)
  assert.equal(verification.matches, true)
})

test("verifyPersonalSignature accepts lowercase addresses and compact signatures", () => {
  const compact = Signature.from(HELLO_SIGNATURE).compactSerialized
  const verification = expectOk(
    verifyPersonalSignature(TEST_ADDRESS.toLowerCase(), "Hello, EthTools!", compact)
  )
  assert.equal(verification.matches, true)
})

test("verifyPersonalSignature reports a mismatch when the expected address differs", () => {
  const other = "0x8ba1f109551bD432803012645Ac136ddd64DBA72"
  const verification = expectOk(
    verifyPersonalSignature(other, "Hello, EthTools!", HELLO_SIGNATURE)
  )
  assert.equal(verification.recovered, TEST_ADDRESS)
  assert.equal(verification.matches, false)
})

test("verifyPersonalSignature reports a mismatch for a tampered message", () => {
  const verification = expectOk(
    verifyPersonalSignature(TEST_ADDRESS, "Hello, EthTools!!", HELLO_SIGNATURE)
  )
  // A different message recovers some unrelated key, never the signer's.
  assert.equal(verification.matches, false)
  assert.notEqual(verification.recovered, TEST_ADDRESS)
})

test("verifyPersonalSignature validates its inputs", () => {
  assert.match(
    expectError(verifyPersonalSignature("0x1234", "hi", HELLO_SIGNATURE)),
    /40 hexadecimal/
  )
  assert.match(
    expectError(verifyPersonalSignature(TEST_ADDRESS, "hi", "0x1234")),
    /65 bytes/
  )
  assert.match(
    expectError(verifyPersonalSignature(TEST_ADDRESS, "", HELLO_SIGNATURE)),
    /Enter the message/
  )
})

// ---------- cross-checks ----------

test("the fixed keys derive their published Hardhat addresses", async () => {
  const signed = expectOk(await signPersonalMessage(TEST_KEY, "address check"))
  const recovered = expectOk(verifyPersonalSignature(TEST_ADDRESS, "address check", signed))
  assert.equal(recovered.matches, true)

  const altSigned = expectOk(await signPersonalMessage(ALT_KEY, "address check"))
  const altRecovered = expectOk(
    verifyPersonalSignature(ALT_ADDRESS, "address check", altSigned)
  )
  assert.equal(altRecovered.matches, true)
})
