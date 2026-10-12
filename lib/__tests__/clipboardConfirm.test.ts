/**
 * RA-10 / RA-08 pure-logic tests: the clipboard clear decision and the
 * duplicate-confirmation gate.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { SECRET_CLIPBOARD_CLEAR_MS, shouldClearClipboard } from "../clipboard"
import { confirmationKey, createConfirmationGate } from "../confirmDedupe"

test("the clipboard is cleared only while it still holds exactly the copied secret", () => {
  assert.equal(shouldClearClipboard("0xsecret", "0xsecret"), true)
  assert.equal(shouldClearClipboard("0xsecret", "something the user copied later"), false)
  assert.equal(shouldClearClipboard("0xsecret", "0xsecret "), false, "near-matches do not count")
  assert.equal(shouldClearClipboard("0xsecret", null), false, "unreadable clipboard is left alone")
  assert.equal(shouldClearClipboard("", ""), false, "an empty copy never triggers a clear")
})

test("the clear delay sits inside the required 30-60 second window", () => {
  assert.ok(SECRET_CLIPBOARD_CLEAR_MS >= 30_000)
  assert.ok(SECRET_CLIPBOARD_CLEAR_MS <= 60_000)
})

test("identical confirmations share one identity; distinct ones do not", () => {
  assert.equal(
    confirmationKey({ message: "Erase?", description: "d", confirmLabel: "Erase" }),
    confirmationKey({ message: "Erase?", description: "d", confirmLabel: "Erase" })
  )
  assert.notEqual(confirmationKey({ message: "Erase?" }), confirmationKey({ message: "Sweep?" }))
  assert.notEqual(
    confirmationKey({ message: "Erase?", description: "a" }),
    confirmationKey({ message: "Erase?", description: "b" })
  )
  // Defaults normalize: omitting the labels equals spelling the defaults.
  assert.equal(
    confirmationKey({ message: "Erase?" }),
    confirmationKey({ message: "Erase?", confirmLabel: "Confirm", cancelLabel: "Cancel" })
  )
})

test("the gate joins identical pending confirmations and releases after settlement", async () => {
  const gate = createConfirmationGate()
  let starts = 0
  const resolvers: Array<(value: boolean) => void> = []
  const start = (): Promise<boolean> => {
    starts++
    return new Promise<boolean>((resolve) => {
      resolvers.push(resolve)
    })
  }

  const first = gate.run({ message: "Erase?" }, start)
  const second = gate.run({ message: "Erase?" }, start)
  assert.equal(starts, 1, "the second identical call must not start a new prompt")
  assert.equal(first, second, "both callers await the same promise")
  assert.equal(gate.pendingCount(), 1)

  // A different confirmation is never blocked.
  let otherStarts = 0
  const other = gate.run({ message: "Sweep?" }, () => {
    otherStarts++
    return Promise.resolve(true)
  })
  assert.equal(otherStarts, 1)
  assert.equal(await other, true)

  resolvers[0](true)
  assert.equal(await first, true)
  assert.equal(gate.pendingCount(), 0, "settled entries are released")

  // After settlement the same prompt may legitimately appear again.
  const third = gate.run({ message: "Erase?" }, () => {
    starts++
    return Promise.resolve(false)
  })
  assert.equal(starts, 2)
  assert.equal(await third, false)
})
