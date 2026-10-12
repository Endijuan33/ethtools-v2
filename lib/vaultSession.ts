/**
 * Vault session coordination: cross-tab lock/erase sync and hidden-tab lock.
 *
 * A vault is only as locked as its least careful tab. Before this module,
 * locking (or erasing everything) in one tab left every other open tab
 * holding the decrypted payload in memory, and an erase in one tab could be
 * silently undone when a surviving tab re-sealed its in-memory copy.
 *
 * The pure half (message construction/parsing, the hidden-lock threshold) is
 * unit-tested; the browser half is a thin BroadcastChannel adapter with a
 * `storage`-event fallback for engines without BroadcastChannel.
 */

import { STORAGE_KEYS, writeRaw } from "./storage"

// ===== Hidden-tab lock =====

/**
 * How long the tab may stay hidden before the vault locks on return.
 *
 * Short enough that a vault left open on a shared screen does not stay
 * usable, long enough that switching to a password manager or an authenticator
 * app — a normal part of using a vault — never trips it.
 */
export const HIDDEN_LOCK_THRESHOLD_MS = 60_000

/**
 * Whether a vault that was hidden at `hiddenAt` should lock at `now`.
 *
 * @param hiddenAt - `Date.now()` when the tab became hidden, or null.
 * @param now - Current `Date.now()`.
 * @param thresholdMs - Required hidden duration; defaults to
 *   {@link HIDDEN_LOCK_THRESHOLD_MS}.
 */
export function shouldLockAfterHidden(
  hiddenAt: number | null,
  now: number,
  thresholdMs: number = HIDDEN_LOCK_THRESHOLD_MS
): boolean {
  if (hiddenAt === null || !Number.isFinite(hiddenAt) || !Number.isFinite(now)) return false
  // A clock jump backwards must never read as "hidden for a very long time".
  if (now < hiddenAt) return false
  return now - hiddenAt >= thresholdMs
}

// ===== Cross-tab session events =====

/** What happened to the vault session in another tab. */
export type VaultSessionEventType = "lock" | "erase"

/** A session event as it crosses the channel. Carries no secrets, ever. */
export interface VaultSessionEvent {
  type: VaultSessionEventType
  /** Random per-tab id of the sender, so a tab can ignore its own echo. */
  sourceId: string
  /** Sender-side `Date.now()`, for diagnostics only. */
  sentAt: number
}

/** BroadcastChannel name shared by every tab of this origin. */
export const VAULT_SESSION_CHANNEL = "ethtools:vault-session"

/**
 * localStorage key for the storage-event fallback.
 *
 * The value is a single JSON session event — the same non-secret shape the
 * channel carries. It is written only when BroadcastChannel is unavailable,
 * and goes through the registered storage key like every other app write.
 */
export const VAULT_SESSION_STORAGE_KEY = STORAGE_KEYS.SESSION_SYNC

/** Build the event object for a broadcast. */
export function createVaultSessionEvent(
  type: VaultSessionEventType,
  sourceId: string,
  sentAt: number
): VaultSessionEvent {
  return { type, sourceId, sentAt }
}

/**
 * Validate an untrusted channel/fallback payload.
 *
 * Anything malformed parses to null rather than throwing: a hostile or
 * corrupted message must never be able to crash — or lock — a tab beyond the
 * two event types this parser accepts, and both of those only ever *reduce*
 * privilege.
 */
export function parseVaultSessionEvent(value: unknown): VaultSessionEvent | null {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  if (record.type !== "lock" && record.type !== "erase") return null
  if (typeof record.sourceId !== "string" || record.sourceId.length === 0) return null
  if (typeof record.sentAt !== "number" || !Number.isFinite(record.sentAt)) return null
  return { type: record.type, sourceId: record.sourceId, sentAt: record.sentAt }
}

/** Whether an event came from a different tab and should be acted on. */
export function isRemoteSessionEvent(event: VaultSessionEvent, ownSourceId: string): boolean {
  return event.sourceId !== ownSourceId
}

// ===== Browser transport =====

let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null
  if (channel === null) {
    try {
      channel = new BroadcastChannel(VAULT_SESSION_CHANNEL)
    } catch {
      return null
    }
  }
  return channel
}

/**
 * Tell every other tab that this tab locked or erased the vault.
 *
 * Uses BroadcastChannel when available; otherwise writes the event to the
 * fallback storage key, which fires a `storage` event in other tabs.
 */
export function broadcastVaultSessionEvent(event: VaultSessionEvent): void {
  const bc = getChannel()
  if (bc) {
    try {
      bc.postMessage(event)
      return
    } catch {
      // Fall through to the storage fallback.
    }
  }
  // Through the storage wrapper: it swallows quota/availability failures,
  // which is the right behavior here — cross-tab sync is a hardening layer,
  // and its absence must never break the lock itself.
  writeRaw(VAULT_SESSION_STORAGE_KEY, JSON.stringify(event))
}

/**
 * Subscribe to session events from other tabs.
 *
 * Listens on BroadcastChannel and, in parallel, on `storage` events for the
 * fallback key. Both transports feed the same handler; duplicates are
 * harmless because locking an already-locked vault is a no-op.
 *
 * Events from the sending tab itself never arrive here (BroadcastChannel
 * does not echo to the sender and storage events never fire in the writing
 * tab); consumers that also SEND events should still filter with
 * {@link isRemoteSessionEvent}, because a second component in the same tab
 * may broadcast with its own source id.
 *
 * @returns Unsubscribe function.
 */
export function subscribeVaultSessionEvents(
  handler: (event: VaultSessionEvent) => void
): () => void {
  const bc = getChannel()
  const onMessage = (message: MessageEvent<unknown>): void => {
    const parsed = parseVaultSessionEvent(message.data)
    if (parsed) handler(parsed)
  }
  bc?.addEventListener("message", onMessage)

  const onStorage = (storageEvent: StorageEvent): void => {
    if (storageEvent.key !== VAULT_SESSION_STORAGE_KEY || !storageEvent.newValue) return
    try {
      const parsed = parseVaultSessionEvent(JSON.parse(storageEvent.newValue))
      if (parsed) handler(parsed)
    } catch {
      // Corrupt fallback payload: ignore.
    }
  }
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage)

  return () => {
    bc?.removeEventListener("message", onMessage)
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}

/** A per-tab source id for session broadcasts. */
export function createSessionSourceId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}
