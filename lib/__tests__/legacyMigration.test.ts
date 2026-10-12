/**
 * Regression tests for the hardened legacy migration (S1 remediation).
 *
 * Fixture keys are synthetic byte patterns and public test addresses only;
 * no real wallet material is used anywhere in this suite.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { Wallet } from "ethers"
import {
  createVault,
  detectLegacyWallets,
  hasVault,
  migrateLegacyWallets,
  unlockVault,
} from "../vaultStore"
import {
  createMemoryBackend,
  readRaw,
  setStorageBackend,
  STORAGE_KEYS,
  writeJson,
  type StorageBackend,
} from "../storage"

const PASSWORD = "Correct-Horse-9!"
const KEY_1 = `0x${"22".repeat(32)}`
const KEY_2 = `0x${"33".repeat(32)}`
const ADDR_1 = new Wallet(KEY_1).address
const ADDR_2 = new Wallet(KEY_2).address
const BOGUS_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

function useStore(backend?: StorageBackend): void {
  setStorageBackend(backend ?? createMemoryBackend())
}

function resetStore(): void {
  setStorageBackend(null)
}

function seedLegacy(records: unknown[]): void {
  writeJson(STORAGE_KEYS.LEGACY_WALLETS, records)
}

test("migration is idempotent: a second run migrates nothing and loses nothing", async () => {
  useStore()
  try {
    seedLegacy([{ id: "1", label: "Old", address: ADDR_1, privateKey: KEY_1 }])

    const first = await migrateLegacyWallets(PASSWORD)
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.deepEqual(first.value, { migrated: 1, skipped: 0 })
    assert.equal(readRaw(STORAGE_KEYS.LEGACY_WALLETS), null)

    const second = await migrateLegacyWallets(PASSWORD)
    // Second run has no legacy records left, so it must be a pure no-op and
    // must not touch the vault that now holds the account.
    assert.equal(second.ok, true)
    if (second.ok) assert.deepEqual(second.value, { migrated: 0, skipped: 0 })

    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, true)
    if (opened.ok) assert.equal(opened.value.accounts.length, 1)
  } finally {
    resetStore()
  }
})

test("duplicate legacy records for one key migrate exactly once and are fully removed", async () => {
  useStore()
  try {
    seedLegacy([
      { id: "1", label: "Old", address: ADDR_1, privateKey: KEY_1 },
      { id: "2", label: "Old copy", address: ADDR_1, privateKey: KEY_1 },
    ])

    const migrated = await migrateLegacyWallets(PASSWORD)
    assert.equal(migrated.ok, true)
    if (!migrated.ok) return
    assert.equal(migrated.value.migrated, 1)
    assert.equal(readRaw(STORAGE_KEYS.LEGACY_WALLETS), null)

    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, true)
    if (opened.ok) assert.equal(opened.value.accounts.length, 1)
  } finally {
    resetStore()
  }
})

test("a record with unusable key material is skipped, preserved, and cannot block valid records", async () => {
  useStore()
  try {
    seedLegacy([
      { id: "1", label: "Good", address: ADDR_1, privateKey: KEY_1 },
      { id: "2", label: "Broken", address: ADDR_2, privateKey: "not-a-key" },
    ])

    const migrated = await migrateLegacyWallets(PASSWORD)
    assert.equal(migrated.ok, true)
    if (!migrated.ok) return
    assert.deepEqual(migrated.value, { migrated: 1, skipped: 1 })

    // The valid key's plaintext copy is gone; only the skipped record remains.
    const remainingRaw = readRaw(STORAGE_KEYS.LEGACY_WALLETS) ?? ""
    assert.equal(remainingRaw.includes(KEY_1), false, "migrated key must not remain in plaintext")
    assert.equal(detectLegacyWallets().length, 1)
    assert.equal(detectLegacyWallets()[0].id, "2")

    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, true)
    if (!opened.ok) return
    assert.equal(opened.value.accounts.length, 1)
    assert.equal(opened.value.accounts[0].address, ADDR_1)
  } finally {
    resetStore()
  }
})

test("a stored address that disagrees with the key is corrected to the derived address", async () => {
  useStore()
  try {
    seedLegacy([{ id: "1", label: "Mismatched", address: BOGUS_ADDRESS, privateKey: KEY_1 }])

    const migrated = await migrateLegacyWallets(PASSWORD)
    assert.equal(migrated.ok, true)
    if (!migrated.ok) return
    assert.equal(migrated.value.migrated, 1)

    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, true)
    if (!opened.ok) return
    assert.equal(opened.value.accounts[0].address, ADDR_1)
    assert.notEqual(opened.value.accounts[0].address, BOGUS_ADDRESS)
  } finally {
    resetStore()
  }
})

test("migration refuses to overwrite an existing vault it was not given", async () => {
  useStore()
  try {
    const created = await createVault({ accounts: [], password: PASSWORD })
    assert.equal(created.ok, true)

    seedLegacy([{ id: "1", label: "Old", address: ADDR_1, privateKey: KEY_1 }])

    const migrated = await migrateLegacyWallets(PASSWORD)
    assert.equal(migrated.ok, false, "must refuse without the unlocked payload")

    // Nothing was destroyed: the legacy record and the vault both survive.
    assert.equal(detectLegacyWallets().length, 1)
    assert.equal(hasVault(), true)
    assert.equal((await unlockVault(PASSWORD)).ok, true)
  } finally {
    resetStore()
  }
})

test("cleanup never deletes an undetected entry that still carries a usable key", async () => {
  useStore()
  try {
    // The second entry fails the legacy shape check (no address), but its
    // key material is real: deleting the whole legacy key after migrating
    // the first entry would destroy that key unmigrated.
    seedLegacy([
      { id: "1", label: "Good", address: ADDR_1, privateKey: KEY_1 },
      { id: "2", label: "No address recorded", privateKey: KEY_2 },
    ])

    const migrated = await migrateLegacyWallets(PASSWORD)
    assert.equal(migrated.ok, true)
    if (!migrated.ok) return
    assert.equal(migrated.value.migrated, 1)
    assert.ok(migrated.value.skipped >= 1, "the undetected entry must be reported as skipped")

    // The migrated key's plaintext is gone, the undetected key survives.
    const remainingRaw = readRaw(STORAGE_KEYS.LEGACY_WALLETS) ?? ""
    assert.equal(remainingRaw.includes(KEY_1), false, "migrated key must not remain in plaintext")
    assert.equal(remainingRaw.includes(KEY_2), true, "unmigrated key must be preserved verbatim")

    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, true)
    if (opened.ok) assert.equal(opened.value.accounts.length, 1)
  } finally {
    resetStore()
  }
})

test("an encryption/write failure leaves the plaintext source untouched and creates no vault", async () => {
  const memory = createMemoryBackend()
  const failingBackend: StorageBackend = {
    getItem: (key) => memory.getItem(key),
    removeItem: (key) => memory.removeItem(key),
    setItem: (key, value) => {
      if (key === STORAGE_KEYS.VAULT) throw new Error("storage unavailable")
      memory.setItem(key, value)
    },
  }
  useStore(failingBackend)
  try {
    seedLegacy([{ id: "1", label: "Old", address: ADDR_1, privateKey: KEY_1 }])

    const migrated = await migrateLegacyWallets(PASSWORD)
    assert.equal(migrated.ok, false)

    // The app must not fall back to keeping or using the key in plaintext
    // as if migration had succeeded: the source is preserved verbatim for a
    // later retry and no vault was created.
    assert.equal(hasVault(), false)
    const remaining = detectLegacyWallets()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].privateKey, KEY_1)
  } finally {
    resetStore()
  }
})
