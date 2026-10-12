/**
 * RA-03 regression tests: restoring an encrypted backup must actually seal
 * its accounts/mnemonic into the vault — verified by decrypting the vault
 * again — for the create, locked-vault, and unlocked-session scenarios, and
 * must refuse a silent mnemonic conflict on merge.
 *
 * All keys/phrases are the public Hardhat test material.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  backupHasSecrets,
  planRestoredSecrets,
  resealBackupSecrets,
} from "../vaultRestore"
import type { BackupContents } from "../backup"
import { createMemoryBackend, setStorageBackend } from "../storage"
import { hasVault, unlockVault } from "../vaultStore"
import type { VaultPayload } from "../schema"

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const PHRASE = "test test test test test test test test test test test junk"
const OTHER_PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow"
const VAULT_PASSWORD = "Correct-Horse-9!"
const BACKUP_PASSWORD = "<redacted>"

function contents(overrides: Partial<BackupContents> = {}): BackupContents {
  return {
    activeAccountId: null,
    bookmarks: [],
    transactions: [],
    tokens: [],
    customNetworks: {},
    ...overrides,
  }
}

function useStore(): void {
  setStorageBackend(createMemoryBackend())
}

function resetStore(): void {
  setStorageBackend(null)
}

test("backupHasSecrets distinguishes secret-carrying backups", () => {
  assert.equal(backupHasSecrets(contents()), false)
  assert.equal(backupHasSecrets(contents({ accounts: [] })), false)
  assert.equal(backupHasSecrets(contents({ mnemonic: PHRASE })), true)
  assert.equal(
    backupHasSecrets(contents({ accounts: [{ id: "a", label: "A", address: ADDRESS, privateKey: KEY_A }] })),
    true
  )
})

test("plan: phrase-only backup derives its first account", () => {
  const planned = planRestoredSecrets(null, contents({ mnemonic: PHRASE }), "replace")
  assert.equal(planned.ok, true)
  if (!planned.ok) return
  assert.equal(planned.value.derivedFirstAccount, true)
  assert.equal(planned.value.payload.accounts.length, 1)
  assert.equal(planned.value.payload.accounts[0].address, ADDRESS)
  assert.equal(planned.value.payload.mnemonic, PHRASE)
})

test("plan: merge adds new accounts and keeps existing ones", () => {
  const existing: VaultPayload = {
    mnemonic: PHRASE,
    accounts: [{ id: "a", label: "A", address: ADDRESS, privateKey: KEY_A }],
  }
  const planned = planRestoredSecrets(
    existing,
    contents({
      mnemonic: PHRASE,
      accounts: [
        { id: "a2", label: "A copy", address: ADDRESS, privateKey: KEY_A },
        { id: "b", label: "B", address: OTHER, privateKey: KEY_B },
      ],
    }),
    "merge"
  )
  assert.equal(planned.ok, true)
  if (!planned.ok) return
  assert.equal(planned.value.accountsIncluded, 1, "only the genuinely new account is added")
  assert.deepEqual(
    planned.value.payload.accounts.map((a) => a.address),
    [ADDRESS, OTHER]
  )
})

test("plan: merging a different recovery phrase is an explicit conflict, never a silent discard", () => {
  const existing: VaultPayload = { mnemonic: PHRASE, accounts: [] }
  const planned = planRestoredSecrets(existing, contents({ mnemonic: OTHER_PHRASE }), "merge")
  assert.equal(planned.ok, false)
  if (!planned.ok) {
    assert.equal(planned.conflict, "mnemonic")
    assert.match(planned.error, /different recovery phrases/i)
  }
  // Replace is the deliberate way through.
  const replaced = planRestoredSecrets(existing, contents({ mnemonic: OTHER_PHRASE }), "replace")
  assert.equal(replaced.ok, true)
})

test("reseal creates a new vault when none exists and verifies by re-decryption", async () => {
  useStore()
  try {
    assert.equal(hasVault(), false)
    const sealed = await resealBackupSecrets(
      contents({
        mnemonic: PHRASE,
        accounts: [{ id: "a", label: "A", address: ADDRESS, privateKey: KEY_A }],
      }),
      "merge",
      VAULT_PASSWORD,
      null
    )
    assert.equal(sealed.ok, true)
    if (!sealed.ok) return
    assert.equal(sealed.value.createdVault, true)
    assert.equal(hasVault(), true)

    const opened = await unlockVault(VAULT_PASSWORD)
    assert.equal(opened.ok, true)
    if (!opened.ok) return
    assert.equal(opened.value.mnemonic, PHRASE)
    assert.deepEqual(opened.value.accounts.map((a) => a.address), [ADDRESS])
  } finally {
    resetStore()
  }
})

test("reseal into a locked vault requires the existing password and changes nothing on a wrong one", async () => {
  useStore()
  try {
    const created = await resealBackupSecrets(
      contents({ accounts: [{ id: "a", label: "A", address: ADDRESS, privateKey: KEY_A }] }),
      "replace",
      VAULT_PASSWORD,
      null
    )
    assert.equal(created.ok, true)

    const wrong = await resealBackupSecrets(
      contents({ accounts: [{ id: "b", label: "B", address: OTHER, privateKey: KEY_B }] }),
      "merge",
      "Wrong-Password-1!",
      null
    )
    assert.equal(wrong.ok, false)

    const opened = await unlockVault(VAULT_PASSWORD)
    assert.equal(opened.ok, true)
    if (!opened.ok) return
    assert.deepEqual(
      opened.value.accounts.map((a) => a.address),
      [ADDRESS],
      "a failed reseal must not have modified the vault"
    )

    const merged = await resealBackupSecrets(
      contents({ accounts: [{ id: "b", label: "B", address: OTHER, privateKey: KEY_B }] }),
      "merge",
      VAULT_PASSWORD,
      null
    )
    assert.equal(merged.ok, true)
    const reopened = await unlockVault(VAULT_PASSWORD)
    assert.equal(reopened.ok, true)
    if (!reopened.ok) return
    assert.deepEqual(reopened.value.accounts.map((a) => a.address), [ADDRESS, OTHER])
  } finally {
    resetStore()
  }
})

test("reseal with an unlocked session merges against the in-memory payload", async () => {
  useStore()
  try {
    const created = await resealBackupSecrets(
      contents({
        mnemonic: PHRASE,
        accounts: [{ id: "a", label: "A", address: ADDRESS, privateKey: KEY_A }],
      }),
      "replace",
      VAULT_PASSWORD,
      null
    )
    assert.equal(created.ok, true)
    if (!created.ok) return

    const session = { payload: created.value.payload, password: VAULT_PASSWORD }
    const merged = await resealBackupSecrets(
      contents({ accounts: [{ id: "b", label: "B", address: OTHER, privateKey: KEY_B }] }),
      "merge",
      VAULT_PASSWORD,
      session
    )
    assert.equal(merged.ok, true)
    if (!merged.ok) return
    assert.deepEqual(merged.value.payload.accounts.map((a) => a.address), [ADDRESS, OTHER])
    assert.equal(merged.value.payload.mnemonic, PHRASE, "the session phrase survives a merge")
  } finally {
    resetStore()
  }
})

test("reseal refuses a backup without secrets and a weak new-vault password", async () => {
  useStore()
  try {
    const noSecrets = await resealBackupSecrets(contents(), "merge", VAULT_PASSWORD, null)
    assert.equal(noSecrets.ok, false)

    const weak = await resealBackupSecrets(
      contents({ mnemonic: PHRASE }),
      "replace",
      "weak",
      null
    )
    assert.equal(weak.ok, false)
    assert.equal(hasVault(), false, "no vault may be created with a weak password")
  } finally {
    resetStore()
  }
})

test("BACKUP_PASSWORD fixture stays distinct from the vault password", () => {
  // The backup's own password decrypts the file; the vault password seals
  // the result. The flows above never use this one, by design.
  assert.notEqual(BACKUP_PASSWORD, VAULT_PASSWORD)
})
