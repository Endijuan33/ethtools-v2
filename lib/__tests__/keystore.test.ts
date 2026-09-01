import { test } from "node:test"
import assert from "node:assert/strict"
import { concat, getBytes, keccak256, Wallet } from "ethers"
import {
  decryptKeystore,
  encryptKeystore,
  isV3Keystore,
  keystoreFilename,
  KEYSTORE_PBKDF2_ITERATIONS,
  MAX_KEYSTORE_ITERATIONS,
  MIN_KEYSTORE_ITERATIONS,
  type V3Keystore,
} from "../keystore"
import { isVaultSupported, MIN_PASSWORD_LENGTH } from "../vault"

/**
 * Hardhat/Anvil development account #1. The key and address are published in
 * the Hardhat documentation, so using them here leaks nothing. (Verified
 * against HARDHAT_ADDRESSES in hdWallet.test.ts: this key controls account #1,
 * 0x7099…79C8.)
 */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
/** The same address in the V3 file format: lowercase, no `0x` prefix. */
const ADDRESS_FIELD = "70997970c51812dc3a010c7d01b50e0d17dc79c8"
const PASSWORD = "Correct-Horse-9!"

// Fixed material so one vector is byte-for-byte reproducible. The iteration
// count stays at the accepted floor to keep the suite fast; production files
// use KEYSTORE_PBKDF2_ITERATIONS.
const C = 4096
const SALT = new Uint8Array(32).map((_, i) => i)
const IV = new Uint8Array(16).map((_, i) => 0xa0 + i)
const ID = "d6c9a1b0-2f3e-4c5d-8a9b-0c1d2e3f4a5b"

const subtle = globalThis.crypto.subtle

/** A keystore encrypted with the fixed material above. */
async function makeKeystore(): Promise<V3Keystore> {
  const sealed = await encryptKeystore(KEY, PASSWORD, { iterations: C, salt: SALT, iv: IV, id: ID })
  assert.equal(sealed.ok, true)
  // Unreachable in practice; the strict assert both throws and narrows.
  if (!sealed.ok) throw new Error("encryptKeystore failed")
  return sealed.value
}

/** PBKDF2-SHA256 to 32 bytes, computed directly against WebCrypto. */
async function rawDk(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    material,
    256
  )
  return new Uint8Array(bits)
}

/** AES-128-CTR encryption, computed directly against WebCrypto. */
async function rawAesCtr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "AES-CTR", length: 128 },
    false,
    ["encrypt"]
  )
  const out = await subtle.encrypt(
    { name: "AES-CTR", counter: iv as unknown as BufferSource, length: 64 },
    imported,
    data as unknown as BufferSource
  )
  return new Uint8Array(out)
}

test("vault is supported in this environment", () => {
  assert.equal(isVaultSupported(), true)
})

test("round-trips a private key", async () => {
  const sealed = await makeKeystore()

  const opened = await decryptKeystore(sealed, PASSWORD)
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  assert.equal(opened.value.privateKey, KEY)
  assert.equal(opened.value.privateKey.startsWith("0x"), true)
  assert.equal(opened.value.address, ADDRESS)
})

test("deterministic vector matches the V3 spec construction", async () => {
  const first = await makeKeystore()
  const second = await makeKeystore()

  // Fixed salt/iv/id means the whole file is reproducible.
  assert.deepEqual(first, second)
  assert.equal(first.version, 3)
  assert.equal(first.id, ID)
  assert.equal(first.address, ADDRESS_FIELD)
  assert.equal(first.address.startsWith("0x"), false)
  assert.deepEqual(first.crypto.kdfparams, {
    prf: "hmac-sha256",
    c: C,
    dklen: 32,
    salt: Array.from(SALT, (b) => b.toString(16).padStart(2, "0")).join(""),
  })
  assert.equal(keystoreFilename(first), `keystore-${ADDRESS_FIELD}.json`)

  // Independently reproduce the derived key, ciphertext, and MAC from raw
  // WebCrypto + ethers, pinning the exact spec wiring: dk[0..16] encrypts,
  // dk[16..32] and the ciphertext feed the keccak-256 MAC.
  const dk = await rawDk(PASSWORD, SALT, C)
  const keyBytes = getBytes(KEY)
  const expectedCipher = await rawAesCtr(dk.subarray(0, 16), IV, keyBytes)
  assert.equal(first.crypto.ciphertext, Buffer.from(expectedCipher).toString("hex"))
  assert.equal(first.crypto.cipherparams.iv, Buffer.from(IV).toString("hex"))

  const expectedMac = keccak256(concat([dk.subarray(16, 32), expectedCipher]))
  assert.equal(first.crypto.mac, expectedMac.slice(2).toLowerCase())
})

test("uses the documented default iteration count and still round-trips", async () => {
  const sealed = await encryptKeystore(KEY, PASSWORD)
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  assert.equal(sealed.value.crypto.kdfparams.c, KEYSTORE_PBKDF2_ITERATIONS)

  const opened = await decryptKeystore(sealed.value, PASSWORD)
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  assert.equal(opened.value.privateKey, KEY)
})

test("interoperates with ethers' reference keystore implementation", async () => {
  const sealed = await encryptKeystore(KEY, PASSWORD, { iterations: 100_000 })
  assert.equal(sealed.ok, true)
  if (!sealed.ok) return

  // ethers is the reference implementation the wider ecosystem uses; if it
  // cannot open a file we wrote, the format wiring is wrong no matter what
  // our own round-trip says.
  const byEthers = await Wallet.fromEncryptedJson(JSON.stringify(sealed.value), PASSWORD)
  assert.equal(byEthers.address, ADDRESS)
  assert.equal(byEthers.privateKey, KEY)
})

test("fresh entropy per file when no overrides are given", async () => {
  const a = await encryptKeystore(KEY, PASSWORD, { iterations: C })
  const b = await encryptKeystore(KEY, PASSWORD, { iterations: C })
  assert.equal(a.ok && b.ok, true)
  if (!a.ok || !b.ok) return

  assert.notEqual(a.value.crypto.kdfparams.salt, b.value.crypto.kdfparams.salt)
  assert.notEqual(a.value.crypto.cipherparams.iv, b.value.crypto.cipherparams.iv)
  assert.notEqual(a.value.id, b.value.id)
  assert.notEqual(a.value.crypto.mac, b.value.crypto.mac)
})

test("wrong password fails the MAC check", async () => {
  const sealed = await makeKeystore()

  const opened = await decryptKeystore(sealed, "Wrong-Password-1!")
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.match(opened.error, /password/i)
})

test("tampered ciphertext fails the MAC check", async () => {
  const sealed = await makeKeystore()

  // Flip the first ciphertext byte; the MAC must catch it before decryption.
  const flipped = sealed.crypto.ciphertext.startsWith("00")
    ? sealed.crypto.ciphertext.replace(/^00/, "ff")
    : sealed.crypto.ciphertext.replace(/^(..)/, "00")
  const opened = await decryptKeystore(
    { ...sealed, crypto: { ...sealed.crypto, ciphertext: flipped } },
    PASSWORD
  )
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.match(opened.error, /password|modified/i)
})

test("tampered mac is rejected", async () => {
  const sealed = await makeKeystore()
  const broken = sealed.crypto.mac.startsWith("00")
    ? sealed.crypto.mac.replace(/^00/, "ff")
    : sealed.crypto.mac.replace(/^(..)/, "00")

  const opened = await decryptKeystore(
    { ...sealed, crypto: { ...sealed.crypto, mac: broken } },
    PASSWORD
  )
  assert.equal(opened.ok, false)
})

test("tampered salt fails the MAC check", async () => {
  const sealed = await makeKeystore()

  // A different salt derives a different key, so the stored MAC no longer
  // matches — this pins that the salt really feeds the derivation.
  const opened = await decryptKeystore(
    {
      ...sealed,
      crypto: {
        ...sealed.crypto,
        kdfparams: { ...sealed.crypto.kdfparams, salt: sealed.crypto.kdfparams.salt + "00" },
      },
    },
    PASSWORD
  )
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.match(opened.error, /password|modified/i)
})

test("rejects values that are not V3 keystores", async () => {
  const notKeystores = [
    null,
    undefined,
    42,
    "nope",
    [],
    {},
    { version: 3 },
    { format: "ethtools-backup", version: 2, encrypted: true, data: {} },
  ]
  for (const bad of notKeystores) {
    assert.equal(isV3Keystore(bad), false, `guard should reject ${JSON.stringify(bad)}`)
    const result = await decryptKeystore(bad, PASSWORD)
    assert.equal(result.ok, false, `decrypt should reject ${JSON.stringify(bad)}`)
    if (result.ok) continue
    assert.match(result.error, /not a recognized keystore/i)
  }
})

test("rejects an unsupported format version", async () => {
  const sealed = await makeKeystore()

  assert.equal(isV3Keystore({ ...sealed, version: 4 }), false)
  const opened = await decryptKeystore({ ...sealed, version: 4 }, PASSWORD)
  assert.equal(opened.ok, false)
})

test("recognizes a scrypt keystore but rejects it with a precise error", async () => {
  const scryptKeystore = {
    version: 3,
    id: "6a3a1c8f-1e2d-4c5b-9a8c-7d6e5f4a3b2c",
    address: ADDRESS_FIELD,
    crypto: {
      ciphertext: "ab".repeat(32),
      cipher: "aes-128-ctr",
      cipherparams: { iv: "cd".repeat(16) },
      kdf: "scrypt",
      kdfparams: { dklen: 32, n: 262144, p: 1, r: 8, salt: "ef".repeat(32) },
      mac: "12".repeat(32),
    },
  }

  assert.equal(isV3Keystore(scryptKeystore), true)
  const opened = await decryptKeystore(scryptKeystore, PASSWORD)
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.match(opened.error, /scrypt/i)
})

test("names the kdf when it is neither pbkdf2 nor scrypt", async () => {
  const sealed = await makeKeystore()

  const opened = await decryptKeystore(
    { ...sealed, crypto: { ...sealed.crypto, kdf: "argon2id" } },
    PASSWORD
  )
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.match(opened.error, /argon2id/)
})

test("names the cipher when it is not aes-128-ctr", async () => {
  const sealed = await makeKeystore()

  const opened = await decryptKeystore(
    { ...sealed, crypto: { ...sealed.crypto, cipher: "aes-128-cbc" } },
    PASSWORD
  )
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.match(opened.error, /aes-128-cbc/)
})

test("rejects hostile or malformed kdfparams", async () => {
  const sealed = await makeKeystore()
  const kdfparams = sealed.crypto.kdfparams

  const hostile: Array<[string, typeof kdfparams]> = [
    ["below the floor", { ...kdfparams, c: MIN_KEYSTORE_ITERATIONS - 1 }],
    ["above the ceiling", { ...kdfparams, c: MAX_KEYSTORE_ITERATIONS + 1 }],
    ["a billion iterations", { ...kdfparams, c: 1_000_000_000 }],
    ["non-integer iterations", { ...kdfparams, c: 4096.5 }],
    ["missing iterations", { prf: "hmac-sha256", dklen: 32, salt: kdfparams.salt }],
    ["unsupported prf", { ...kdfparams, prf: "hmac-sha512" }],
    ["missing prf", { c: C, dklen: 32, salt: kdfparams.salt }],
    ["wrong dklen", { ...kdfparams, dklen: 64 }],
    ["missing dklen", { prf: "hmac-sha256", c: C, salt: kdfparams.salt }],
    ["non-hex salt", { ...kdfparams, salt: "zzzz" }],
    ["odd-length salt", { ...kdfparams, salt: kdfparams.salt + "0" }],
    ["too-short salt", { ...kdfparams, salt: "ab".repeat(8) }],
  ]

  for (const [label, params] of hostile) {
    const opened = await decryptKeystore(
      { ...sealed, crypto: { ...sealed.crypto, kdfparams: params } },
      PASSWORD
    )
    assert.equal(opened.ok, false, `should reject ${label}`)
    if (opened.ok) continue
    // Iteration problems say so; everything else is a malformed field.
    if (label.includes("iteration")) assert.match(opened.error, /iteration/i)
  }
})

test("rejects malformed hex fields with exact-length requirements", async () => {
  const sealed = await makeKeystore()

  const cases: Array<[string, V3Keystore]> = [
    [
      "15-byte iv",
      { ...sealed, crypto: { ...sealed.crypto, cipherparams: { iv: "ab".repeat(15) } } },
    ],
    ["31-byte ciphertext", { ...sealed, crypto: { ...sealed.crypto, ciphertext: "ab".repeat(31) } }],
    ["31-byte mac", { ...sealed, crypto: { ...sealed.crypto, mac: "ab".repeat(31) } }],
    ["non-hex mac", { ...sealed, crypto: { ...sealed.crypto, mac: "zz".repeat(32) } }],
  ]

  for (const [label, value] of cases) {
    const opened = await decryptKeystore(value, PASSWORD)
    assert.equal(opened.ok, false, `should reject ${label}`)
    if (opened.ok) continue
    assert.match(opened.error, /malformed/i)
  }
})

test("rejects a keystore whose address does not match its key", async () => {
  const sealed = await makeKeystore()

  // Hardhat account #4: a valid address for a different key.
  const opened = await decryptKeystore(
    { ...sealed, address: "15d34aaf54267db7d7c367839aaf71a00a2c6a65" },
    PASSWORD
  )
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.match(opened.error, /does not match/i)
})

test("encrypt rejects a weak password", async () => {
  const result = await encryptKeystore(KEY, "short", { iterations: C })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, new RegExp(`${MIN_PASSWORD_LENGTH} characters`))
})

test("encrypt rejects an invalid private key", async () => {
  for (const bad of ["", "not-a-key", "0x1234", "z".repeat(64)]) {
    const result = await encryptKeystore(bad, PASSWORD, { iterations: C })
    assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`)
  }
})

test("encrypt rejects out-of-range iteration overrides", async () => {
  for (const bad of [MIN_KEYSTORE_ITERATIONS - 1, MAX_KEYSTORE_ITERATIONS + 1, 4096.5]) {
    const result = await encryptKeystore(KEY, PASSWORD, { iterations: bad })
    assert.equal(result.ok, false, `should reject iterations=${bad}`)
    if (result.ok) continue
    assert.match(result.error, /iterations/i)
  }
})

test("type guard accepts real keystores and rejects junk", async () => {
  const sealed = await makeKeystore()
  assert.equal(isV3Keystore(sealed), true)

  // A 0x-prefixed address is tolerated by the guard on read.
  assert.equal(isV3Keystore({ ...sealed, address: `0x${ADDRESS_FIELD}` }), true)

  assert.equal(isV3Keystore({ ...sealed, id: "" }), false)
  assert.equal(isV3Keystore({ ...sealed, address: "0xzz" }), false)
  assert.equal(
    isV3Keystore({ ...sealed, crypto: { ...sealed.crypto, cipherparams: {} } }),
    false
  )
})
