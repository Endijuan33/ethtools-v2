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

import { getAddress, isAddress, Wallet } from "ethers"
import { decryptJson, encryptJson, isEncryptedEnvelope } from "./vault"
import {
  DEFAULT_AUTOLOCK_MINUTES,
  isAutolockMinutes,
  isVaultAccount,
  isVaultPayload,
  type AutoLockMinutes,
  type VaultAccount,
  type VaultPayload,
} from "./schema"
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

/**
 * Read the configured idle auto-lock timeout.
 *
 * The stored value is untrusted, so it passes the schema's closed choice list;
 * anything absent, corrupt, or out of range resolves to the default. A hostile
 * write can therefore only pick one of the allowed timeouts — it can never
 * disable the idle lock.
 *
 * @returns Timeout in minutes.
 */
export function getAutolockMinutes(): AutoLockMinutes {
  return readJson<AutoLockMinutes>(
    STORAGE_KEYS.AUTOLOCK_MINUTES,
    isAutolockMinutes,
    DEFAULT_AUTOLOCK_MINUTES
  )
}

/**
 * Persist the idle auto-lock timeout.
 *
 * @param minutes - One of the allowed choices.
 */
export function setAutolockMinutes(minutes: AutoLockMinutes): WriteResult {
  return writeJson(STORAGE_KEYS.AUTOLOCK_MINUTES, minutes)
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
  return readRawLegacyEntries().filter(isLegacyWallet)
}

/**
 * Every entry in the legacy array, including malformed ones.
 *
 * Migration cleanup must account for entries {@link isLegacyWallet} rejects:
 * an entry can fail the shape check (for example a missing address) while
 * still carrying a usable private key, so deleting the whole legacy key
 * after migrating only the well-formed entries would destroy that key
 * unmigrated. Anything not positively migrated is preserved verbatim.
 */
function readRawLegacyEntries(): unknown[] {
  return readJson<unknown[]>(
    STORAGE_KEYS.LEGACY_WALLETS,
    (value): value is unknown[] => Array.isArray(value),
    []
  )
}

/**
 * The address a legacy record's key actually controls, or null when the
 * key material is unusable.
 *
 * The key - not the stored address - is the source of truth for a legacy
 * record: funds follow the key. A stored address that disagrees with the
 * derived one is a corrupt display value, so the migrated account carries
 * the derived (checksummed) address instead. A key that is not exactly 32
 * bytes of hex can control nothing and is the one case rejected outright.
 */
function deriveLegacyAddress(wallet: LegacyWallet): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(wallet.privateKey)) return null
  try {
    return new Wallet(wallet.privateKey).address
  } catch {
    return null
  }
}

/**
 * Move cleartext wallets into an encrypted vault and delete the originals.
 *
 * Safety contract:
 * - Only records holding a syntactically valid 32-byte private key are
 *   migrated, and each migrated account carries the address derived from
 *   its key - never the stored address - so a corrupt stored address
 *   cannot put a key in the vault under the wrong account. Records with
 *   unusable key material are reported as `skipped` and left in place so
 *   nothing is silently discarded.
 * - Duplicate addresses - inside the legacy list itself, or already present
 *   in the vault - are migrated at most once, so re-running is idempotent.
 * - The previous vault ciphertext is snapshotted first. The new ciphertext
 *   is written, read back, decrypted, and checked to contain every migrated
 *   address before any plaintext is removed; on any failure the snapshot is
 *   restored and the plaintext source is left untouched.
 * - When every entry migrated, the legacy key is removed entirely. When
 *   some entries were skipped - or could not even be shape-detected - the
 *   legacy key is rewritten with only those entries, preserved verbatim,
 *   so the exposure that remains is exactly what still needs attention
 *   and no unmigrated key material is ever deleted.
 * - Refuses to run without an `existing` payload when a vault already
 *   exists on this device: overwriting an unread vault with a legacy-only
 *   payload would destroy the accounts already inside it.
 *
 * @param password - Passphrase for the new vault.
 * @param existing - Vault contents to merge into, when a vault already exists.
 */
export async function migrateLegacyWallets(
  password: string,
  existing?: VaultPayload
): Promise<VaultStoreResult<{ migrated: number; skipped: number }>> {
  const rawEntries = readRawLegacyEntries()
  const legacy = rawEntries.filter(isLegacyWallet)
  const undetected = rawEntries.filter((entry) => !isLegacyWallet(entry))
  if (legacy.length === 0) {
    return { ok: true, value: { migrated: 0, skipped: undetected.length } }
  }

  if (existing === undefined && hasVault()) {
    return {
      ok: false,
      error:
        "Unlock the existing vault first so the older wallets can be merged into it safely.",
    }
  }

  const known = new Set((existing?.accounts ?? []).map((a) => a.address.toLowerCase()))
  const seen = new Set<string>()
  const imported: VaultAccount[] = []
  const skipped: LegacyWallet[] = []
  // Records that may be removed from plaintext once the vault verifies:
  // everything that migrated, plus duplicates of an address that is (or
  // will be) in the vault.
  const removable = new Set<LegacyWallet>()

  for (const wallet of legacy) {
    const derivedAddress = deriveLegacyAddress(wallet)
    if (derivedAddress === null) {
      skipped.push(wallet)
      continue
    }
    const addressKey = derivedAddress.toLowerCase()
    if (known.has(addressKey) || seen.has(addressKey)) {
      removable.add(wallet)
      continue
    }
    seen.add(addressKey)
    imported.push({
      id: wallet.id,
      label: wallet.label,
      address: derivedAddress,
      privateKey: wallet.privateKey,
    })
    removable.add(wallet)
  }

  const payload: VaultPayload = {
    ...existing,
    accounts: [...(existing?.accounts ?? []), ...imported],
  }

  if (!payload.accounts.every(isVaultAccount)) {
    return {
      ok: false,
      error: "Migration was aborted because a wallet record is not in a recognized format.",
    }
  }

  // Snapshot the current ciphertext so a failed verification can restore it
  // instead of leaving a half-migrated vault behind.
  const previousVaultRaw = readRaw(STORAGE_KEYS.VAULT)
  const rollbackVault = (): void => {
    if (previousVaultRaw === null) removeKey(STORAGE_KEYS.VAULT)
    else writeRaw(STORAGE_KEYS.VAULT, previousVaultRaw)
  }

  const saved = await saveVault(payload, password)
  if (!saved.ok) return saved

  // Confirm the ciphertext is readable, and that it actually contains every
  // migrated account, before destroying the only other copy of those keys.
  const verify = await unlockVault(password)
  if (!verify.ok) {
    rollbackVault()
    return {
      ok: false,
      error: "Migration was aborted because the encrypted copy could not be verified.",
    }
  }
  const verifiedAddresses = new Set(verify.value.accounts.map((a) => a.address.toLowerCase()))
  const allPresent = imported.every((a) => verifiedAddresses.has(a.address.toLowerCase()))
  if (!allPresent) {
    rollbackVault()
    return {
      ok: false,
      error: "Migration was aborted because the encrypted copy is missing migrated accounts.",
    }
  }

  // The vault now provably holds the migrated keys; only now may plaintext
  // go - and only the plaintext that was positively migrated. Skipped and
  // undetected entries are preserved verbatim: an undetected entry may
  // still carry the only copy of a usable key.
  const preserved: unknown[] = [...skipped, ...undetected]
  if (preserved.length === 0) {
    removeKey(STORAGE_KEYS.LEGACY_WALLETS)
  } else if (removable.size > 0) {
    const kept = writeJson(STORAGE_KEYS.LEGACY_WALLETS, preserved)
    if (!kept.ok) {
      return {
        ok: false,
        error:
          "The wallets were encrypted into the vault, but the old unencrypted copies could not be cleaned up. Unlock the vault again to retry the cleanup.",
      }
    }
  }

  return {
    ok: true,
    value: { migrated: imported.length, skipped: skipped.length + undetected.length },
  }
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

// ===== Watch-only accounts =====

/** Generate an id, preferring the platform UUID when it is available. */
function createId(): string {
  const platformCrypto = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto
  if (platformCrypto !== undefined && typeof platformCrypto.randomUUID === "function") {
    return platformCrypto.randomUUID()
  }
  return `account-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Add a watch-only (observability) account to an unlocked vault and persist it.
 *
 * A watch-only account stores an address and a label and nothing else — no key,
 * no derivation data — so displaying it can never require a secret. The address
 * is normalized to its EIP-55 checksum form before encryption, because for a
 * hand-entered address the checksum is the only protection against a typo that
 * would attribute someone else's funds to this vault.
 *
 * @param current - Currently unlocked payload.
 * @param account - Label and address to add.
 * @param password - Passphrase to re-seal with.
 */
export async function addWatchOnlyAccountToVault(
  current: VaultPayload,
  account: { label: string; address: string },
  password: string
): Promise<VaultStoreResult<VaultPayload>> {
  const label = account.label.trim()
  if (label === "") return { ok: false, error: "Enter a label." }
  if (label.length > 128) {
    return { ok: false, error: "Choose a label of 128 characters or fewer." }
  }

  const trimmed = account.address.trim()
  if (!isAddress(trimmed)) {
    return { ok: false, error: "This is not a valid Ethereum address." }
  }
  let checksummed: string
  try {
    checksummed = getAddress(trimmed)
  } catch {
    return { ok: false, error: "This is not a valid Ethereum address." }
  }

  // A duplicate would only ever show one of the two entries as active.
  const duplicate = current.accounts.some(
    (a) => a.address.toLowerCase() === checksummed.toLowerCase()
  )
  if (duplicate) {
    return { ok: false, error: "An account with this address is already in the vault." }
  }

  const added: VaultAccount = {
    id: createId(),
    label,
    address: checksummed,
    watchOnly: true,
  }

  // The whole payload is re-validated on every unlock, so an account that
  // fails validation must never be written: it would make the vault — including
  // every key-holding account in it — unreadable with its own password.
  if (!isVaultAccount(added)) {
    return { ok: false, error: "That watch address could not be added." }
  }

  const payload: VaultPayload = { ...current, accounts: [...current.accounts, added] }
  const saved = await saveVault(payload, password)
  if (!saved.ok) return saved
  return { ok: true, value: payload }
}
