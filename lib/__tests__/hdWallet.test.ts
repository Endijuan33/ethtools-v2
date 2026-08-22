import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildPath,
  classifySecret,
  DERIVATION_PRESETS,
  deriveAccounts,
  deriveFromPrivateKey,
  generateMnemonic,
  getPreset,
  MAX_DERIVE_COUNT,
  MNEMONIC_WORD_COUNTS,
  normalizeWhitespace,
  validateDerivationPath,
  validateMnemonic,
  type MnemonicWordCount,
} from "../hdWallet"

/** Well-known Hardhat/Anvil development phrase with published addresses. */
const HARDHAT = "test test test test test test test test test test test junk"

/** First five BIP-44 addresses for HARDHAT, published by Hardhat. */
const HARDHAT_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
]

/** Valid phrases at every supported length, generated from fixed entropy. */
const PHRASES: Record<MnemonicWordCount, { phrase: string; first: string }> = {
  12: {
    phrase: "baby mass dust captain baby mass dust captain baby mass dust casino",
    first: "0x2D4145FDB291e2dF882a270D86e5073943A287dA",
  },
  15: {
    phrase:
      "baby mass dust captain baby mass dust captain baby mass dust captain baby mass echo",
    first: "0x8527BcF7d3b83E602Ef45215020475bbcF2E1B3c",
  },
  18: {
    phrase:
      "baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain baby mistake",
    first: "0x0a2232d268bD0FC8feC811bAc7E255f9A4BE08bC",
  },
  21: {
    phrase:
      "baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain beyond",
    first: "0xEe7C83B98054537D3981049CaFCcAe701AAB2B6E",
  },
  24: {
    phrase:
      "baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust cake",
    first: "0x3307745bEEa6a592A709BB5407deC5e725B3815d",
  },
}

// ===== Derivation correctness =====

test("matches published BIP-44 vectors", () => {
  const result = deriveAccounts({ mnemonic: HARDHAT, count: 5 })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.deepEqual(
    result.value.map((a) => a.address),
    HARDHAT_ADDRESSES
  )
  assert.deepEqual(
    result.value.map((a) => a.path),
    HARDHAT_ADDRESSES.map((_, i) => `m/44'/60'/0'/0/${i}`)
  )
  assert.deepEqual(
    result.value.map((a) => a.index),
    [0, 1, 2, 3, 4]
  )
})

test("supports all five BIP-39 phrase lengths", () => {
  // The previous implementation accepted only 12/18/24, silently rejecting
  // valid 15- and 21-word phrases.
  for (const count of MNEMONIC_WORD_COUNTS) {
    const { phrase, first } = PHRASES[count]
    assert.equal(phrase.split(" ").length, count)

    const validated = validateMnemonic(phrase)
    assert.equal(validated.ok, true, `${count}-word phrase must validate`)

    const derived = deriveAccounts({ mnemonic: phrase, count: 1 })
    assert.equal(derived.ok, true, `${count}-word phrase must derive`)
    if (!derived.ok) continue
    assert.equal(derived.value[0].address, first)
  }
})

test("derives an arbitrary index range", () => {
  const result = deriveAccounts({ mnemonic: HARDHAT, startIndex: 2, count: 3 })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.deepEqual(
    result.value.map((a) => a.address),
    HARDHAT_ADDRESSES.slice(2, 5)
  )
  assert.equal(result.value[0].index, 2)
})

test("a BIP-39 passphrase changes every derived address", () => {
  const plain = deriveAccounts({ mnemonic: HARDHAT, count: 1 })
  const withPass = deriveAccounts({ mnemonic: HARDHAT, passphrase: "extra", count: 1 })
  assert.equal(plain.ok && withPass.ok, true)
  if (!plain.ok || !withPass.ok) return

  assert.notEqual(plain.value[0].address, withPass.value[0].address)
  assert.equal(plain.value[0].address, HARDHAT_ADDRESSES[0])
})

test("presets coincide at index 0 and diverge from index 1", () => {
  // m/44'/60'/0'/0/0 and m/44'/60'/0'/0/0 are the same path, so BIP-44 and
  // Ledger Live legitimately agree on the first account. They only differ once
  // the index moves, which is exactly why a recovered wallet can look correct
  // for account 1 and wrong for account 2.
  const atZero = new Map<string, string>()
  for (const preset of DERIVATION_PRESETS) {
    const result = deriveAccounts({ mnemonic: HARDHAT, template: preset.template, count: 1 })
    assert.equal(result.ok, true, `${preset.id} must derive`)
    if (result.ok) atZero.set(preset.id, result.value[0].address)
  }
  assert.equal(
    atZero.get("bip44"),
    atZero.get("ledger-live"),
    "BIP-44 and Ledger Live share account 0"
  )
  assert.notEqual(atZero.get("bip44"), atZero.get("legacy"))

  const atOne = new Set<string>()
  for (const preset of DERIVATION_PRESETS) {
    const result = deriveAccounts({
      mnemonic: HARDHAT,
      template: preset.template,
      startIndex: 1,
      count: 1,
    })
    if (result.ok) atOne.add(result.value[0].address)
  }
  assert.equal(atOne.size, DERIVATION_PRESETS.length, "all presets must differ at index 1")
})

test("ledger-live preset varies the account index", () => {
  const preset = getPreset("ledger-live")
  assert.ok(preset)
  if (!preset) return

  const result = deriveAccounts({ mnemonic: HARDHAT, template: preset.template, count: 2 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value[0].path, "m/44'/60'/0'/0/0")
  assert.equal(result.value[1].path, "m/44'/60'/1'/0/0")
})

test("derived private keys are usable and match their address", () => {
  const result = deriveAccounts({ mnemonic: HARDHAT, count: 2 })
  assert.equal(result.ok, true)
  if (!result.ok) return

  for (const account of result.value) {
    assert.match(account.privateKey, /^0x[0-9a-f]{64}$/)
    const round = deriveFromPrivateKey(account.privateKey)
    assert.equal(round.ok, true)
    if (round.ok) assert.equal(round.value.address, account.address)
  }
})

// ===== Validation =====

test("rejects an invalid checksum and bad word counts", () => {
  const badChecksum = validateMnemonic(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"
  )
  assert.equal(badChecksum.ok, false)

  const wrongCount = validateMnemonic("one two three")
  assert.equal(wrongCount.ok, false)
  if (!wrongCount.ok) assert.match(wrongCount.error, /12, 15, 18, 21, 24 words/)

  assert.equal(validateMnemonic("").ok, false)
})

test("normalizes newline- and tab-separated phrases", () => {
  // Phrases pasted from a paper backup are frequently not space-separated.
  const newlineSeparated = HARDHAT.split(" ").join("\n")
  assert.equal(normalizeWhitespace(newlineSeparated), HARDHAT)

  const result = deriveAccounts({ mnemonic: newlineSeparated, count: 1 })
  assert.equal(result.ok, true, "a newline-separated phrase must still derive")
  if (result.ok) assert.equal(result.value[0].address, HARDHAT_ADDRESSES[0])

  assert.equal(normalizeWhitespace("  a   b\t\tc \n d "), "a b c d")
})

test("accepts mixed case and extra spacing in a phrase", () => {
  const messy = `  TEST   test Test test test test test test test test test JUNK `
  const result = deriveAccounts({ mnemonic: messy, count: 1 })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value[0].address, HARDHAT_ADDRESSES[0])
})

test("bounds the derivation batch size", () => {
  assert.equal(deriveAccounts({ mnemonic: HARDHAT, count: 0 }).ok, false)
  assert.equal(deriveAccounts({ mnemonic: HARDHAT, count: -1 }).ok, false)
  assert.equal(deriveAccounts({ mnemonic: HARDHAT, count: MAX_DERIVE_COUNT + 1 }).ok, false)
  assert.equal(deriveAccounts({ mnemonic: HARDHAT, startIndex: -1 }).ok, false)
  assert.equal(deriveAccounts({ mnemonic: HARDHAT, count: 1.5 }).ok, false)
})

test("rejects a template without an index placeholder", () => {
  const result = deriveAccounts({ mnemonic: HARDHAT, template: "m/44'/60'/0'/0/0", count: 1 })
  assert.equal(result.ok, false)
})

// ===== Secret classification =====

test("classifies mnemonics at every valid length", () => {
  for (const count of MNEMONIC_WORD_COUNTS) {
    const result = classifySecret(PHRASES[count].phrase)
    assert.equal(result.kind, "mnemonic", `${count} words should classify as mnemonic`)
    assert.equal(result.wordCount, count)
  }
})

test("classifies private keys with and without the 0x prefix", () => {
  const bare = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

  const withPrefix = classifySecret(`0x${bare}`)
  assert.equal(withPrefix.kind, "private-key")
  assert.equal(withPrefix.normalized, `0x${bare}`)

  const without = classifySecret(bare)
  assert.equal(without.kind, "private-key")
  assert.equal(without.normalized, `0x${bare}`, "normalization must add the 0x prefix")
})

test("a newline-separated phrase is not misread as a private key", () => {
  // The old heuristic tested `input.includes(" ")`, so a newline-separated
  // phrase fell through to the private-key branch and produced a misleading
  // "Invalid private key" error.
  const result = classifySecret(HARDHAT.split(" ").join("\n"))
  assert.equal(result.kind, "mnemonic")
  assert.equal(result.wordCount, 12)
})

test("reports actionable reasons for unclassifiable input", () => {
  assert.equal(classifySecret("").kind, "unknown")

  const shortHex = classifySecret("0xabc")
  assert.equal(shortHex.kind, "unknown")
  assert.match(shortHex.reason ?? "", /64 hexadecimal/)

  const wrongWords = classifySecret("one two three four")
  assert.equal(wrongWords.kind, "unknown")
  assert.match(wrongWords.reason ?? "", /Found 4/)
})

test("rejects a 13-word phrase", () => {
  const thirteen = `${HARDHAT} extra`
  assert.equal(classifySecret(thirteen).kind, "unknown")
})

// ===== Paths =====

test("validates derivation paths", () => {
  for (const good of ["m/44'/60'/0'/0/0", "m/44'/60'/0'", "m/0", "m/2147483647'"]) {
    assert.equal(validateDerivationPath(good).ok, true, `${good} should be valid`)
  }
  for (const bad of ["", "44'/60'/0'/0/0", "m/", "m//0", "n/44'/60'", "m/44'/60'/x", "m/-1"]) {
    assert.equal(validateDerivationPath(bad).ok, false, `${bad} should be invalid`)
  }
})

test("rejects an out-of-range path segment", () => {
  assert.equal(validateDerivationPath("m/2147483648").ok, false)
})

test("builds paths from a template", () => {
  const built = buildPath("m/44'/60'/0'/0/{index}", 7)
  assert.equal(built.ok, true)
  if (built.ok) assert.equal(built.value, "m/44'/60'/0'/0/7")

  assert.equal(buildPath("m/44'/60'/0'/0/{index}", -1).ok, false)
  assert.equal(buildPath("m/44'/60'/0'/0/0", 1).ok, false)
})

// ===== Generation =====

test("generates a valid phrase at each supported length", () => {
  for (const count of MNEMONIC_WORD_COUNTS) {
    const generated = generateMnemonic(count)
    assert.equal(generated.ok, true, `${count}-word generation should succeed`)
    if (!generated.ok) continue

    assert.equal(generated.value.split(" ").length, count)
    assert.equal(validateMnemonic(generated.value).ok, true)
  }
})

test("generated phrases are not repeated", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 10; i++) {
    const generated = generateMnemonic(12)
    if (generated.ok) seen.add(generated.value)
  }
  assert.equal(seen.size, 10, "entropy source must not repeat")
})

test("rejects an invalid private key", () => {
  assert.equal(deriveFromPrivateKey("not-a-key").ok, false)
  assert.equal(deriveFromPrivateKey("0x00").ok, false)
  // Structurally valid hex but not a valid curve scalar.
  assert.equal(deriveFromPrivateKey(`0x${"00".repeat(32)}`).ok, false)
})
