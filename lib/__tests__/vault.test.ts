import { test } from "node:test"
import assert from "node:assert/strict"
import {
  assessPassword,
  decryptJson,
  encryptJson,
  isEncryptedEnvelope,
  isVaultSupported,
  MIN_PASSWORD_LENGTH,
  MIN_PBKDF2_ITERATIONS,
  VAULT_FORMAT_VERSION,
} from "../vault"

// Keep iterations at the floor so the suite stays fast; production uses 600k.
const FAST = MIN_PBKDF2_ITERATIONS
const PASSWORD = "Correct-Horse-9!"

test("vault is supported in this environment", () => {
  assert.equal(isVaultSupported(), true)
})

test("round-trips a payload", async () => {
  const secret = {
    mnemonic: "test test test test test test test test test test test junk",
    accounts: [{ id: "a", label: "Main", address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" }],
  }

  const sealed = await encryptJson(secret, PASSWORD, FAST)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  const opened = await decryptJson<typeof secret>(sealed.value, PASSWORD)
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  assert.deepEqual(opened.value, secret)
})

test("ciphertext does not contain the plaintext", async () => {
  const sealed = await encryptJson({ mnemonic: "abandon ability able" }, PASSWORD, FAST)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  const serialized = JSON.stringify(sealed.value)
  assert.equal(serialized.includes("abandon"), false)
  assert.equal(serialized.includes("mnemonic"), false)
})

test("same input yields different ciphertext each time", async () => {
  const a = await encryptJson({ x: 1 }, PASSWORD, FAST)
  const b = await encryptJson({ x: 1 }, PASSWORD, FAST)
  assert.equal(a.ok && b.ok, true)
  if (!a.ok || !b.ok) return

  assert.notEqual(a.value.cipher, b.value.cipher, "IV/salt must be random per envelope")
  assert.notEqual(a.value.salt, b.value.salt)
  assert.notEqual(a.value.iv, b.value.iv)
})

test("wrong password is rejected", async () => {
  const sealed = await encryptJson({ x: 1 }, PASSWORD, FAST)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  const opened = await decryptJson(sealed.value, "Wrong-Password-1!")
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.equal(opened.reason, "wrong-password")
})

test("tampered ciphertext is rejected by the GCM tag", async () => {
  const sealed = await encryptJson({ x: 1 }, PASSWORD, FAST)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  // Flip a character in the ciphertext body.
  const body = sealed.value.cipher
  const flipped = (body[0] === "A" ? "B" : "A") + body.slice(1)
  const opened = await decryptJson({ ...sealed.value, cipher: flipped }, PASSWORD)
  assert.equal(opened.ok, false)
})

test("rejects a short password on encrypt", async () => {
  const result = await encryptJson({ x: 1 }, "short", FAST)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, "weak-password")
})

test("rejects a non-envelope", async () => {
  for (const bad of [null, undefined, 42, "nope", {}, { v: 1 }, []]) {
    const result = await decryptJson(bad, PASSWORD)
    assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`)
    if (result.ok) continue
    assert.equal(result.reason, "malformed-envelope")
  }
})

test("rejects an absurd iteration count from a hostile file", async () => {
  const sealed = await encryptJson({ x: 1 }, PASSWORD, FAST)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  // Without an upper bound this would wedge the main thread.
  const hostile = { ...sealed.value, iterations: 999_999_999 }
  const opened = await decryptJson(hostile, PASSWORD)
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.equal(opened.reason, "iterations-out-of-range")
})

test("rejects a downgraded iteration count", async () => {
  const sealed = await encryptJson({ x: 1 }, PASSWORD, FAST)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  const opened = await decryptJson({ ...sealed.value, iterations: 1 }, PASSWORD)
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.equal(opened.reason, "iterations-out-of-range")
})

test("rejects an unsupported format version", async () => {
  const sealed = await encryptJson({ x: 1 }, PASSWORD, FAST)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  const opened = await decryptJson({ ...sealed.value, v: VAULT_FORMAT_VERSION + 1 }, PASSWORD)
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.equal(opened.reason, "unsupported-version")
})

test("clamps a requested iteration count into the safe range", async () => {
  const sealed = await encryptJson({ x: 1 }, PASSWORD, 5)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return
  assert.ok(sealed.value.iterations >= MIN_PBKDF2_ITERATIONS)
})

test("envelope guard accepts a real envelope and rejects junk", async () => {
  const sealed = await encryptJson({ x: 1 }, PASSWORD, FAST)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  assert.equal(isEncryptedEnvelope(sealed.value), true)
  assert.equal(isEncryptedEnvelope({ ...sealed.value, kdf: "scrypt" }), false)
  assert.equal(isEncryptedEnvelope({ ...sealed.value, iterations: 1.5 }), false)
})

test("preserves unicode and empty structures", async () => {
  const payload = { label: "Wallet 🔐 — ünïcode", empty: {}, list: [] as number[] }
  const sealed = await encryptJson(payload, PASSWORD, FAST)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  const opened = await decryptJson<typeof payload>(sealed.value, PASSWORD)
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  assert.deepEqual(opened.value, payload)
})

test("password assessment flags weak passwords and accepts strong ones", () => {
  const weak = assessPassword("abc")
  assert.equal(weak.acceptable, false)
  assert.ok(weak.issues.length > 0)

  const repeated = assessPassword("aaaaaaaaaaaaaa")
  assert.equal(repeated.acceptable, false)

  const strong = assessPassword("Correct-Horse-9!")
  assert.equal(strong.acceptable, true)
  assert.equal(strong.issues.length, 0)
  assert.equal(strong.score, 4)

  assert.equal(assessPassword("x".repeat(MIN_PASSWORD_LENGTH - 1)).acceptable, false)
})
