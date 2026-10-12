/**
 * RA-06 / RA-11 pure-logic tests: cross-tab session event parsing and the
 * hidden-tab lock threshold.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  HIDDEN_LOCK_THRESHOLD_MS,
  createVaultSessionEvent,
  isRemoteSessionEvent,
  parseVaultSessionEvent,
  shouldLockAfterHidden,
} from "../vaultSession"

test("session events round-trip through the parser", () => {
  const event = createVaultSessionEvent("lock", "tab-1", 1234)
  assert.deepEqual(parseVaultSessionEvent(event), event)
  assert.deepEqual(parseVaultSessionEvent(createVaultSessionEvent("erase", "tab-2", 5)), {
    type: "erase",
    sourceId: "tab-2",
    sentAt: 5,
  })
})

test("the parser rejects malformed or hostile payloads", () => {
  const bad: unknown[] = [
    null,
    undefined,
    "lock",
    42,
    {},
    { type: "unlock", sourceId: "x", sentAt: 1 },
    { type: "lock" },
    { type: "lock", sourceId: "", sentAt: 1 },
    { type: "lock", sourceId: "x", sentAt: "now" },
    { type: "lock", sourceId: "x", sentAt: Number.NaN },
    { type: "erase", sourceId: 7, sentAt: 1 },
  ]
  for (const value of bad) {
    assert.equal(parseVaultSessionEvent(value), null, JSON.stringify(value))
  }
})

test("own events are not remote (the loop guard)", () => {
  const event = createVaultSessionEvent("erase", "tab-1", 1)
  assert.equal(isRemoteSessionEvent(event, "tab-1"), false)
  assert.equal(isRemoteSessionEvent(event, "tab-2"), true)
})

test("the hidden lock fires only past the threshold", () => {
  assert.equal(HIDDEN_LOCK_THRESHOLD_MS, 60_000)
  assert.equal(shouldLockAfterHidden(null, 100_000), false)
  assert.equal(shouldLockAfterHidden(50_000, 50_000 + 59_999), false)
  assert.equal(shouldLockAfterHidden(50_000, 50_000 + 60_000), true)
  assert.equal(shouldLockAfterHidden(50_000, 500_000), true)
  // Clock moving backwards must never read as a long absence.
  assert.equal(shouldLockAfterHidden(50_000, 40_000), false)
  // Custom thresholds are honored.
  assert.equal(shouldLockAfterHidden(0, 1_000, 500), true)
  assert.equal(shouldLockAfterHidden(0, 400, 500), false)
})
