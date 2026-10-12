/**
 * Structural regression guards for the 2026-10 re-audit fixes.
 *
 * Following the `noPlaintextStorage.test.ts` precedent: the failure modes
 * these guard against live in component wiring (a callback dropped, a live
 * state read reintroduced, a clear-after-sign removed), which lib unit
 * tests cannot see. Each assertion names the finding it protects.
 *
 * These are source-structure tests, NOT DOM/component tests: they prove the
 * wiring exists, not that a browser renders it correctly. Browser QA covers
 * the rendered behavior.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..")

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8")
}

test("RA-01: BackupManager signals erase explicitly and WalletVault resets on it", () => {
  const backup = readRepoFile("components/BackupManager.tsx")
  assert.ok(backup.includes("onErased"), "erase must use the explicit onErased callback")
  // The old inference path (an empty-contents onRestored call) must stay gone.
  assert.equal(backup.includes("activeAccountId: null,\n      bookmarks: []"), false)

  const vault = readRepoFile("components/WalletVault.tsx")
  assert.ok(vault.includes("onErased={handleErased}"))
  assert.ok(vault.includes("const handleErased = useCallback"))
})

test("RA-03: restore seals secrets through the verified reseal path before reporting success", () => {
  const backup = readRepoFile("components/BackupManager.tsx")
  assert.ok(backup.includes("resealBackupSecrets"))
  assert.ok(backup.includes("backupHasSecrets"))
  assert.ok(backup.includes("getVaultSession"))
  assert.ok(backup.includes("onSecretsRestored"))

  const vault = readRepoFile("components/WalletVault.tsx")
  assert.ok(vault.includes("getVaultSession={getVaultSession}"))
  assert.ok(vault.includes("onSecretsRestored={handleSecretsRestored}"))
})

test("RA-04: erase cleans WalletConnect storage, not just app keys", () => {
  const backup = readRepoFile("components/BackupManager.tsx")
  assert.ok(backup.includes("eraseWalletConnectData"))

  const wc = readRepoFile("lib/walletConnect.ts")
  assert.ok(wc.includes('WALLETCONNECT_DATABASE = "walletconnect"'))
  assert.ok(wc.includes("deleteDatabase"))
  assert.ok(wc.includes("disconnectSession"))
})

test("RA-02: Sweep execution reads the plan-bound network and destination only", () => {
  const sweep = readRepoFile("components/SweepCard.tsx")
  assert.ok(sweep.includes("network: selectedNetwork"), "prepare snapshots the network into the plan")
  assert.ok(sweep.includes("plan.network as Network"), "execution derives its network from the plan")
  assert.ok(sweep.includes("withProviderOnce(planNetwork"), "broadcast uses the plan network")
  assert.ok(sweep.includes("network !== plan.network"), "confirm aborts on a context mismatch")
  assert.ok(sweep.includes('disabled={phase === "preparing"}'), "inputs freeze while preparing")
})

test("RA-05: both standalone signers run the pasted-key lifecycle and clear after signing", () => {
  for (const file of ["components/MessageSignCard.tsx", "components/TypedDataSignCard.tsx"]) {
    const source = readRepoFile(file)
    assert.ok(source.includes("usePastedKeyLifecycle"), file)
    assert.ok(source.includes('setPrivateKey("")'), `${file} must clear the key after signing`)
    assert.ok(source.includes("never stored"), `${file} must label the key as temporary`)
  }
})

test("RA-06: WalletVault broadcasts locks and consumes remote session events without echoing", () => {
  const vault = readRepoFile("components/WalletVault.tsx")
  assert.ok(vault.includes("broadcastVaultSessionEvent"))
  assert.ok(vault.includes("subscribeVaultSessionEvents"))
  assert.ok(vault.includes("isRemoteSessionEvent"), "own broadcasts must be ignored (loop guard)")
  assert.ok(vault.includes("lockInternal"), "remote handlers must use the non-broadcasting lock")
})

test("RA-11: WalletVault locks after the hidden threshold via the tested helper", () => {
  const vault = readRepoFile("components/WalletVault.tsx")
  assert.ok(vault.includes("shouldLockAfterHidden"))
  assert.ok(vault.includes("visibilitychange"))
  assert.ok(vault.includes("pagehide"))
})

test("RA-07: the privacy disclosure is reachable from the footer", () => {
  const footer = readRepoFile("components/FooterCredit.tsx")
  assert.ok(footer.includes("PrivacyDisclosure"))
  const disclosure = readRepoFile("components/PrivacyDisclosure.tsx")
  for (const topic of ["RPC", "CoinGecko", "WalletConnect", "Vercel Analytics", "IP address"]) {
    assert.ok(disclosure.includes(topic), `disclosure must cover ${topic}`)
  }
})

test("RA-12: the Farcaster close fallback is gated, targeted, and wildcard-free", () => {
  const layout = readRepoFile("app/client-layout.tsx")
  // Still gated on the detected mini-app context…
  assert.ok(layout.includes("if (!isMiniApp) return"))
  // …still sends the close signal, now via the targeted helper…
  assert.ok(layout.includes("postMiniAppClose(window)"))
  assert.ok(layout.includes('from "@/lib/frameEmbed"'))
  // …and no direct postMessage call remains in the layout at all; the
  // helper's targets are pinned (no "*") by the frameEmbed unit tests.
  assert.equal(layout.includes("window.postMessage"), false)
  assert.equal(/postMessage\([^)]*"\*"/.test(layout), false)
})

test("Info: SendForm stays deleted and nothing imports it", () => {
  const sweep = readRepoFile("components/SweepCard.tsx")
  const approvals = readRepoFile("lib/approvals.ts")
  assert.equal(sweep.includes("SendForm"), false)
  assert.equal(approvals.includes("SendForm"), false)
})
