/**
 * Structural regression guard for the S1 remediation.
 *
 * The encrypted-vault migration in lib/vaultStore.ts is the only code that
 * may touch the legacy cleartext key at all, and the only write it may make
 * there is reducing it to the records that could not be migrated yet. Every
 * other component - above all the Balances panel - must never write that
 * key, never read a private key out of it into component state, and never
 * offer a signing flow fed by plaintext storage.
 *
 * These are source scans on purpose: the failure mode they guard against is
 * a future change quietly reintroducing a plaintext write in a UI file,
 * which unit tests of lib/ alone would never notice.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// Tests run from .test-build/__tests__/ inside the repository.
const REPO_ROOT = join(__dirname, "..", "..")

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8")
}

test("the Balances panel never writes the legacy cleartext key", () => {
  const source = readRepoFile("components/WalletCard.tsx")
  assert.equal(source.includes("writeJson(STORAGE_KEYS.LEGACY_WALLETS"), false)
  assert.equal(source.includes("writeRaw(STORAGE_KEYS.LEGACY_WALLETS"), false)
})

test("the Balances panel never reads a private key into component state", () => {
  const source = readRepoFile("components/WalletCard.tsx")
  assert.equal(source.includes(".privateKey"), false)
  assert.equal(source.includes("SendForm"), false)
})

test("no component writes the legacy cleartext key", () => {
  const componentsDir = join(REPO_ROOT, "components")
  const offenders = readdirSync(componentsDir)
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) => {
      const source = readFileSync(join(componentsDir, name), "utf8")
      return (
        source.includes("writeJson(STORAGE_KEYS.LEGACY_WALLETS") ||
        source.includes("writeRaw(STORAGE_KEYS.LEGACY_WALLETS")
      )
    })
  assert.deepEqual(offenders, [])
})

test("watch-address storage is a registered, address-only key", () => {
  const storage = readRepoFile("lib/storage.ts")
  assert.ok(storage.includes('WATCH_ADDRESSES: "ethtools_watch_addresses"'))
})
