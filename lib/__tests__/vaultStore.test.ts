import { test } from "node:test"
import assert from "node:assert/strict"
import {
  addAccountsToVault,
  addWatchOnlyAccountToVault,
  changeVaultPassword,
  createVault,
  deleteVault,
  detectLegacyWallets,
  getActiveAccountId,
  getAutolockMinutes,
  hasVault,
  migrateLegacyWallets,
  removeAccountFromVault,
  setActiveAccountId,
  setAutolockMinutes,
  unlockVault,
} from "../vaultStore"
import { createMemoryBackend, readRaw, setStorageBackend, STORAGE_KEYS, writeJson } from "../storage"
import type { VaultAccount } from "../schema"

const PASSWORD = "Correct-Horse-9!"
const NEW_PASSWORD = "Another-Horse-8?"
const PHRASE = "test test test test test test test test test test test junk"
const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const KEY_A = `0x${"11".repeat(32)}`

function account(id: string, address: string): VaultAccount {
  return { id, label: `Account ${id}`, address, privateKey: KEY_A }
}

function useStore(): void {
  setStorageBackend(createMemoryBackend())
}

function resetStore(): void {
  setStorageBackend(null)
}

test("creates and unlocks a vault", async () => {
  useStore()
  try {
    assert.equal(hasVault(), false)

    const created = await createVault({
      mnemonic: PHRASE,
      accounts: [account("1", A)],
      password: PASSWORD,
    })
    assert.equal(created.ok, true)
    assert.equal(hasVault(), true)

    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, true)
    if (!opened.ok) return
    assert.equal(opened.value.mnemonic, PHRASE)
    assert.equal(opened.value.accounts.length, 1)
  } finally {
    resetStore()
  }
})

test("stored vault contains no readable secret", async () => {
  useStore()
  try {
    await createVault({ mnemonic: PHRASE, accounts: [account("1", A)], password: PASSWORD })

    const raw = readRaw(STORAGE_KEYS.VAULT) ?? ""
    assert.ok(raw.length > 0)
    for (const secret of ["junk", "privateKey", "1111111111", A]) {
      assert.equal(raw.includes(secret), false, `"${secret}" must not be readable at rest`)
    }
  } finally {
    resetStore()
  }
})

test("wrong password does not unlock", async () => {
  useStore()
  try {
    await createVault({ mnemonic: PHRASE, accounts: [], password: PASSWORD })
    const opened = await unlockVault("Wrong-Password-1!")
    assert.equal(opened.ok, false)
  } finally {
    resetStore()
  }
})

test("unlocking a missing vault reports clearly", async () => {
  useStore()
  try {
    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, false)
    if (!opened.ok) assert.match(opened.error, /No wallet has been created/)
  } finally {
    resetStore()
  }
})

test("rejects a vault whose decrypted shape is wrong", async () => {
  useStore()
  try {
    // Encrypt a structurally invalid payload under the right password.
    const { encryptJson } = await import("../vault")
    const sealed = await encryptJson({ accounts: [{ id: "1", address: "junk" }] }, PASSWORD)
    assert.equal(sealed.ok, true)
    if (!sealed.ok) return
    writeJson(STORAGE_KEYS.VAULT, sealed.value)

    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, false)
    if (!opened.ok) assert.match(opened.error, /not in a recognized format/)
  } finally {
    resetStore()
  }
})

test("adds accounts without duplicating an existing address", async () => {
  useStore()
  try {
    const created = await createVault({ accounts: [account("1", A)], password: PASSWORD })
    assert.equal(created.ok, true)
    if (!created.ok) return

    const added = await addAccountsToVault(
      created.value,
      [account("2", B), account("3", A.toLowerCase())],
      PASSWORD
    )
    assert.equal(added.ok, true)
    if (!added.ok) return

    assert.equal(added.value.accounts.length, 2, "the duplicate address must be skipped")

    const reopened = await unlockVault(PASSWORD)
    assert.equal(reopened.ok, true)
    if (reopened.ok) assert.equal(reopened.value.accounts.length, 2)
  } finally {
    resetStore()
  }
})

test("removes an account and persists the change", async () => {
  useStore()
  try {
    const created = await createVault({
      accounts: [account("1", A), account("2", B)],
      password: PASSWORD,
    })
    assert.equal(created.ok, true)
    if (!created.ok) return

    const removed = await removeAccountFromVault(created.value, "1", PASSWORD)
    assert.equal(removed.ok, true)

    const reopened = await unlockVault(PASSWORD)
    assert.equal(reopened.ok, true)
    if (reopened.ok) {
      assert.deepEqual(
        reopened.value.accounts.map((a) => a.id),
        ["2"]
      )
    }
  } finally {
    resetStore()
  }
})

test("changes the password and invalidates the old one", async () => {
  useStore()
  try {
    await createVault({ mnemonic: PHRASE, accounts: [], password: PASSWORD })

    const changed = await changeVaultPassword(PASSWORD, NEW_PASSWORD)
    assert.equal(changed.ok, true)

    assert.equal((await unlockVault(NEW_PASSWORD)).ok, true)
    assert.equal((await unlockVault(PASSWORD)).ok, false, "old password must stop working")
  } finally {
    resetStore()
  }
})

test("a wrong current password cannot destroy the vault", async () => {
  useStore()
  try {
    await createVault({ mnemonic: PHRASE, accounts: [], password: PASSWORD })

    const changed = await changeVaultPassword("Wrong-Password-1!", NEW_PASSWORD)
    assert.equal(changed.ok, false)

    // The original must still open.
    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, true)
    if (opened.ok) assert.equal(opened.value.mnemonic, PHRASE)
  } finally {
    resetStore()
  }
})

// ===== Legacy migration =====

test("detects legacy cleartext wallets and ignores malformed ones", () => {
  useStore()
  try {
    writeJson(STORAGE_KEYS.LEGACY_WALLETS, [
      { id: "1", label: "Old", address: A, privateKey: KEY_A },
      { id: "2", label: "Broken" },
      null,
    ])
    assert.equal(detectLegacyWallets().length, 1)
  } finally {
    resetStore()
  }
})

test("migrates cleartext wallets into the vault and deletes the plaintext", async () => {
  useStore()
  try {
    writeJson(STORAGE_KEYS.LEGACY_WALLETS, [
      { id: "1", label: "Old", address: A, privateKey: KEY_A },
    ])

    const migrated = await migrateLegacyWallets(PASSWORD)
    assert.equal(migrated.ok, true)
    if (!migrated.ok) return
    assert.equal(migrated.value.migrated, 1)

    // The cleartext copy must be gone.
    assert.equal(readRaw(STORAGE_KEYS.LEGACY_WALLETS), null)

    // And the key must now be inside the encrypted vault.
    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, true)
    if (!opened.ok) return
    assert.equal(opened.value.accounts[0].privateKey, KEY_A)

    const raw = readRaw(STORAGE_KEYS.VAULT) ?? ""
    assert.equal(raw.includes("1111111111"), false)
  } finally {
    resetStore()
  }
})

test("migration is a no-op when there is nothing to migrate", async () => {
  useStore()
  try {
    const migrated = await migrateLegacyWallets(PASSWORD)
    assert.equal(migrated.ok, true)
    if (migrated.ok) assert.equal(migrated.value.migrated, 0)
    assert.equal(hasVault(), false, "an empty migration must not create a vault")
  } finally {
    resetStore()
  }
})

test("migration merges into an existing vault without duplicating", async () => {
  useStore()
  try {
    const created = await createVault({ accounts: [account("1", A)], password: PASSWORD })
    assert.equal(created.ok, true)
    if (!created.ok) return

    writeJson(STORAGE_KEYS.LEGACY_WALLETS, [
      { id: "1", label: "Old", address: A, privateKey: KEY_A },
      { id: "9", label: "Other", address: B, privateKey: KEY_A },
    ])

    const migrated = await migrateLegacyWallets(PASSWORD, created.value)
    assert.equal(migrated.ok, true)
    if (!migrated.ok) return
    assert.equal(migrated.value.migrated, 1, "only the unknown address should be added")

    const opened = await unlockVault(PASSWORD)
    assert.equal(opened.ok, true)
    if (opened.ok) assert.equal(opened.value.accounts.length, 2)
  } finally {
    resetStore()
  }
})

test("deleting the vault removes it", async () => {
  useStore()
  try {
    await createVault({ accounts: [], password: PASSWORD })
    assert.equal(hasVault(), true)
    deleteVault()
    assert.equal(hasVault(), false)
  } finally {
    resetStore()
  }
})

test("tracks the active account id", () => {
  useStore()
  try {
    assert.equal(getActiveAccountId(), null)
    setActiveAccountId("abc")
    assert.equal(getActiveAccountId(), "abc")
    setActiveAccountId(null)
    assert.equal(getActiveAccountId(), null)
  } finally {
    resetStore()
  }
})

// ===== Watch-only accounts =====

test("adds a watch-only account and persists it", async () => {
  useStore()
  try {
    const created = await createVault({ accounts: [account("1", A)], password: PASSWORD })
    assert.equal(created.ok, true)
    if (!created.ok) return

    const added = await addWatchOnlyAccountToVault(
      created.value,
      { label: "Cold wallet", address: B },
      PASSWORD
    )
    assert.equal(added.ok, true)
    if (!added.ok) return

    assert.equal(added.value.accounts.length, 2)
    const stored = added.value.accounts[1]
    assert.equal(stored.label, "Cold wallet")
    assert.equal(stored.address, B)
    assert.equal(stored.watchOnly, true)
    assert.equal(stored.privateKey, undefined, "no key may be attached to a watch-only account")

    // The stored vault must still decrypt and pass payload validation.
    const reopened = await unlockVault(PASSWORD)
    assert.equal(reopened.ok, true)
    if (!reopened.ok) return
    assert.equal(reopened.value.accounts[1].watchOnly, true)
  } finally {
    resetStore()
  }
})

test("normalizes a lowercase watch address to checksummed form", async () => {
  useStore()
  try {
    const created = await createVault({ accounts: [account("1", A)], password: PASSWORD })
    assert.equal(created.ok, true)
    if (!created.ok) return

    const added = await addWatchOnlyAccountToVault(
      created.value,
      { label: "Cold", address: B.toLowerCase() },
      PASSWORD
    )
    assert.equal(added.ok, true)
    if (!added.ok) return
    assert.equal(added.value.accounts[1].address, B, "stored address must be checksummed")
  } finally {
    resetStore()
  }
})

test("rejects a watch address that duplicates an existing account", async () => {
  useStore()
  try {
    const created = await createVault({ accounts: [account("1", A)], password: PASSWORD })
    assert.equal(created.ok, true)
    if (!created.ok) return

    // Same address, different casing: the duplicate check is case-insensitive.
    const added = await addWatchOnlyAccountToVault(
      created.value,
      { label: "Dup", address: A.toLowerCase() },
      PASSWORD
    )
    assert.equal(added.ok, false)
    if (added.ok) return
    assert.match(added.error, /already in the vault/)

    const reopened = await unlockVault(PASSWORD)
    assert.equal(reopened.ok, true)
    if (reopened.ok) assert.equal(reopened.value.accounts.length, 1)
  } finally {
    resetStore()
  }
})

test("rejects an invalid watch address without touching the vault", async () => {
  useStore()
  try {
    const created = await createVault({ mnemonic: PHRASE, accounts: [], password: PASSWORD })
    assert.equal(created.ok, true)
    if (!created.ok) return

    const added = await addWatchOnlyAccountToVault(
      created.value,
      { label: "Bad", address: "not-an-address" },
      PASSWORD
    )
    assert.equal(added.ok, false)

    // A rejected add must not overwrite the vault that is already stored.
    const reopened = await unlockVault(PASSWORD)
    assert.equal(reopened.ok, true)
    if (!reopened.ok) return
    assert.equal(reopened.value.mnemonic, PHRASE)
    assert.equal(reopened.value.accounts.length, 0)
  } finally {
    resetStore()
  }
})

test("rejects a watch-only add with an empty label", async () => {
  useStore()
  try {
    const created = await createVault({ accounts: [], password: PASSWORD })
    assert.equal(created.ok, true)
    if (!created.ok) return

    const added = await addWatchOnlyAccountToVault(
      created.value,
      { label: "   ", address: B },
      PASSWORD
    )
    assert.equal(added.ok, false)
    if (added.ok) return
    assert.match(added.error, /label/i)
  } finally {
    resetStore()
  }
})

test("a watch-only account survives a password change", async () => {
  useStore()
  try {
    const created = await createVault({ accounts: [], password: PASSWORD })
    assert.equal(created.ok, true)
    if (!created.ok) return

    const added = await addWatchOnlyAccountToVault(
      created.value,
      { label: "Cold", address: B },
      PASSWORD
    )
    assert.equal(added.ok, true)
    if (!added.ok) return

    const changed = await changeVaultPassword(PASSWORD, NEW_PASSWORD)
    assert.equal(changed.ok, true)

    const reopened = await unlockVault(NEW_PASSWORD)
    assert.equal(reopened.ok, true)
    if (!reopened.ok) return
    assert.equal(reopened.value.accounts[0].watchOnly, true)
  } finally {
    resetStore()
  }
})

// ===== Auto-lock preference =====

test("auto-lock preference round-trips through storage", () => {
  useStore()
  try {
    assert.equal(getAutolockMinutes(), 5, "an absent preference falls back to the default")

    const written = setAutolockMinutes(15)
    assert.equal(written.ok, true)
    assert.equal(getAutolockMinutes(), 15)

    setAutolockMinutes(1)
    assert.equal(getAutolockMinutes(), 1)

    // The preference is plain validated data, never a secret.
    assert.equal(readRaw(STORAGE_KEYS.AUTOLOCK_MINUTES), "1")
  } finally {
    resetStore()
  }
})

test("a corrupt auto-lock value degrades to the default, never to no lock", () => {
  useStore()
  try {
    for (const hostile of [0, -1, 999, 5.5, "30", null, [15]]) {
      writeJson(STORAGE_KEYS.AUTOLOCK_MINUTES, hostile)
      assert.equal(getAutolockMinutes(), 5, `value ${JSON.stringify(hostile)} must fall back`)
    }
  } finally {
    resetStore()
  }
})
