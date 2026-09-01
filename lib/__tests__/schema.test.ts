import { test } from "node:test"
import assert from "node:assert/strict"
import {
  AUTOLOCK_MINUTES_CHOICES,
  DEFAULT_AUTOLOCK_MINUTES,
  filterValid,
  filterValidCustomNetworks,
  isAutolockMinutes,
  isChecksummedAddress,
  isEthAddress,
  isHttpsUrl,
  isStoredBookmark,
  isStoredCustomNetwork,
  isStoredToken,
  isStoredTransaction,
  isTxHash,
  isVaultAccount,
  isVaultPayload,
} from "../schema"

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const OTHER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const KEY = `0x${"11".repeat(32)}`
const HASH = "0x" + "ab".repeat(32)

test("accepts https URLs only", () => {
  assert.equal(isHttpsUrl("https://rpc.example.com"), true)
  assert.equal(isHttpsUrl("https://example.com/path?a=1"), true)

  // The XSS vector: an explorer URL that reaches an anchor href.
  assert.equal(isHttpsUrl("javascript:alert(1)"), false)
  assert.equal(isHttpsUrl("JavaScript:alert(1)"), false)
  assert.equal(isHttpsUrl("data:text/html,<script>"), false)
  assert.equal(isHttpsUrl("http://rpc.example.com"), false)
  assert.equal(isHttpsUrl("file:///etc/passwd"), false)
  assert.equal(isHttpsUrl(""), false)
  assert.equal(isHttpsUrl(null), false)
  assert.equal(isHttpsUrl("not a url"), false)
})

test("validates addresses and hashes", () => {
  assert.equal(isEthAddress(ADDRESS), true)
  assert.equal(isEthAddress(ADDRESS.toLowerCase()), true)
  assert.equal(isEthAddress("0x123"), false)
  assert.equal(isEthAddress("not-an-address"), false)
  assert.equal(isEthAddress(null), false)

  assert.equal(isTxHash(HASH), true)
  assert.equal(isTxHash("0xabc"), false)
  // Synthetic placeholder hashes must be rejected so they never become links.
  assert.equal(isTxHash("failed-1755000000000"), false)
})

test("validates a vault account", () => {
  assert.equal(isVaultAccount({ id: "1", label: "Main", address: ADDRESS }), true)
  assert.equal(
    isVaultAccount({ id: "1", label: "Main", address: ADDRESS, derivationIndex: 3 }),
    true
  )
  assert.equal(isVaultAccount({ id: "1", label: "Main", address: "bad" }), false)
  assert.equal(isVaultAccount({ id: "", label: "Main", address: ADDRESS }), false)
  assert.equal(
    isVaultAccount({ id: "1", label: "Main", address: ADDRESS, derivationIndex: -1 }),
    false
  )
  assert.equal(isVaultAccount(null), false)
})

test("validates a vault payload", () => {
  assert.equal(isVaultPayload({ accounts: [] }), true)
  assert.equal(
    isVaultPayload({ mnemonic: "a b c", accounts: [{ id: "1", label: "M", address: ADDRESS }] }),
    true
  )
  // One bad account invalidates the payload, since accounts control funds.
  assert.equal(isVaultPayload({ accounts: [{ id: "1", label: "M", address: "bad" }] }), false)
  assert.equal(isVaultPayload({ accounts: "nope" }), false)
  assert.equal(isVaultPayload({}), false)
})

test("accepts a watch-only account that is address-only", () => {
  assert.equal(
    isVaultAccount({ id: "1", label: "Cold", address: ADDRESS, watchOnly: true }),
    true
  )
  // Absent flag keeps every pre-existing account valid — backward compatible.
  assert.equal(isVaultAccount({ id: "1", label: "Main", address: ADDRESS }), true)
  assert.equal(
    isVaultAccount({ id: "1", label: "Main", address: ADDRESS, privateKey: KEY }),
    true
  )
  // Mixed vaults are fine: the flag governs only the account that carries it.
  assert.equal(
    isVaultPayload({
      accounts: [
        { id: "1", label: "Main", address: ADDRESS, privateKey: KEY },
        { id: "2", label: "Cold", address: OTHER_ADDRESS, watchOnly: true },
      ],
    }),
    true
  )
})

test("rejects a watch-only account that carries key material", () => {
  // A watch-only account must never require a secret; a record claiming the
  // flag while holding a key would blur that boundary.
  assert.equal(
    isVaultAccount({ id: "1", label: "Cold", address: ADDRESS, watchOnly: true, privateKey: KEY }),
    false
  )
  assert.equal(
    isVaultAccount({
      id: "1",
      label: "Cold",
      address: ADDRESS,
      watchOnly: true,
      derivationPath: "m/44'/60'/0'/0/0",
    }),
    false
  )
  assert.equal(
    isVaultAccount({ id: "1", label: "Cold", address: ADDRESS, watchOnly: true, derivationIndex: 0 }),
    false
  )
  // The flag itself must be a boolean, not truthy garbage.
  assert.equal(isVaultAccount({ id: "1", label: "Main", address: ADDRESS, watchOnly: "yes" }), false)
})

test("a watch-only address must be in exact checksum form", () => {
  // The address is hand-entered rather than key-derived, so the EIP-55
  // checksum is the only typo check available.
  assert.equal(
    isVaultAccount({ id: "1", label: "Cold", address: ADDRESS.toLowerCase(), watchOnly: true }),
    false
  )
  assert.equal(isChecksummedAddress(ADDRESS), true)
  assert.equal(isChecksummedAddress(ADDRESS.toLowerCase()), false)
  assert.equal(isChecksummedAddress("0x123"), false)
  assert.equal(isChecksummedAddress(null), false)
})

test("validates auto-lock choices against the closed list", () => {
  for (const minutes of AUTOLOCK_MINUTES_CHOICES) {
    assert.equal(isAutolockMinutes(minutes), true)
  }
  // A corrupted or hostile value must not validate: 0 would disable the lock.
  assert.equal(isAutolockMinutes(0), false)
  assert.equal(isAutolockMinutes(10), false)
  assert.equal(isAutolockMinutes(-5), false)
  assert.equal(isAutolockMinutes(5.5), false)
  assert.equal(isAutolockMinutes("5"), false)
  assert.equal(isAutolockMinutes(null), false)
  assert.equal(DEFAULT_AUTOLOCK_MINUTES, 5, "the default must stay at 5 minutes")
})

test("validates bookmarks", () => {
  const ok = { id: "1", address: ADDRESS, label: "Exchange", createdAt: 1 }
  assert.equal(isStoredBookmark(ok), true)
  assert.equal(isStoredBookmark({ ...ok, network: "optimism" }), true)
  assert.equal(isStoredBookmark({ ...ok, address: "junk" }), false)
  assert.equal(isStoredBookmark({ ...ok, createdAt: "yesterday" }), false)
  assert.equal(isStoredBookmark({ ...ok, label: "x".repeat(500) }), false)
})

test("validates transactions and rejects placeholder hashes", () => {
  const ok = {
    hash: HASH,
    network: "mainnet",
    from: ADDRESS,
    to: ADDRESS,
    amount: "1.0",
    currency: "ETH",
    timestamp: 1,
    status: "pending",
  }
  assert.equal(isStoredTransaction(ok), true)
  assert.equal(isStoredTransaction({ ...ok, status: "unknown" }), true)
  assert.equal(isStoredTransaction({ ...ok, status: "totally-fine" }), false)
  assert.equal(isStoredTransaction({ ...ok, hash: "failed-123" }), false)
  assert.equal(isStoredTransaction({ ...ok, to: "junk" }), false)
})

test("validates custom networks and blocks hostile URLs", () => {
  const ok = {
    name: "My Chain",
    rpcUrls: ["https://rpc.example.com"],
    explorerUrl: "https://explorer.example.com",
    currency: "ETH",
    type: "mainnet",
    isCustom: true,
  }
  assert.equal(isStoredCustomNetwork(ok), true)
  assert.equal(isStoredCustomNetwork({ ...ok, explorerUrl: "" }), true, "explorer is optional")

  // The full import attack chain must be blocked at validation.
  assert.equal(
    isStoredCustomNetwork({ ...ok, explorerUrl: "javascript:fetch('https://evil.tld')" }),
    false
  )
  assert.equal(isStoredCustomNetwork({ ...ok, rpcUrls: ["http://evil.tld"] }), false)
  assert.equal(isStoredCustomNetwork({ ...ok, rpcUrls: [] }), false)
  assert.equal(isStoredCustomNetwork({ ...ok, isCustom: false }), false)
  assert.equal(isStoredCustomNetwork({ ...ok, type: "devnet" }), false)
  assert.equal(isStoredCustomNetwork({ ...ok, decimals: 99 }), false)
})

test("validates tokens", () => {
  const ok = { address: ADDRESS, symbol: "USDC", name: "USD Coin", decimals: 6, network: "mainnet" }
  assert.equal(isStoredToken(ok), true)
  assert.equal(isStoredToken({ ...ok, decimals: -1 }), false)
  assert.equal(isStoredToken({ ...ok, address: "junk" }), false)
})

test("filterValid keeps good records and drops bad ones", () => {
  const good = { id: "1", address: ADDRESS, label: "A", createdAt: 1 }
  const input = [good, { id: "2", address: "junk", label: "B", createdAt: 2 }, null, 42]

  const kept = filterValid(input, isStoredBookmark)
  assert.equal(kept.length, 1, "one corrupt record must not discard the valid ones")
  assert.deepEqual(kept[0], good)

  assert.deepEqual(filterValid("not an array", isStoredBookmark), [])
})

test("filterValid caps the item count against a hostile file", () => {
  const good = { id: "1", address: ADDRESS, label: "A", createdAt: 1 }
  const huge = Array.from({ length: 100 }, () => good)
  assert.equal(filterValid(huge, isStoredBookmark, 10).length, 10)
})

test("custom network map drops invalid entries and malformed keys", () => {
  const valid = {
    name: "Good",
    rpcUrls: ["https://rpc.example.com"],
    explorerUrl: "",
    currency: "ETH",
    type: "testnet",
    isCustom: true,
  }

  const result = filterValidCustomNetworks({
    "good-chain": valid,
    "bad-chain": { ...valid, rpcUrls: ["javascript:alert(1)"] },
    "Invalid Key!": valid,
    "": valid,
  })

  assert.deepEqual(Object.keys(result), ["good-chain"])
  assert.deepEqual(filterValidCustomNetworks(null), {})
  assert.deepEqual(filterValidCustomNetworks([1, 2]), {})
})
