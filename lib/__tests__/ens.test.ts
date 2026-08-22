import { test } from "node:test"
import assert from "node:assert/strict"
import {
  classifyEnsInput,
  DEFAULT_ENS_TIMEOUT_MS,
  ENS_CHAIN_ID,
  isEnsName,
  isHexAddress,
  lookupEns,
  lookupEnsAddress,
  resolveEnsName,
  type EnsProvider,
} from "../ens"

/**
 * These tests pin the exact discriminated-union shapes that
 * `components/EnsLookup.tsx` renders against. The provider is a parameter by
 * design, so no network access is involved.
 */

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

/** Provider whose two methods are supplied per test. */
function provider(overrides: Partial<EnsProvider>): EnsProvider {
  return {
    resolveName: overrides.resolveName ?? (async () => null),
    lookupAddress: overrides.lookupAddress ?? (async () => null),
  }
}

/** Provider that never settles, to exercise the timeout path. */
const hanging: EnsProvider = {
  resolveName: () => new Promise(() => {}),
  lookupAddress: () => new Promise(() => {}),
}

// ===== Classification =====

test("distinguishes addresses from names", () => {
  assert.equal(isHexAddress(VITALIK), true)
  assert.equal(isHexAddress(VITALIK.toLowerCase()), true)
  assert.equal(isHexAddress("0x123"), false)
  assert.equal(isHexAddress("vitalik.eth"), false)

  assert.equal(isEnsName("vitalik.eth"), true)
  assert.equal(isEnsName("sub.domain.eth"), true)
  assert.equal(isEnsName("nodot"), false)
  assert.equal(isEnsName(".eth"), false)
  assert.equal(isEnsName("trailing."), false)
  assert.equal(isEnsName("has space.eth"), false)
  assert.equal(isEnsName(""), false)
})

test("classifies input into address, name, or invalid", () => {
  const address = classifyEnsInput(VITALIK)
  assert.equal(address.kind, "address")
  if (address.kind === "address") assert.equal(address.address, VITALIK)

  const name = classifyEnsInput("vitalik.eth")
  assert.equal(name.kind, "name")

  const invalid = classifyEnsInput("!!!")
  assert.equal(invalid.kind, "invalid")
  if (invalid.kind === "invalid") assert.ok(invalid.error.length > 0)
})

test("ENS is pinned to mainnet", () => {
  assert.equal(ENS_CHAIN_ID, 1)
  assert.equal(DEFAULT_ENS_TIMEOUT_MS, 10_000)
})

// ===== Forward resolution =====

test("resolves a name to an address", async () => {
  const result = await resolveEnsName(
    provider({ resolveName: async () => VITALIK }),
    "vitalik.eth"
  )
  assert.equal(result.status, "resolved")
  if (result.status !== "resolved") return
  assert.equal(result.address, VITALIK)
  assert.equal(result.name, "vitalik.eth")
})

test("reports a name with no address record as not-found", async () => {
  const result = await resolveEnsName(provider({ resolveName: async () => null }), "nobody.eth")
  assert.equal(result.status, "not-found")
})

test("rejects an unusable name without touching the network", async () => {
  let called = false
  const result = await resolveEnsName(
    provider({
      resolveName: async () => {
        called = true
        return VITALIK
      },
    }),
    "not a name"
  )
  assert.equal(result.status, "invalid")
  assert.equal(called, false, "invalid input must not reach the provider")
})

test("surfaces a provider rejection as an error, never as a throw", async () => {
  const result = await resolveEnsName(
    provider({
      resolveName: async () => {
        throw new Error("upstream node exploded")
      },
    }),
    "vitalik.eth"
  )
  assert.equal(result.status, "error")
  if (result.status === "error") assert.match(result.error, /upstream node exploded/)
})

test("times out a hanging provider", async () => {
  const result = await resolveEnsName(hanging, "vitalik.eth", { timeoutMs: 20 })
  assert.equal(result.status, "timeout")
  if (result.status === "timeout") assert.equal(result.timeoutMs, 20)
})

test("rejects a nonsensical timeout", async () => {
  await assert.rejects(
    () => resolveEnsName(provider({}), "vitalik.eth", { timeoutMs: 0 }),
    RangeError
  )
  await assert.rejects(
    () => resolveEnsName(provider({}), "vitalik.eth", { timeoutMs: Number.NaN }),
    RangeError
  )
})

// ===== Reverse resolution =====

test("forward-confirms a matching reverse record", async () => {
  const result = await lookupEnsAddress(
    provider({
      lookupAddress: async () => "vitalik.eth",
      resolveName: async () => VITALIK,
    }),
    VITALIK
  )

  assert.equal(result.status, "resolved")
  if (result.status !== "resolved") return
  assert.equal(result.name, "vitalik.eth")
  assert.equal(result.forwardVerified, true)
  assert.equal(result.forwardAddress, VITALIK)
  assert.equal(result.verificationError, null)
})

test("flags a reverse record that does not forward-confirm", async () => {
  // Anyone can point a reverse record at any name; only the forward check
  // makes it trustworthy. The UI must not present this as identity.
  const result = await lookupEnsAddress(
    provider({
      lookupAddress: async () => "impostor.eth",
      resolveName: async () => OTHER,
    }),
    VITALIK
  )

  assert.equal(result.status, "resolved")
  if (result.status !== "resolved") return
  assert.equal(result.forwardVerified, false, "mismatch must never read as verified")
  assert.equal(result.forwardAddress, OTHER)
})

test("forwardVerified is false, not absent, when confirmation is skipped", async () => {
  const result = await lookupEnsAddress(
    provider({ lookupAddress: async () => "vitalik.eth" }),
    VITALIK,
    { confirmReverseRecord: false }
  )

  assert.equal(result.status, "resolved")
  if (result.status !== "resolved") return
  assert.equal(result.forwardVerified, false)
  assert.equal(result.forwardAddress, null)
})

test("forwardVerified is false when the confirmation call itself fails", async () => {
  const result = await lookupEnsAddress(
    provider({
      lookupAddress: async () => "vitalik.eth",
      resolveName: async () => {
        throw new Error("resolver unreachable")
      },
    }),
    VITALIK
  )

  assert.equal(result.status, "resolved")
  if (result.status !== "resolved") return
  assert.equal(result.forwardVerified, false)
  assert.notEqual(result.verificationError, null, "the reason must be explained")
})

test("reports an address with no reverse record", async () => {
  const result = await lookupEnsAddress(provider({ lookupAddress: async () => null }), VITALIK)
  assert.equal(result.status, "not-found")
})

test("rejects an invalid address without touching the network", async () => {
  let called = false
  const result = await lookupEnsAddress(
    provider({
      lookupAddress: async () => {
        called = true
        return "x.eth"
      },
    }),
    "0xnope"
  )
  assert.equal(result.status, "invalid")
  assert.equal(called, false)
})

test("times out a hanging reverse lookup", async () => {
  const result = await lookupEnsAddress(hanging, VITALIK, { timeoutMs: 20 })
  assert.equal(result.status, "timeout")
})

// ===== Direction dispatch =====

test("dispatches a name forward and an address in reverse", async () => {
  const p = provider({
    resolveName: async () => VITALIK,
    lookupAddress: async () => "vitalik.eth",
  })

  const forward = await lookupEns(p, "vitalik.eth")
  assert.equal(forward.direction, "forward")

  const reverse = await lookupEns(p, VITALIK)
  assert.equal(reverse.direction, "reverse")

  const invalid = await lookupEns(p, "???")
  assert.equal(invalid.direction, "invalid")
})

test("a late provider rejection after a timeout does not escape", async () => {
  // A rejection landing after the timeout won the race would otherwise surface
  // as an unhandled rejection and could crash the page.
  const captured: { reject?: (error: Error) => void } = {}
  const slow: EnsProvider = {
    resolveName: () =>
      new Promise((_resolve, reject) => {
        captured.reject = reject
      }),
    lookupAddress: async () => null,
  }

  const result = await resolveEnsName(slow, "vitalik.eth", { timeoutMs: 10 })
  assert.equal(result.status, "timeout")

  captured.reject?.(new Error("arrived too late"))
  // Yield so an unhandled rejection would have surfaced by now.
  await new Promise((resolve) => setTimeout(resolve, 30))
})
