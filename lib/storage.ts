/**
 * Safe localStorage access.
 *
 * Every persisted key in the app is registered here, and every read validates
 * its payload before returning it. Direct `localStorage` calls elsewhere are a
 * bug: they throw on quota exhaustion (Safari private browsing allows almost no
 * quota) and they hand unvalidated JSON straight to the UI.
 */

import { APP_EVENTS, emitAppEvent } from "./appEvents"

/** Every storage key the application owns. */
export const STORAGE_KEYS = {
  /** Encrypted wallet vault. Never cleartext secrets. */
  VAULT: "ethtools_vault",
  /** Legacy cleartext wallet array, read only for one-time migration. */
  LEGACY_WALLETS: "ethtools_wallets",
  ACTIVE_WALLET: "ethtools_active_wallet",
  CUSTOM_NETWORKS: "ethtools_custom_networks",
  TRANSACTION_HISTORY: "ethtools_transaction_history",
  BOOKMARKS: "ethtools_bookmarks",
  TOKENS: "ethtools_tokens",
  SETTINGS: "ethtools_settings",
} as const

/** Union of registered storage keys. */
export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]

/**
 * Minimal storage contract. `localStorage` satisfies this structurally, and
 * tests inject an in-memory implementation.
 */
export interface StorageBackend {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Result of a write, which can fail for reasons the user must see. */
export type WriteResult =
  | { ok: true }
  | { ok: false; error: string; reason: "quota-exceeded" | "unavailable" | "serialize-failed" }

/** In-memory fallback so server rendering and tests never touch a real store. */
export function createMemoryBackend(): StorageBackend {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

let overrideBackend: StorageBackend | null = null

/**
 * Replace the backing store. Intended for tests only.
 * @param backend - Store to use, or null to restore the default.
 */
export function setStorageBackend(backend: StorageBackend | null): void {
  overrideBackend = backend
}

const memoryFallback = createMemoryBackend()

/**
 * Resolve the active backend.
 *
 * Falls back to memory when `localStorage` is missing or blocked. Some browsers
 * throw merely on *accessing* `window.localStorage` when storage is disabled,
 * so the probe is wrapped.
 */
function getBackend(): StorageBackend {
  if (overrideBackend) return overrideBackend
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage
    }
  } catch {
    // Storage access denied by browser policy.
  }
  return memoryFallback
}

/** Whether writes will actually persist across reloads. */
export function isPersistenceAvailable(): boolean {
  return getBackend() !== memoryFallback
}

/**
 * True when the thrown error indicates the storage quota is full.
 * Browsers disagree on the name and legacy code, so check several.
 */
function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return (
      error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error.code === 22
    )
  }
  return error instanceof Error && /quota/i.test(error.message)
}

/**
 * Read and validate a JSON value.
 *
 * Any failure (missing, unparseable, or failing `validate`) yields `fallback`,
 * so a corrupted entry degrades to an empty state instead of crashing a render.
 *
 * @param key - Registered storage key.
 * @param validate - Type guard the parsed value must satisfy.
 * @param fallback - Value returned on any failure.
 */
export function readJson<T>(
  key: StorageKey,
  validate: (value: unknown) => value is T,
  fallback: T
): T {
  let raw: string | null
  try {
    raw = getBackend().getItem(key)
  } catch {
    return fallback
  }
  if (raw === null) return fallback

  try {
    const parsed: unknown = JSON.parse(raw)
    return validate(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/**
 * Read a raw string without JSON parsing.
 * @param key - Registered storage key.
 */
export function readRaw(key: StorageKey): string | null {
  try {
    return getBackend().getItem(key)
  } catch {
    return null
  }
}

/**
 * Serialize and persist a value.
 *
 * Returns a result rather than throwing so callers can surface a real message.
 * This matters most immediately after broadcasting a transaction, where an
 * uncaught throw would report failure for a transaction that actually
 * succeeded.
 *
 * @param key - Registered storage key.
 * @param value - JSON-serializable value.
 */
export function writeJson(key: StorageKey, value: unknown): WriteResult {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return {
      ok: false,
      reason: "serialize-failed",
      error: "Could not save: the data could not be serialized.",
    }
  }

  try {
    getBackend().setItem(key, serialized)
    return { ok: true }
  } catch (error) {
    if (isQuotaError(error)) {
      return {
        ok: false,
        reason: "quota-exceeded",
        error:
          "Browser storage is full. Remove old transaction history or bookmarks and try again.",
      }
    }
    return {
      ok: false,
      reason: "unavailable",
      error: "Could not save: browser storage is unavailable or blocked.",
    }
  }
}

/**
 * Persist a raw string.
 * @param key - Registered storage key.
 * @param value - Exact string to store.
 */
export function writeRaw(key: StorageKey, value: string): WriteResult {
  try {
    getBackend().setItem(key, value)
    return { ok: true }
  } catch (error) {
    if (isQuotaError(error)) {
      return {
        ok: false,
        reason: "quota-exceeded",
        error: "Browser storage is full.",
      }
    }
    return {
      ok: false,
      reason: "unavailable",
      error: "Could not save: browser storage is unavailable or blocked.",
    }
  }
}

/**
 * Delete a key. Silent if it does not exist.
 * @param key - Registered storage key.
 */
export function removeKey(key: StorageKey): void {
  try {
    getBackend().removeItem(key)
  } catch {
    // Nothing useful to do; the value is already unreachable.
  }
}

/**
 * Apply several writes so that either all land or none do.
 *
 * Snapshots the previous values first and rolls back on the first failure. This
 * is what makes a backup restore safe: a partial restore that leaves wallets
 * replaced but history missing is worse than a clean rejection.
 *
 * @param entries - Key/value pairs to write together.
 */
export function writeJsonAtomic(
  entries: ReadonlyArray<{ key: StorageKey; value: unknown }>
): WriteResult {
  const snapshot = new Map<StorageKey, string | null>()
  for (const { key } of entries) {
    if (!snapshot.has(key)) snapshot.set(key, readRaw(key))
  }

  const written: StorageKey[] = []

  for (const { key, value } of entries) {
    const result = writeJson(key, value)
    if (result.ok) {
      written.push(key)
      continue
    }

    // Roll back only the keys this call actually changed.
    for (const key of written) {
      const previous = snapshot.get(key) ?? null
      if (previous === null) {
        removeKey(key)
      } else {
        writeRaw(key, previous)
      }
    }
    return result
  }

  return { ok: true }
}

/**
 * Remove every key the app owns, including the encrypted vault.
 *
 * Emits {@link APP_EVENTS.DATA_RESTORED} so components drop any state they cached
 * from storage. Without it a component would keep rendering wallets and networks
 * that no longer exist.
 */
export function clearAllAppData(): void {
  for (const key of Object.values(STORAGE_KEYS)) {
    removeKey(key)
  }
  emitAppEvent(APP_EVENTS.DATA_RESTORED)
}
