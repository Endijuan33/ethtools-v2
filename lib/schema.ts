/**
 * Runtime validation for everything that crosses a trust boundary.
 *
 * Two untrusted sources feed this app's state: `localStorage` (which any script
 * on the origin can rewrite) and imported backup files. A shallow
 * `Array.isArray` check is not enough — an unvalidated record can carry a
 * hostile `explorerUrl` that later lands in an anchor `href`, or RPC endpoints
 * that silently reroute every request. These guards validate every field and
 * drop records that fail.
 */

import { getAddress, isAddress } from "ethers"

// ===== Primitives =====

/** Whether a value is a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Whether a value is a non-empty string, optionally length-capped. */
export function isNonEmptyString(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
}

/** Whether a value is a finite integer within an inclusive range. */
export function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

/**
 * Whether a string is an `https:` URL.
 *
 * Enforced on every stored URL. `javascript:` is the direct XSS vector when a
 * value reaches an `href`; `http:` would be blocked as mixed content on the
 * HTTPS deployment and would expose RPC traffic in cleartext anyway.
 *
 * @param value - Candidate URL.
 */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

/** Whether a value is a checksum-valid or lowercase Ethereum address. */
export function isEthAddress(value: unknown): value is string {
  return typeof value === "string" && isAddress(value)
}

/**
 * Whether a string is an Ethereum address in exact EIP-55 checksum form.
 *
 * Required for watch-only accounts: their address arrives from user input
 * instead of being derived from a key, so the checksum is the only check that
 * catches a mistyped character before funds are attributed to the wrong
 * account. A lowercase address is valid but must be normalized before storing.
 *
 * @param value - Candidate address.
 */
export function isChecksummedAddress(value: unknown): value is string {
  if (typeof value !== "string" || !isAddress(value)) return false
  try {
    return getAddress(value) === value
  } catch {
    return false
  }
}

/** Whether a value is a 32-byte hex transaction hash. */
export function isTxHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
}

/**
 * Keep only the array entries that satisfy a guard.
 *
 * Preferred over rejecting a whole payload: one corrupt bookmark should not
 * discard the other forty.
 *
 * @param value - Candidate array of unknown provenance.
 * @param guard - Per-item type guard.
 * @param maxItems - Hard cap to bound memory from a hostile file.
 */
export function filterValid<T>(
  value: unknown,
  guard: (item: unknown) => item is T,
  maxItems = 5000
): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    if (out.length >= maxItems) break
    if (guard(item)) out.push(item)
  }
  return out
}

// ===== Domain shapes =====

/** A wallet account held inside the encrypted vault. */
export interface VaultAccount {
  id: string
  label: string
  address: string
  /** Present for accounts imported as a raw key. */
  privateKey?: string
  /** Index into the seed's derivation path, for seed-derived accounts. */
  derivationIndex?: number
  /** Full derivation path used, for seed-derived accounts. */
  derivationPath?: string
  /**
   * True for an observability-only account: an address and a label with no key
   * material of any kind. Absent on every key-holding account, so existing
   * vault payloads stay valid unchanged.
   */
  watchOnly?: boolean
}

/** Decrypted vault contents. Only ever exists in memory while unlocked. */
export interface VaultPayload {
  /** BIP-39 phrase, present only when the user chose to store a seed. */
  mnemonic?: string
  /** Optional BIP-39 passphrase ("25th word") paired with the mnemonic. */
  mnemonicPassphrase?: string
  accounts: VaultAccount[]
}

/** Whether a value is a valid vault account. */
export function isVaultAccount(value: unknown): value is VaultAccount {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value.id, 128)) return false
  if (!isNonEmptyString(value.label, 128)) return false
  if (!isEthAddress(value.address)) return false
  if (value.privateKey !== undefined && !isNonEmptyString(value.privateKey, 200)) return false
  if (
    value.derivationIndex !== undefined &&
    !isIntegerInRange(value.derivationIndex, 0, 2_147_483_647)
  ) {
    return false
  }
  if (value.derivationPath !== undefined && !isNonEmptyString(value.derivationPath, 128)) {
    return false
  }
  if (value.watchOnly !== undefined && typeof value.watchOnly !== "boolean") return false
  if (value.watchOnly === true) {
    // A watch-only account is address-only by construction. A record claiming
    // the flag while carrying a key or derivation data is corrupt or hostile,
    // and accepting it would blur the one boundary this vault depends on: a
    // watch-only account must never require a secret.
    if (value.privateKey !== undefined) return false
    if (value.derivationPath !== undefined) return false
    if (value.derivationIndex !== undefined) return false
    // The address was hand-entered rather than derived from a key, so only the
    // exact EIP-55 checksum form is accepted — it is the sole typo check left.
    if (!isChecksummedAddress(value.address)) return false
  }
  return true
}

/** Whether a value is a valid decrypted vault payload. */
export function isVaultPayload(value: unknown): value is VaultPayload {
  if (!isRecord(value)) return false
  if (value.mnemonic !== undefined && !isNonEmptyString(value.mnemonic, 1024)) return false
  if (
    value.mnemonicPassphrase !== undefined &&
    typeof value.mnemonicPassphrase !== "string"
  ) {
    return false
  }
  if (!Array.isArray(value.accounts)) return false
  return value.accounts.every(isVaultAccount)
}

// ===== Vault auto-lock =====

/** Idle timeouts the vault may be configured to lock after, in minutes. */
export const AUTOLOCK_MINUTES_CHOICES = [1, 5, 15, 30] as const

/** A permitted idle timeout, in minutes. */
export type AutoLockMinutes = (typeof AUTOLOCK_MINUTES_CHOICES)[number]

/** The timeout applied when no valid preference is stored. */
export const DEFAULT_AUTOLOCK_MINUTES: AutoLockMinutes = 5

/**
 * Whether a value is a permitted auto-lock timeout.
 *
 * A closed list rather than a numeric range: the value is untrusted storage
 * that feeds a timer, and a corrupted entry must resolve to the default rather
 * than to zero (which would disable the lock) or to something enormous.
 *
 * @param value - Candidate timeout in minutes.
 */
export function isAutolockMinutes(value: unknown): value is AutoLockMinutes {
  return (
    typeof value === "number" && (AUTOLOCK_MINUTES_CHOICES as readonly number[]).includes(value)
  )
}

// ===== Passkey unlock envelope =====

/** Current passkey-unlock envelope format version. Bump on breaking changes. */
export const PASSKEY_ENVELOPE_VERSION = 1

/** The vault password wrapped under a WebAuthn PRF-derived AES-GCM key. */
export interface PasskeyWrappedPassword {
  /** Base64 12-byte AES-GCM initialization vector. */
  iv: string
  /** Base64 AES-GCM ciphertext of the password, authentication tag appended. */
  cipher: string
}

/**
 * The additive "Unlock with passkey" record.
 *
 * This is NOT the vault: the canonical encrypted vault in `lib/vaultStore.ts`
 * is untouched. It is a second envelope that stores the vault password itself,
 * encrypted under a key only the matching passkey's PRF output can re-derive.
 * Without the credential the record is inert ciphertext, so corrupting it can
 * only disable the feature — never bypass the password.
 *
 * @see lib/webauthnUnlock.ts for the ceremony that produces and consumes it.
 */
export interface PasskeyUnlockEnvelope {
  /** Envelope format version ({@link PASSKEY_ENVELOPE_VERSION}). */
  version: number
  /** Base64 id of the one credential whose PRF can re-derive the wrapping key. */
  credentialId: string
  /** Base64 salt fed to the PRF evaluation; fixes the derived key per enrollment. */
  salt: string
  /**
   * Base64 16-byte user handle generated per enrollment. Stored so each
   * enrollment creates a DISTINCT credential (a fresh handle never collides
   * with a passkey the authenticator already holds for this site).
   */
  userHandle: string
  /** The vault password wrapped under the PRF-derived key. */
  envelope: PasskeyWrappedPassword
}

/**
 * Whether a value is a readable passkey-unlock envelope.
 *
 * Applies to untrusted `localStorage`, so the exact version is part of the
 * check: an entry written by a future format must read as ABSENT, which makes
 * the feature degrade to "passkey unlock unavailable, use your password"
 * instead of feeding an unknown shape to the crypto layer. Base64 fields are
 * only length-capped here; exact byte lengths are enforced at decode time.
 */
export function isPasskeyUnlockEnvelope(value: unknown): value is PasskeyUnlockEnvelope {
  if (!isRecord(value)) return false
  if (value.version !== PASSKEY_ENVELOPE_VERSION) return false
  if (!isNonEmptyString(value.credentialId, 2048)) return false
  if (!isNonEmptyString(value.salt, 128)) return false
  if (!isNonEmptyString(value.userHandle, 128)) return false
  if (!isRecord(value.envelope)) return false
  if (!isNonEmptyString(value.envelope.iv, 64)) return false
  if (!isNonEmptyString(value.envelope.cipher, 8192)) return false
  return true
}

/** A saved address label. */
export interface StoredBookmark {
  id: string
  address: string
  label: string
  /** Network key this bookmark is scoped to. Absent means all networks. */
  network?: string
  createdAt: number
}

/** Whether a value is a valid bookmark. */
export function isStoredBookmark(value: unknown): value is StoredBookmark {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id, 128) &&
    isEthAddress(value.address) &&
    isNonEmptyString(value.label, 128) &&
    (value.network === undefined || isNonEmptyString(value.network, 64)) &&
    isIntegerInRange(value.createdAt, 0, Number.MAX_SAFE_INTEGER)
  )
}

/** A recorded transaction. */
export interface StoredTransaction {
  hash: string
  network: string
  from: string
  to: string
  amount: string
  currency: string
  timestamp: number
  status: "pending" | "success" | "failed" | "unknown"
}

/** Terminal and non-terminal states a recorded transaction can hold. */
const TX_STATUSES = ["pending", "success", "failed", "unknown"] as const

/** Whether a value is a valid stored transaction. */
export function isStoredTransaction(value: unknown): value is StoredTransaction {
  if (!isRecord(value)) return false
  return (
    isTxHash(value.hash) &&
    isNonEmptyString(value.network, 64) &&
    isEthAddress(value.from) &&
    isEthAddress(value.to) &&
    isNonEmptyString(value.amount, 80) &&
    isNonEmptyString(value.currency, 16) &&
    isIntegerInRange(value.timestamp, 0, Number.MAX_SAFE_INTEGER) &&
    typeof value.status === "string" &&
    (TX_STATUSES as readonly string[]).includes(value.status)
  )
}

/** A user-added network. */
export interface StoredCustomNetwork {
  name: string
  rpcUrls: string[]
  explorerUrl: string
  currency: string
  type: "mainnet" | "testnet"
  isCustom: true
  /** Native currency decimals. Defaults to 18 when absent. */
  decimals?: number
}

/**
 * Whether a value is a valid custom network.
 *
 * Every RPC and explorer URL must be `https:`. This is the check that stops an
 * imported backup from pointing the app at an attacker's RPC or smuggling a
 * `javascript:` URL into an explorer link.
 */
export function isStoredCustomNetwork(value: unknown): value is StoredCustomNetwork {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value.name, 64)) return false
  if (!Array.isArray(value.rpcUrls) || value.rpcUrls.length === 0) return false
  if (value.rpcUrls.length > 20) return false
  if (!value.rpcUrls.every(isHttpsUrl)) return false
  // An explorer is optional, but if present it must be a safe absolute URL.
  if (value.explorerUrl !== "" && !isHttpsUrl(value.explorerUrl)) return false
  if (!isNonEmptyString(value.currency, 16)) return false
  if (value.type !== "mainnet" && value.type !== "testnet") return false
  if (value.isCustom !== true) return false
  if (value.decimals !== undefined && !isIntegerInRange(value.decimals, 0, 36)) return false
  return true
}

/** A tracked ERC-20 token. */
export interface StoredToken {
  address: string
  symbol: string
  name: string
  decimals: number
  /** Network key the token contract lives on. */
  network: string
}

/** Whether a value is a valid tracked token. */
export function isStoredToken(value: unknown): value is StoredToken {
  if (!isRecord(value)) return false
  return (
    isEthAddress(value.address) &&
    isNonEmptyString(value.symbol, 32) &&
    isNonEmptyString(value.name, 128) &&
    isIntegerInRange(value.decimals, 0, 36) &&
    isNonEmptyString(value.network, 64)
  )
}

/**
 * Validate a custom-network map, dropping entries that fail.
 *
 * Keys that collide with a built-in network are rejected by the caller, not
 * here, since this module does not know the built-in registry.
 *
 * @param value - Candidate record of network key to config.
 */
export function filterValidCustomNetworks(
  value: unknown
): Record<string, StoredCustomNetwork> {
  if (!isRecord(value)) return {}
  const out: Record<string, StoredCustomNetwork> = {}
  for (const [key, config] of Object.entries(value)) {
    if (!/^[a-z0-9-]{1,64}$/.test(key)) continue
    if (isStoredCustomNetwork(config)) out[key] = config
  }
  return out
}

// ===== Wallet data export (bookmarks + custom networks) =====

/** Current wallet-data export format version. Bump on breaking changes. */
export const WALLET_DATA_EXPORT_VERSION = 1

/**
 * The contents of a bookmarks + custom-networks export file.
 *
 * This is the non-secret sibling of the settings backup: it carries exactly the
 * two stores a user most often wants on a new device — address labels and their
 * own RPC endpoints — and structurally cannot carry a key. Both field types
 * ({@link StoredBookmark}, {@link StoredCustomNetwork}) have no secret-bearing
 * member, and `lib/bookmarks.exportWalletData` rebuilds every record field by
 * field from those typed shapes, so an unexpected key from a hostile store
 * cannot ride along into the file. The guarantee is enforced by construction,
 * not by filtering a serialized blob for the word "privateKey".
 */
export interface WalletDataExport {
  /** Format version, exactly {@link WALLET_DATA_EXPORT_VERSION}. */
  version: 1
  /** Unix milliseconds, so a stale file can be recognised on import. */
  exportedAt: number
  bookmarks: StoredBookmark[]
  customNetworks: Record<string, StoredCustomNetwork>
}

/**
 * Whether a value is a readable wallet-data export.
 *
 * Applied to a hand-picked or downloaded file, so the exact version is part of
 * the check — a future format must be rejected, not partially read. Unlike the
 * permissive `filterValid*` guards used for `localStorage`, a single invalid
 * entry rejects the whole file: an import must be all-or-nothing, because
 * silently dropping the one entry the user actually cared about is worse than
 * refusing the file with a precise error.
 *
 * `lib/bookmarks.importWalletData` re-walks the same structure to produce that
 * precise error sentence; the two must agree on every rule.
 */
export function isWalletDataExport(value: unknown): value is WalletDataExport {
  if (!isRecord(value)) return false
  if (value.version !== WALLET_DATA_EXPORT_VERSION) return false
  if (!isIntegerInRange(value.exportedAt, 0, Number.MAX_SAFE_INTEGER)) return false
  if (!Array.isArray(value.bookmarks)) return false
  if (!value.bookmarks.every(isStoredBookmark)) return false
  if (!isRecord(value.customNetworks)) return false
  for (const [key, config] of Object.entries(value.customNetworks)) {
    if (!/^[a-z0-9-]{1,64}$/.test(key)) return false
    if (!isStoredCustomNetwork(config)) return false
  }
  return true
}
