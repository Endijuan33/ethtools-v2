/**
 * Backup export and restore.
 *
 * Three rules drive this module, each answering a specific failure of the
 * previous implementation:
 *
 * 1. A backup that contains secrets is **always** encrypted. Writing a
 *    cleartext private key to the filesystem is the one thing this app must
 *    never do, so the plaintext path physically cannot carry key material.
 * 2. Import performs **deep** validation of every record. A backup file is
 *    untrusted input; an unvalidated `explorerUrl` reaches an anchor `href` and
 *    an unvalidated `rpcUrls` reroutes every request the wallet makes.
 * 3. Restore is **atomic**. A half-applied restore that replaces accounts but
 *    drops history is worse than a clean rejection.
 */

import {
  decryptJson,
  encryptJson,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from "./vault"
import {
  filterValid,
  filterValidCustomNetworks,
  isStoredBookmark,
  isStoredToken,
  isStoredTransaction,
  isVaultAccount,
  type StoredBookmark,
  type StoredCustomNetwork,
  type StoredToken,
  type StoredTransaction,
  type VaultAccount,
} from "./schema"
import {
  readJson,
  readRaw,
  STORAGE_KEYS,
  writeJsonAtomic,
  type WriteResult,
} from "./storage"
import { APP_EVENTS, emitAppEvent } from "./appEvents"

/** Marker identifying a file produced by this app. */
export const BACKUP_FORMAT = "ethtools-backup"

/** Current backup schema version. */
export const BACKUP_VERSION = 2

/** Largest backup file accepted on import, to bound memory use. */
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024

/** Everything a backup can carry. */
export interface BackupContents {
  /**
   * Recovery phrase. Present only in an encrypted backup.
   * A phrase compromises every account derivable from it, forever.
   */
  mnemonic?: string
  /** BIP-39 passphrase paired with `mnemonic`. Encrypted backups only. */
  mnemonicPassphrase?: string
  /** Accounts, including private keys. Encrypted backups only. */
  accounts?: VaultAccount[]
  /** Identifier of the account that was selected. */
  activeAccountId: string | null
  bookmarks: StoredBookmark[]
  transactions: StoredTransaction[]
  customNetworks: Record<string, StoredCustomNetwork>
  tokens: StoredToken[]
}

/** A backup file, encrypted or not. */
export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: number
  /** True when `data` is an encrypted envelope. */
  encrypted: boolean
  /** Envelope when encrypted, otherwise secret-free contents. */
  data: EncryptedEnvelope | BackupContents
}

/** Outcome of a backup operation. */
export type BackupResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/** What a restore actually wrote, for user confirmation. */
export interface RestoreSummary {
  accounts: number
  bookmarks: number
  transactions: number
  customNetworks: number
  tokens: number
  /** True when the file carried an encrypted recovery phrase. */
  includedMnemonic: boolean
  /** Records dropped because they failed validation. */
  droppedRecords: number
}

/** How an import should combine with existing data. */
export type RestoreMode = "replace" | "merge"

// ===== Reading current state =====

/**
 * Collect the non-secret data currently in storage.
 *
 * Secrets live in the encrypted vault and are added separately, only on the
 * encrypted path.
 */
function readNonSecretState(): Omit<BackupContents, "mnemonic" | "mnemonicPassphrase" | "accounts"> {
  return {
    activeAccountId: readRaw(STORAGE_KEYS.ACTIVE_WALLET),
    bookmarks: readJson<StoredBookmark[]>(
      STORAGE_KEYS.BOOKMARKS,
      (v): v is StoredBookmark[] => Array.isArray(v),
      []
    ).filter(isStoredBookmark),
    transactions: readJson<StoredTransaction[]>(
      STORAGE_KEYS.TRANSACTION_HISTORY,
      (v): v is StoredTransaction[] => Array.isArray(v),
      []
    ).filter(isStoredTransaction),
    customNetworks: filterValidCustomNetworks(
      readJson<unknown>(STORAGE_KEYS.CUSTOM_NETWORKS, (v): v is unknown => true, {})
    ),
    tokens: readJson<StoredToken[]>(
      STORAGE_KEYS.TOKENS,
      (v): v is StoredToken[] => Array.isArray(v),
      []
    ).filter(isStoredToken),
  }
}

// ===== Export =====

/**
 * Build an encrypted backup containing everything, including secrets.
 *
 * @param secrets - Decrypted vault contents to include.
 * @param password - Passphrase protecting the file. Reuse of the vault password
 *   is fine and is what most users expect.
 */
export async function createEncryptedBackup(
  secrets: Pick<BackupContents, "mnemonic" | "mnemonicPassphrase" | "accounts">,
  password: string
): Promise<BackupResult<BackupFile>> {
  const contents: BackupContents = {
    ...readNonSecretState(),
    mnemonic: secrets.mnemonic,
    mnemonicPassphrase: secrets.mnemonicPassphrase,
    accounts: secrets.accounts,
  }

  const sealed = await encryptJson(contents, password)
  if (!sealed.ok) return { ok: false, error: sealed.error }

  return {
    ok: true,
    value: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: Date.now(),
      encrypted: true,
      data: sealed.value,
    },
  }
}

/**
 * Build an unencrypted backup of settings only.
 *
 * By construction this cannot contain a phrase, a private key, or an account
 * list: it is built from {@link readNonSecretState} and never receives secrets.
 * Offered so users can move bookmarks and networks between devices without
 * handling a password.
 */
export function createSettingsBackup(): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    encrypted: false,
    data: { ...readNonSecretState() },
  }
}

/**
 * Serialize a backup to a downloadable JSON string.
 * @param file - Backup to serialize.
 */
export function serializeBackup(file: BackupFile): string {
  return JSON.stringify(file, null, 2)
}

/**
 * Suggested filename for a backup, distinguishing encrypted from settings-only.
 * @param file - Backup being saved.
 */
export function backupFilename(file: BackupFile): string {
  const date = new Date(file.createdAt).toISOString().slice(0, 10)
  const kind = file.encrypted ? "encrypted" : "settings"
  return `ethtools-${kind}-backup-${date}.json`
}

/**
 * Practical capacity of a QR code at error-correction level M, in characters.
 * Beyond roughly this size the modules become too dense for a phone camera to
 * read reliably off a screen.
 */
export const MAX_QR_CHARS = 1800

/** Secret material eligible for a QR backup. */
export type SecretPayload = Pick<
  BackupContents,
  "mnemonic" | "mnemonicPassphrase" | "accounts"
>

/**
 * Encrypt only the secret material, for display as a QR code.
 *
 * Deliberately excludes bookmarks, history, networks, and tokens: those would
 * push the payload past what a camera can reliably scan, and a QR backup exists
 * to recover funds, not settings.
 *
 * The result is still encrypted, so a photograph of the code is useless without
 * the password.
 *
 * @param secrets - Decrypted secret material.
 * @param password - Passphrase protecting the payload.
 */
export async function createSecretsQrPayload(
  secrets: SecretPayload,
  password: string
): Promise<BackupResult<{ payload: string; chars: number }>> {
  if (secrets.mnemonic === undefined && (secrets.accounts?.length ?? 0) === 0) {
    return { ok: false, error: "There is nothing to back up yet." }
  }

  const sealed = await encryptJson(secrets, password)
  if (!sealed.ok) return { ok: false, error: sealed.error }

  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    encrypted: true,
    data: sealed.value,
  }

  // Compact form: a QR code has no use for indentation.
  const payload = JSON.stringify(file)
  if (payload.length > MAX_QR_CHARS) {
    return {
      ok: false,
      error: `This backup is ${payload.length} characters, which is too dense to scan reliably. Remove some imported accounts or use a file backup instead.`,
    }
  }

  return { ok: true, value: { payload, chars: payload.length } }
}

// ===== Import =====

/** Structural check for the outer backup wrapper. */
function isBackupFile(value: unknown): value is BackupFile {
  if (typeof value !== "object" || value === null) return false
  const f = value as Record<string, unknown>
  return (
    f.format === BACKUP_FORMAT &&
    typeof f.version === "number" &&
    typeof f.createdAt === "number" &&
    typeof f.encrypted === "boolean" &&
    typeof f.data === "object" &&
    f.data !== null
  )
}

/**
 * Parse the outer wrapper of a backup file without decrypting it.
 *
 * Lets the UI decide whether to prompt for a password before doing any work.
 *
 * @param raw - Raw file text.
 */
export function inspectBackup(
  raw: string
): BackupResult<{ file: BackupFile; requiresPassword: boolean }> {
  if (raw.length > MAX_BACKUP_BYTES) {
    return { ok: false, error: "This file is too large to be a valid backup." }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: "This file is not valid JSON." }
  }

  if (!isBackupFile(parsed)) {
    return { ok: false, error: "This file is not an EthTools backup." }
  }
  if (parsed.version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `This backup was made by a newer version (format ${parsed.version}). Update the app first.`,
    }
  }
  if (parsed.encrypted && !isEncryptedEnvelope(parsed.data)) {
    return { ok: false, error: "This backup is marked encrypted but its payload is malformed." }
  }

  return { ok: true, value: { file: parsed, requiresPassword: parsed.encrypted } }
}

/**
 * Validate and normalize backup contents, dropping unusable records.
 *
 * Returns the sanitized contents plus how many records were discarded, so the
 * UI can tell the user their backup was partially corrupt rather than silently
 * importing less than they expect.
 *
 * @param value - Decrypted or plaintext contents of unknown shape.
 * @param reservedNetworkKeys - Built-in network keys a custom network may not
 *   shadow. Passed in so this module stays independent of the network registry.
 */
export function sanitizeBackupContents(
  value: unknown,
  reservedNetworkKeys: readonly string[] = []
): BackupResult<{ contents: BackupContents; dropped: number }> {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "Backup contents are malformed." }
  }
  const raw = value as Record<string, unknown>

  let dropped = 0
  const countDropped = (input: unknown, kept: number): void => {
    if (Array.isArray(input)) dropped += Math.max(0, input.length - kept)
  }

  const bookmarks = filterValid(raw.bookmarks, isStoredBookmark)
  countDropped(raw.bookmarks, bookmarks.length)

  const transactions = filterValid(raw.transactions, isStoredTransaction)
  countDropped(raw.transactions, transactions.length)

  const tokens = filterValid(raw.tokens, isStoredToken)
  countDropped(raw.tokens, tokens.length)

  const accounts = raw.accounts === undefined ? undefined : filterValid(raw.accounts, isVaultAccount)
  if (accounts) countDropped(raw.accounts, accounts.length)

  // Drop networks that fail validation, then drop any that would shadow a
  // built-in key. Shadowing "mainnet" would silently repoint Ethereum Mainnet
  // at an attacker's RPC.
  const validated = filterValidCustomNetworks(raw.customNetworks)
  const customNetworks: Record<string, StoredCustomNetwork> = {}
  for (const [key, config] of Object.entries(validated)) {
    if (reservedNetworkKeys.includes(key)) {
      dropped++
      continue
    }
    customNetworks[key] = config
  }
  if (typeof raw.customNetworks === "object" && raw.customNetworks !== null) {
    const submitted = Object.keys(raw.customNetworks as Record<string, unknown>).length
    dropped += Math.max(0, submitted - Object.keys(validated).length)
  }

  const mnemonic = typeof raw.mnemonic === "string" && raw.mnemonic.length > 0 ? raw.mnemonic : undefined
  const mnemonicPassphrase =
    typeof raw.mnemonicPassphrase === "string" ? raw.mnemonicPassphrase : undefined

  return {
    ok: true,
    value: {
      dropped,
      contents: {
        mnemonic,
        mnemonicPassphrase,
        accounts,
        activeAccountId:
          typeof raw.activeAccountId === "string" ? raw.activeAccountId : null,
        bookmarks,
        transactions,
        customNetworks,
        tokens,
      },
    },
  }
}

/**
 * Decrypt an encrypted backup's payload.
 *
 * @param file - Wrapper returned by {@link inspectBackup}.
 * @param password - Candidate passphrase.
 */
export async function decryptBackup(
  file: BackupFile,
  password: string
): Promise<BackupResult<unknown>> {
  if (!file.encrypted) return { ok: true, value: file.data }

  const opened = await decryptJson<unknown>(file.data, password)
  if (!opened.ok) return { ok: false, error: opened.error }
  return { ok: true, value: opened.value }
}

/** Combine two record lists, preferring existing entries on id collision. */
function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((item) => item.id))
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))]
}

/** Combine transaction lists, de-duplicating on hash. */
function mergeByHash(
  existing: StoredTransaction[],
  incoming: StoredTransaction[]
): StoredTransaction[] {
  const seen = new Set(existing.map((tx) => tx.hash))
  return [...existing, ...incoming.filter((tx) => !seen.has(tx.hash))]
}

/**
 * Write validated non-secret data to storage.
 *
 * Secrets are deliberately **not** written here: the caller re-seals them into
 * the encrypted vault, so this function never handles key material.
 *
 * @param contents - Sanitized contents.
 * @param mode - Replace existing data or merge into it.
 */
export function applyNonSecretRestore(
  contents: BackupContents,
  mode: RestoreMode
): WriteResult {
  let bookmarks = contents.bookmarks
  let transactions = contents.transactions
  let tokens = contents.tokens
  let customNetworks = contents.customNetworks

  if (mode === "merge") {
    const currentState = readNonSecretState()
    bookmarks = mergeById(currentState.bookmarks, bookmarks)
    transactions = mergeByHash(currentState.transactions, transactions)
    // Tokens have no id; de-duplicate on network plus contract address.
    const tokenKey = (t: StoredToken): string => `${t.network}:${t.address.toLowerCase()}`
    const seenTokens = new Set(currentState.tokens.map(tokenKey))
    tokens = [...currentState.tokens, ...tokens.filter((t) => !seenTokens.has(tokenKey(t)))]
    // Existing network definitions win, so a merge cannot silently repoint one.
    customNetworks = { ...customNetworks, ...currentState.customNetworks }
  }

  const result = writeJsonAtomic([
    { key: STORAGE_KEYS.BOOKMARKS, value: bookmarks },
    { key: STORAGE_KEYS.TRANSACTION_HISTORY, value: transactions },
    { key: STORAGE_KEYS.CUSTOM_NETWORKS, value: customNetworks },
    { key: STORAGE_KEYS.TOKENS, value: tokens },
  ])

  // Notify every component that caches storage-backed state. Without this a
  // restored custom network stays invisible until a manual page reload.
  if (result.ok) emitAppEvent(APP_EVENTS.DATA_RESTORED)

  return result
}

/**
 * Summarize what a restore will write, for a confirmation step.
 *
 * @param contents - Sanitized contents.
 * @param dropped - Records discarded during validation.
 */
export function summarizeRestore(
  contents: BackupContents,
  dropped: number
): RestoreSummary {
  return {
    accounts: contents.accounts?.length ?? 0,
    bookmarks: contents.bookmarks.length,
    transactions: contents.transactions.length,
    customNetworks: Object.keys(contents.customNetworks).length,
    tokens: contents.tokens.length,
    includedMnemonic: contents.mnemonic !== undefined,
    droppedRecords: dropped,
  }
}
