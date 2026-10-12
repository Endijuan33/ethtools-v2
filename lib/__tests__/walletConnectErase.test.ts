/**
 * RA-04: the WalletConnect localStorage fallback matcher must claim exactly
 * the SDK's own keys — the same predicate the SDK's migration code uses —
 * and nothing belonging to the app or other libraries.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { isWalletConnectStorageKey } from "../walletConnect"
import { STORAGE_KEYS } from "../storage"

test("SDK fallback keys are recognized", () => {
  const wcKeys = [
    "wc@2:core:0.3//client//0//session",
    "wc@2:core:0.3//keychain",
    "wc_storage_version",
    "@walletconnect/heartbeat",
    "walletconnect",
    "WALLET_CONNECT_V2_INDEXED_DB",
    "wc_heartbeat",
  ]
  for (const key of wcKeys) {
    assert.equal(isWalletConnectStorageKey(key), true, key)
  }
})

test("app keys and unrelated keys are never claimed", () => {
  for (const key of Object.values(STORAGE_KEYS)) {
    assert.equal(isWalletConnectStorageKey(key), false, `app key ${key} must survive an erase`)
  }
  for (const key of ["ethtools_session_sync", "theme", "sonner", "next-theme"]) {
    assert.equal(isWalletConnectStorageKey(key), false, key)
  }
})
