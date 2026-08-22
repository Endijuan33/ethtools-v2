/**
 * Encrypted vault persistence.
 *
 * Separates *where* the vault lives from *how* it is encrypted (`lib/vault.ts`)
 * and from the React state that holds it while unlocked. Keeping this free of
 * React makes it directly testable.
 *
 * Invariants:
 * - Only ciphertext is ever written. A decrypted payload exists in memory only.
 * - Reading the vault always validates the decrypted shape before returning it,
 *   because `localStorage` is writable by anything running on the origin.
 * - Legacy cleartext wallets are migrated into the vault and then deleted, so
 *   the plaintext copy does not linger after a password is set.
 */

import { decryptJson, encryptJson, isEncryptedEnvelope } from "./vault"
import { isVaultPayload, type VaultAccount, type VaultPayload } from "./schema"
import {
  readJson,
  readRaw,
  removeKey,
  STORAGE_KEYS,
  writeJson,
  writeRaw,
  type WriteResult,
} from "./storage"

/** Outcome of a vault operation. */
export type VaultStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/** A wallet from the pre-vault cleartext format. */
export interface LegacyWallet {
  id: string
  label: string
  address: string
  privateKey: string
}

/** Whether an encrypted vault exists on this device. */
export function hasVault(): boolean {
  const raw = readRaw(STORAGE_KEYS.VAULT)
  if (raw === null) return false
  try {
    return isEncryptedEnvelope(JSON.parse(raw))
  } catch {
    return false
  }
}

/**
 * Encrypt a payload and persist it, replacing any existing vault.
 *
 * @param payload - Decrypted vault contents.
 * @param password - Passphrase to seal with.
 */
export async function saveVault(
  payload: VaultPayload,
  password: string
): Promise<VaultStoreResult<void>> {
  const sealed = await encryptJson(payload, password)
  if (!sealed.ok) return { ok: false, error: sealed.error }

  const written = writeJson(STORAGE_KEYS.VAULT, sealed.value)
  if (!written.ok) return { ok: false, error: written.error }

  return { ok: true, value: undefined }
}

/**
 * Read, decrypt, and validate the vault.
 *
 * @param password - Candidate passphrase.
 */
export async function unlockVault(password: string): Promise<VaultStoreResult<VaultPayload>> {
  const raw = readRaw(STORAGE_KEYS.VAULT)
  if (raw === null) return { ok: false, error: "No wallet has been created on this device yet." }

  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  } catch {
    return { ok: false, error: "The stored wallet data is corrupted and cannot be read." }
  }

  const opened = await decryptJson<unknown>(envelope, password)
  if (!opened.ok) return { ok: false, error: opened.error }

  if (!isVaultPayload(opened.value)) {
    return {
      ok: false,
      error: "The wallet decrypted but its contents are not in a recognized format.",
    }
  }

  return { ok: true, value: opened.value }
}

/**
 * Change the vault password by re-encrypting the same contents.
 *
 * The new ciphertext is only written after the old password successfully
 * decrypts, so a wrong current password cannot destroy the vault.
 *
 * @param currentPassword - Existing passphrase.
 * @param newPassword - Replacement passphrase.
 */
export async function changeVaultPassword(
  currentPassword: string,
  newPassword: string
): Promise<VaultStoreResult<void>> {
  const opened = await unlockVault(currentPassword)
  if (!opened.ok) return opened
  return saveVault(opened.value, newPassword)
}

/** Delete the vault. Irreversible without a backup. */
export function deleteVault(): void {
  removeKey(STORAGE_KEYS.VAULT)
}

/** Persist which account is selected. Not secret. */
export function setActiveAccountId(id: string | null): WriteResult {
  if (id === null) {
    removeKey(STORAGE_KEYS.ACTIVE_WALLET)
    return { ok: true }
  }
  return writeRaw(STORAGE_KEYS.ACTIVE_WALLET, id)
}

/** The selected account id, if any. */
export function getActiveAccountId(): string | null {
  return readRaw(STORAGE_KEYS.ACTIVE_WALLET)
}

// ===== Legacy migration =====

/** Shape check for a wallet in the pre-vault cleartext format. */
function isLegacyWallet(value: unknown): value is LegacyWallet {
  if (typeof value !== "object" || value === null) return false
  const w = value as Record<string, unknown>
  return (
    typeof w.id === "string" &&
    typeof w.label === "string" &&
    typeof w.address === "string" &&
    typeof w.privateKey === "string" &&
    w.privateKey.length > 0
  )
}

/**
 * Find wallets still stored in the old cleartext format.
 *
 * Their mere presence is a live exposure: the keys sit unencrypted in
 * `localStorage`, readable by any script on the origin.
 */
export function detectLegacyWallets(): LegacyWallet[] {
  return readJson<LegacyWallet[]>(
    STORAGE_KEYS.LEGACY_WALLETS,
    (value): value is LegacyWallet[] => Array.isArray(value),
    []
  ).filter(isLegacyWallet)
}

/**
 * Move cleartext wallets into an encrypted vault and delete the originals.
 *
 * Ordering matters: the encrypted copy is written and read back before the
 * plaintext is removed, so a failure part-way cannot lose keys.
 *
 * @param password - Passphrase for the new vault.
 * @param existing - Vault contents to merge into, when a vault already exists.
 */
export async function migrateLegacyWallets(
  password: string,
  existing?: VaultPayload
): Promise<VaultStoreResult<{ migrated: number }>> {
  const legacy = detectLegacyWallets()
  if (legacy.length === 0) return { ok: true, value: { migrated: 0 } }

  const known = new Set((existing?.accounts ?? []).map((a) => a.address.toLowerCase()))
  const imported: VaultAccount[] = legacy
    .filter((wallet) => !known.has(wallet.address.toLowerCase()))
    .map((wallet) => ({
      id: wallet.id,
      label: wallet.label,
      address: wallet.address,
      privateKey: wallet.privateKey,
    }))

  const payload: VaultPayload = {
    ...existing,
    accounts: [...(existing?.accounts ?? []), ...imported],
  }

  const saved = await saveVault(payload, password)
  if (!saved.ok) return saved

  // Confirm the ciphertext is readable before destroying the only other copy.
  const verify = await unlockVault(password)
  if (!verify.ok) {
    return {
      ok: false,
      error: "Migration was aborted because the encrypted copy could not be verified.",
    }
  }

  removeKey(STORAGE_KEYS.LEGACY_WALLETS)
  return { ok: true, value: { migrated: imported.length } }
}

/**
 * Create a vault from a recovery phrase and its derived accounts.
 *
 * @param params - Phrase, optional passphrase, accounts, and the vault password.
 */
export async function createVault(params: {
  mnemonic?: string
  mnemonicPassphrase?: string
  accounts: VaultAccount[]
  password: string
}): Promise<VaultStoreResult<VaultPayload>> {
  const payload: VaultPayload = {
    mnemonic: params.mnemonic,
    mnemonicPassphrase: params.mnemonicPassphrase,
    accounts: params.accounts,
  }
  const saved = await saveVault(payload, params.password)
  if (!saved.ok) return saved
  return { ok: true, value: payload }
}

/**
 * Add accounts to an unlocked vault and persist the result.
 *
 * Existing addresses are skipped rather than duplicated.
 *
 * @param current - Currently unlocked payload.
 * @param accounts - Accounts to add.
 * @param password - Passphrase to re-seal with.
 */
export async function addAccountsToVault(
  current: VaultPayload,
  accounts: VaultAccount[],
  password: string
): Promise<VaultStoreResult<VaultPayload>> {
  const known = new Set(current.accounts.map((a) => a.address.toLowerCase()))
  const added = accounts.filter((a) => !known.has(a.address.toLowerCase()))

  const payload: VaultPayload = { ...current, accounts: [...current.accounts, ...added] }
  const saved = await saveVault(payload, password)
  if (!saved.ok) return saved
  return { ok: true, value: payload }
}

/**
 * Remove an account from an unlocked vault and persist the result.
 *
 * @param current - Currently unlocked payload.
 * @param accountId - Identifier of the account to remove.
 * @param password - Passphrase to re-seal with.
 */
export async function removeAccountFromVault(
  current: VaultPayload,
  accountId: string,
  password: string
): Promise<VaultStoreResult<VaultPayload>> {
  const payload: VaultPayload = {
    ...current,
    accounts: current.accounts.filter((a) => a.id !== accountId),
  }
  const saved = await saveVault(payload, password)
  if (!saved.ok) return saved
  return { ok: true, value: payload }
}
