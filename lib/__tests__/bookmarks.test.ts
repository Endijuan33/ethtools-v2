import { test } from "node:test"
import assert from "node:assert/strict"

import {
  exportWalletData,
  getBookmarks,
  importWalletData,
} from "../bookmarks"
import { getCustomNetworks } from "../ethers"
import { isWalletDataExport, isStoredCustomNetwork, type StoredCustomNetwork } from "../schema"
import {
  createMemoryBackend,
  setStorageBackend,
  STORAGE_KEYS,
  writeJson,
  type StorageBackend,
} from "../storage"

/**
 * Export/import round-trips for bookmarks and custom networks.
 *
 * The contract under test is the one the UI relies on: a file is either
 * accepted whole or rejected whole (no partial writes), re-importing is a
 * no-op, and the exported bytes are structurally incapable of carrying a
 * secret even when one sits in the same store.
 */

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const PHRASE = "test test test test test test test test test test test junk"

const NETWORK: StoredCustomNetwork = {
  name: "Example Chain",
  rpcUrls: ["https://rpc.example.com"],
  explorerUrl: "https://explorer.example.com",
  currency: "ETH",
  type: "mainnet",
  isCustom: true,
}

/** Install a fresh in-memory store and return it for direct raw reads. */
function useStore(): StorageBackend {
  const backend = createMemoryBackend()
  setStorageBackend(backend)
  return backend
}

function resetStore(): void {
  setStorageBackend(null)
}

/** A valid stored bookmark, with a distinct id per call. */
function storedBookmark(id: string, address = ADDRESS): Record<string, unknown> {
  return { id, address, label: `Label ${id}`, createdAt: 1234 }
}

/** What the bookmarks store holds, raw, so assertions see exactly what persisted. */
function rawBookmarks(backend: StorageBackend): unknown[] {
  const raw = backend.getItem(STORAGE_KEYS.BOOKMARKS)
  if (raw === null) return []
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : []
}

test("export contains bookmarks and custom networks but never secrets", () => {
  const backend = useStore()
  try {
    writeJson(STORAGE_KEYS.BOOKMARKS, [storedBookmark("b1"), storedBookmark("b2", OTHER)])
    writeJson(STORAGE_KEYS.CUSTOM_NETWORKS, { "example-chain": NETWORK })
    // A vault-shaped value in the same store must not leak into the export.
    writeJson(STORAGE_KEYS.VAULT, { mnemonic: PHRASE })

    const serialized = exportWalletData()

    assert.equal(serialized.includes("mnemonic"), false)
    assert.equal(serialized.includes("privateKey"), false)
    assert.equal(serialized.includes(PHRASE.split(" ")[0]), false)

    const parsed = JSON.parse(serialized)
    assert.equal(parsed.version, 1)
    assert.equal(typeof parsed.exportedAt, "number")
    assert.equal(parsed.bookmarks.length, 2)
    assert.equal(parsed.customNetworks["example-chain"].name, NETWORK.name)

    // The export satisfies the canonical schema guard.
    assert.equal(isWalletDataExport(parsed), true)
  } finally {
    resetStore()
  }
})

test("export from empty stores is a valid, empty file", () => {
  useStore()
  try {
    const parsed = JSON.parse(exportWalletData())
    assert.deepEqual(parsed.bookmarks, [])
    assert.deepEqual(parsed.customNetworks, {})
    assert.equal(isWalletDataExport(parsed), true)

    const result = importWalletData(JSON.stringify(parsed))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.counts, {
        bookmarksAdded: 0,
        bookmarksSkipped: 0,
        networksAdded: 0,
        networksSkipped: 0,
      })
    }
  } finally {
    resetStore()
  }
})

test("round-trip: export from one store imports into a fresh store", () => {
  useStore()
  try {
    writeJson(STORAGE_KEYS.BOOKMARKS, [storedBookmark("b1"), storedBookmark("b2", OTHER)])
    writeJson(STORAGE_KEYS.CUSTOM_NETWORKS, { "example-chain": NETWORK })
    const exported = exportWalletData()

    // A brand-new device: empty store.
    useStore()
    const result = importWalletData(exported)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.counts, {
        bookmarksAdded: 2,
        bookmarksSkipped: 0,
        networksAdded: 1,
        networksSkipped: 0,
      })
    }

    const bookmarks = getBookmarks()
    assert.deepEqual(
      bookmarks.map((b) => b.address).sort(),
      [ADDRESS, OTHER].sort()
    )
    // Ids survive the trip so labels stay addressable.
    assert.deepEqual(
      bookmarks.map((b) => b.id).sort(),
      ["b1", "b2"]
    )
    assert.equal(getCustomNetworks()["example-chain"].name, NETWORK.name)
  } finally {
    resetStore()
  }
})

test("re-importing the same file into the same store is a no-op", () => {
  const backend = useStore()
  try {
    writeJson(STORAGE_KEYS.BOOKMARKS, [storedBookmark("b1")])
    writeJson(STORAGE_KEYS.CUSTOM_NETWORKS, {})
    const exported = exportWalletData()

    const result = importWalletData(exported)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.counts, {
        bookmarksAdded: 0,
        bookmarksSkipped: 1,
        networksAdded: 0,
        networksSkipped: 0,
      })
    }
    // And the store is unchanged, not re-written with duplicates.
    assert.equal(rawBookmarks(backend).length, 1)
  } finally {
    resetStore()
  }
})

test("a duplicate address inside one file is skipped, not imported twice", () => {
  useStore()
  try {
    const file = {
      version: 1,
      exportedAt: 1,
      bookmarks: [storedBookmark("a"), { ...storedBookmark("b"), address: ADDRESS.toLowerCase() }],
      customNetworks: {},
    }
    const result = importWalletData(JSON.stringify(file))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.counts.bookmarksAdded, 1)
      assert.equal(result.counts.bookmarksSkipped, 1)
    }
    assert.equal(getBookmarks().length, 1)
  } finally {
    resetStore()
  }
})

test("a network key that shadows a built-in is skipped", () => {
  useStore()
  try {
    const file = {
      version: 1,
      exportedAt: 1,
      bookmarks: [],
      customNetworks: { mainnet: NETWORK },
    }
    const result = importWalletData(JSON.stringify(file))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.counts, {
        bookmarksAdded: 0,
        bookmarksSkipped: 0,
        networksAdded: 0,
        networksSkipped: 1,
      })
    }
    assert.equal("mainnet" in getCustomNetworks(), false)
  } finally {
    resetStore()
  }
})

test("an unsupported version is rejected precisely and nothing is written", () => {
  const backend = useStore()
  try {
    const file = {
      version: 2,
      exportedAt: 1,
      bookmarks: [storedBookmark("b1")],
      customNetworks: {},
    }
    const result = importWalletData(JSON.stringify(file))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /version/i)
    }
    assert.equal(rawBookmarks(backend).length, 0)
    assert.equal(isWalletDataExport(file), false)
  } finally {
    resetStore()
  }
})

test("a tampered bookmark rejects the whole file", () => {
  const backend = useStore()
  try {
    writeJson(STORAGE_KEYS.BOOKMARKS, [storedBookmark("existing")])
    const file = {
      version: 1,
      exportedAt: 1,
      bookmarks: [
        storedBookmark("ok"),
        { ...storedBookmark("bad"), address: "0xnot-an-address" },
      ],
      customNetworks: { "example-chain": NETWORK },
    }
    const result = importWalletData(JSON.stringify(file))
    assert.equal(result.ok, false)
    if (!result.ok) {
      // The error names the entry, not just "invalid file".
      assert.match(result.error, /Bookmark 2/)
    }
    // All-or-nothing: the valid sibling and the network were NOT written.
    assert.equal(rawBookmarks(backend).length, 1)
    assert.equal(getCustomNetworks()["example-chain"], undefined)
  } finally {
    resetStore()
  }
})

test("a tampered network rejects the whole file", () => {
  const backend = useStore()
  try {
    const hostile = { ...NETWORK, rpcUrls: ["http://cleartext.example.com"] }
    const file = {
      version: 1,
      exportedAt: 1,
      bookmarks: [storedBookmark("ok")],
      customNetworks: { "example-chain": hostile },
    }
    const result = importWalletData(JSON.stringify(file))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /example-chain/)
    }
    assert.equal(rawBookmarks(backend).length, 0)
  } finally {
    resetStore()
  }
})

test("non-JSON and empty inputs are rejected", () => {
  useStore()
  try {
    for (const text of ["", "   ", "not json at all", "{version: 1}"]) {
      const result = importWalletData(text)
      assert.equal(result.ok, false, `input ${JSON.stringify(text)} must be rejected`)
    }
  } finally {
    resetStore()
  }
})

test("the schema guard and the import walker agree on a tampered payload", () => {
  const tampered = {
    version: 1,
    exportedAt: 1,
    bookmarks: [{ ...storedBookmark("bad"), createdAt: -1 }],
    customNetworks: {},
  }
  assert.equal(isWalletDataExport(tampered), false)

  useStore()
  try {
    const result = importWalletData(JSON.stringify(tampered))
    assert.equal(result.ok, false)
  } finally {
    resetStore()
  }
})

test("the exported network entry satisfies the stored-network guard", () => {
  assert.equal(isStoredCustomNetwork(NETWORK), true)
})
