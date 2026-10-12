/**
 * Sealing backup secrets back into the vault (restore half of RA-03).
 *
 * An encrypted backup carries accounts and optionally a recovery phrase, but
 * writing them anywhere except the encrypted vault would recreate the
 * plaintext-storage problem the vault exists to solve. This module owns the
 * whole reseal: decide the resulting payload (pure, unit-tested), write it
 * through `vaultStore`, and verify the write by decrypting it again before
 * anyone is told the restore succeeded.
 */

import type { BackupContents, RestoreMode } from "./backup"
import { deriveAccounts } from "./hdWallet"
import { isVaultPayload, type VaultAccount, type VaultPayload } from "./schema"
import { assessPassword } from "./vault"
import { hasVault, saveVault, unlockVault, type VaultStoreResult } from "./vaultStore"

/** Whether a backup carries anything that belongs in the vault. */
export function backupHasSecrets(contents: BackupContents): boolean {
  return contents.mnemonic !== undefined || (contents.accounts?.length ?? 0) > 0
}

/** Outcome of planning a reseal, before anything is written. */
export interface RestoredSecretsPlan {
  payload: VaultPayload
  /** Incoming accounts that end up in the payload. */
  accountsIncluded: number
  /** True when a first account was derived from a phrase-only backup. */
  derivedFirstAccount: boolean
  /** True when the backup's phrase ends up as the payload's phrase. */
  mnemonicIncluded: boolean
}

export type RestoredSecretsPlanResult =
  | { ok: true; value: RestoredSecretsPlan }
  | { ok: false; error: string; conflict?: "mnemonic" }

/**
 * Decide the vault payload a restore should seal.
 *
 * Pure: no storage access, so every branch — create, replace, merge, and the
 * mnemonic conflict — is unit-testable.
 *
 * Merge rules:
 * - Accounts merge by address (case-insensitive); the existing record wins,
 *   so a merge can never silently replace a key the user already trusts.
 * - A mnemonic conflict (both sides hold a *different* phrase, or the same
 *   phrase with a different passphrase) is an explicit error, never a silent
 *   choice: discarding either phrase could strand funds. The user must use
 *   Replace mode, which is the deliberate way to give one up.
 *
 * A phrase-only backup (no accounts) derives its first account, matching
 * what creating a vault from that phrase produces.
 *
 * @param existing - Current decrypted payload, or null when no vault exists.
 * @param contents - Sanitized backup contents carrying secrets.
 * @param mode - Replace or merge; ignored when there is no existing vault.
 */
export function planRestoredSecrets(
  existing: VaultPayload | null,
  contents: BackupContents,
  mode: RestoreMode
): RestoredSecretsPlanResult {
  const incomingAccounts = contents.accounts ?? []
  const incomingMnemonic = contents.mnemonic
  const incomingPassphrase = contents.mnemonicPassphrase

  const buildAccounts = (
    mnemonic: string | undefined,
    passphrase: string | undefined,
    accounts: VaultAccount[]
  ): RestoredSecretsPlanResult | VaultAccount[] => {
    if (accounts.length > 0 || mnemonic === undefined) return accounts
    // Phrase-only backup: derive the first account so the restored vault is
    // immediately usable, exactly as a fresh import of the phrase would be.
    const derived = deriveAccounts({ mnemonic, passphrase: passphrase ?? "", count: 1 })
    if (!derived.ok) return { ok: false, error: derived.error }
    const first = derived.value[0]
    return [
      {
        id: `restored-${first.address.toLowerCase()}`,
        label: "Account 1",
        address: first.address,
        privateKey: first.privateKey,
        derivationIndex: first.index,
        derivationPath: first.path,
      },
    ]
  }

  if (existing === null || mode === "replace") {
    const accounts = buildAccounts(incomingMnemonic, incomingPassphrase, [...incomingAccounts])
    if (!Array.isArray(accounts)) return accounts
    const payload: VaultPayload = {
      mnemonic: incomingMnemonic,
      mnemonicPassphrase: incomingPassphrase,
      accounts,
    }
    if (!isVaultPayload(payload)) {
      return { ok: false, error: "The backup's secrets are not in a recognized format." }
    }
    return {
      ok: true,
      value: {
        payload,
        accountsIncluded: incomingAccounts.length,
        derivedFirstAccount: incomingAccounts.length === 0 && accounts.length > 0,
        mnemonicIncluded: incomingMnemonic !== undefined,
      },
    }
  }

  // Merge into an existing unlocked/decrypted payload.
  if (
    existing.mnemonic !== undefined &&
    incomingMnemonic !== undefined &&
    (existing.mnemonic !== incomingMnemonic ||
      (existing.mnemonicPassphrase ?? "") !== (incomingPassphrase ?? ""))
  ) {
    return {
      ok: false,
      conflict: "mnemonic",
      error:
        "This vault and the backup hold different recovery phrases. Merging would silently discard one of them, so the restore stopped. Use Replace mode if you intend to give up the current phrase, or back it up first.",
    }
  }

  const mnemonic = existing.mnemonic ?? incomingMnemonic
  const passphrase =
    existing.mnemonic !== undefined ? existing.mnemonicPassphrase : incomingPassphrase

  const byAddress = new Map(existing.accounts.map((a) => [a.address.toLowerCase(), a]))
  const usedIds = new Set(existing.accounts.map((a) => a.id))
  const mergedAccounts = [...existing.accounts]
  let accountsIncluded = 0
  for (const account of incomingAccounts) {
    if (byAddress.has(account.address.toLowerCase())) continue
    let id = account.id
    while (usedIds.has(id)) id = `${id}-restored`
    usedIds.add(id)
    mergedAccounts.push(id === account.id ? account : { ...account, id })
    accountsIncluded++
  }

  let finalAccounts = mergedAccounts
  if (finalAccounts.length === 0 && mnemonic !== undefined) {
    const derived = buildAccounts(mnemonic, passphrase, mergedAccounts)
    if (!Array.isArray(derived)) return derived
    finalAccounts = derived
  }

  const payload: VaultPayload = {
    mnemonic,
    mnemonicPassphrase: passphrase,
    accounts: finalAccounts,
  }
  if (!isVaultPayload(payload)) {
    return { ok: false, error: "The merged vault contents are not in a recognized format." }
  }
  return {
    ok: true,
    value: {
      payload,
      accountsIncluded,
      derivedFirstAccount: false,
      mnemonicIncluded: incomingMnemonic !== undefined && mnemonic === incomingMnemonic,
    },
  }
}

/** What a verified reseal actually wrote. */
export interface ResealedSecrets {
  /** The payload now sealed in the vault (verified by re-decryption). */
  payload: VaultPayload
  accountsIncluded: number
  derivedFirstAccount: boolean
  mnemonicIncluded: boolean
  /** True when this restore created the vault. */
  createdVault: boolean
}

/**
 * Seal a backup's accounts/mnemonic into the vault and verify the write.
 *
 * Credential handling covers the three restore situations:
 * - No vault exists: `password` is the NEW vault password the user just
 *   chose during the restore flow; its strength is enforced here.
 * - Vault exists and is unlocked: pass the live session as `unlockedSession`;
 *   its password is used and the payload merges against the in-memory copy.
 * - Vault exists and is locked: `password` must be the existing vault
 *   password; it is verified by decrypting the stored vault before anything
 *   is overwritten, so a wrong password changes nothing.
 *
 * The write is verified by decrypting the stored vault again and checking
 * the restored accounts and phrase are really there. Only then is success
 * returned — a success toast before this point would be a lie.
 */
export async function resealBackupSecrets(
  contents: BackupContents,
  mode: RestoreMode,
  password: string,
  unlockedSession?: { payload: VaultPayload; password: string } | null
): Promise<VaultStoreResult<ResealedSecrets>> {
  if (!backupHasSecrets(contents)) {
    return { ok: false, error: "This backup carries no accounts or recovery phrase to seal." }
  }

  const createdVault = !hasVault()
  let existing: VaultPayload | null = null

  if (createdVault) {
    const strength = assessPassword(password)
    if (!strength.acceptable) {
      return { ok: false, error: strength.issues[0] ?? "Choose a stronger vault password." }
    }
  } else if (unlockedSession && unlockedSession.password === password) {
    existing = unlockedSession.payload
  } else {
    const opened = await unlockVault(password)
    if (!opened.ok) {
      return {
        ok: false,
        error: "The vault password was not accepted, so nothing was restored.",
      }
    }
    existing = opened.value
  }

  const planned = planRestoredSecrets(existing, contents, createdVault ? "replace" : mode)
  if (!planned.ok) return { ok: false, error: planned.error }

  const saved = await saveVault(planned.value.payload, password)
  if (!saved.ok) return saved

  // Verify before success: re-decrypt what was actually stored.
  const verified = await unlockVault(password)
  if (!verified.ok) {
    return { ok: false, error: "The vault was written but could not be re-opened to verify it." }
  }
  const expectedAddresses = new Set(
    planned.value.payload.accounts.map((a) => a.address.toLowerCase())
  )
  const verifiedAddresses = new Set(verified.value.accounts.map((a) => a.address.toLowerCase()))
  const allPresent = [...expectedAddresses].every((address) => verifiedAddresses.has(address))
  const mnemonicPresent =
    planned.value.payload.mnemonic === undefined ||
    verified.value.mnemonic === planned.value.payload.mnemonic
  if (!allPresent || !mnemonicPresent) {
    return {
      ok: false,
      error: "The restored vault did not verify: its contents differ from what was written.",
    }
  }

  return {
    ok: true,
    value: {
      payload: verified.value,
      accountsIncluded: planned.value.accountsIncluded,
      derivedFirstAccount: planned.value.derivedFirstAccount,
      mnemonicIncluded: planned.value.mnemonicIncluded,
      createdVault,
    },
  }
}
