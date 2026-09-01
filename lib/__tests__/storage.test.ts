import { test } from "node:test"
import assert from "node:assert/strict"
import {
  clearAllAppData,
  createMemoryBackend,
  readJson,
  readRaw,
  removeKey,
  setStorageBackend,
  STORAGE_KEYS,
  writeJson,
  writeJsonAtomic,
  type StorageBackend,
} from "../storage"

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number")
}

function withBackend(backend: StorageBackend, run: () => void): void {
  setStorageBackend(backend)
  try {
    run()
  } finally {
    setStorageBackend(null)
  }
}

/** Backend that rejects writes to a chosen key, simulating a full quota. */
function quotaBackend(failOnKey: string): StorageBackend {
  const inner = createMemoryBackend()
  return {
    getItem: (k) => inner.getItem(k),
    removeItem: (k) => inner.removeItem(k),
    setItem: (k, v) => {
      if (k === failOnKey) {
        const error = new Error("exceeded the quota")
        error.name = "QuotaExceededError"
        throw error
      }
      inner.setItem(k, v)
    },
  }
}

test("round-trips a validated value", () => {
  withBackend(createMemoryBackend(), () => {
    const result = writeJson(STORAGE_KEYS.BOOKMARKS, [1, 2, 3])
    assert.equal(result.ok, true)
    assert.deepEqual(readJson(STORAGE_KEYS.BOOKMARKS, isNumberArray, []), [1, 2, 3])
  })
})

test("returns the fallback for a missing key", () => {
  withBackend(createMemoryBackend(), () => {
    assert.deepEqual(readJson(STORAGE_KEYS.BOOKMARKS, isNumberArray, []), [])
  })
})

test("returns the fallback for unparseable JSON instead of throwing", () => {
  const backend = createMemoryBackend()
  backend.setItem(STORAGE_KEYS.BOOKMARKS, "{not json")
  withBackend(backend, () => {
    assert.deepEqual(readJson(STORAGE_KEYS.BOOKMARKS, isNumberArray, [7]), [7])
  })
})

test("returns the fallback when the payload fails validation", () => {
  const backend = createMemoryBackend()
  backend.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(["a", "b"]))
  withBackend(backend, () => {
    assert.deepEqual(readJson(STORAGE_KEYS.BOOKMARKS, isNumberArray, []), [])
  })
})

test("reports a quota failure instead of throwing", () => {
  withBackend(quotaBackend(STORAGE_KEYS.TRANSACTION_HISTORY), () => {
    const result = writeJson(STORAGE_KEYS.TRANSACTION_HISTORY, [1])
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, "quota-exceeded")
    assert.match(result.error, /storage is full/i)
  })
})

test("reports a serialization failure on a circular structure", () => {
  withBackend(createMemoryBackend(), () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const result = writeJson(STORAGE_KEYS.SETTINGS, circular)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, "serialize-failed")
  })
})

test("atomic write commits every key on success", () => {
  withBackend(createMemoryBackend(), () => {
    const result = writeJsonAtomic([
      { key: STORAGE_KEYS.BOOKMARKS, value: [1] },
      { key: STORAGE_KEYS.TRANSACTION_HISTORY, value: [2] },
    ])
    assert.equal(result.ok, true)
    assert.deepEqual(readJson(STORAGE_KEYS.BOOKMARKS, isNumberArray, []), [1])
    assert.deepEqual(readJson(STORAGE_KEYS.TRANSACTION_HISTORY, isNumberArray, []), [2])
  })
})

test("atomic write rolls back an earlier key when a later one fails", () => {
  // This is the restore-a-backup case: a half-applied import is worse than none.
  const backend = quotaBackend(STORAGE_KEYS.TRANSACTION_HISTORY)
  backend.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify([99]))

  withBackend(backend, () => {
    const result = writeJsonAtomic([
      { key: STORAGE_KEYS.BOOKMARKS, value: [1] },
      { key: STORAGE_KEYS.TRANSACTION_HISTORY, value: [2] },
    ])
    assert.equal(result.ok, false)
    assert.deepEqual(
      readJson(STORAGE_KEYS.BOOKMARKS, isNumberArray, []),
      [99],
      "bookmarks must be restored to their prior value"
    )
  })
})

test("atomic rollback removes a key that did not previously exist", () => {
  const backend = quotaBackend(STORAGE_KEYS.TRANSACTION_HISTORY)
  withBackend(backend, () => {
    const result = writeJsonAtomic([
      { key: STORAGE_KEYS.BOOKMARKS, value: [1] },
      { key: STORAGE_KEYS.TRANSACTION_HISTORY, value: [2] },
    ])
    assert.equal(result.ok, false)
    assert.equal(readRaw(STORAGE_KEYS.BOOKMARKS), null, "must not leave a partial write")
  })
})

test("removeKey deletes a value", () => {
  withBackend(createMemoryBackend(), () => {
    writeJson(STORAGE_KEYS.BOOKMARKS, [1])
    removeKey(STORAGE_KEYS.BOOKMARKS)
    assert.equal(readRaw(STORAGE_KEYS.BOOKMARKS), null)
  })
})

test("clearAllAppData removes every registered key including the vault", () => {
  withBackend(createMemoryBackend(), () => {
    for (const key of Object.values(STORAGE_KEYS)) {
      writeJson(key, ["x"])
    }
    clearAllAppData()
    for (const key of Object.values(STORAGE_KEYS)) {
      assert.equal(readRaw(key), null, `${key} should be cleared`)
    }
  })
})

test("key registry includes the token list that the old backup format omitted", () => {
  assert.equal(STORAGE_KEYS.TOKENS, "ethtools_tokens")
  assert.ok(Object.values(STORAGE_KEYS).includes("ethtools_tokens"))
})

test("key registry includes the vault auto-lock preference", () => {
  // Registered so "erase everything" clears it and no reader can bypass
  // validation by hitting the key directly.
  assert.equal(STORAGE_KEYS.AUTOLOCK_MINUTES, "vault.autolockMinutes")
  assert.ok(Object.values(STORAGE_KEYS).includes("vault.autolockMinutes"))
})
