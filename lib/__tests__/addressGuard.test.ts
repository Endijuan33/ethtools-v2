import { test } from "node:test"
import assert from "node:assert/strict"
import { collectKnownAddresses, describeSharedPattern, screenAddress } from "../addressGuard"
import { saveBookmark } from "../bookmarks"
import { saveTransaction } from "../transactionHistory"
import { createMemoryBackend, setStorageBackend } from "../storage"

/**
 * Build a 40-character hex body from a head and a tail, filling the middle
 * with a repeated digit. Programmatic on purpose: the shared-prefix and
 * shared-suffix boundaries of the poisoning fixtures must not drift because a
 * hand-typed string was one character short.
 */
function body(head: string, tail: string, fill = "1"): string {
  return head + fill.repeat(40 - head.length - tail.length) + tail
}

/** A known counterparty: first six "aaaaaa", last six "bbbbbb". */
const KNOWN = `0x${body("aaaaaa", "bbbbbb")}`

/** Run the callback against a fresh, empty storage backend. */
function withEmptyStore(run: () => void): void {
  setStorageBackend(createMemoryBackend())
  try {
    run()
  } finally {
    setStorageBackend(null)
  }
}

// ===== Exact matches =====

test("an exact match is safe", () => {
  assert.deepEqual(screenAddress(KNOWN, [KNOWN]), { suspect: false })
})

test("an exact match is safe regardless of case and 0x prefix", () => {
  // Uppercase body, no prefix, versus a lowercase known address with one.
  const upper = body("aaaaaa", "bbbbbb").toUpperCase()
  assert.deepEqual(screenAddress(`0x${upper}`, [KNOWN]), { suspect: false })
  assert.deepEqual(screenAddress(body("aaaaaa", "bbbbbb"), [KNOWN]), { suspect: false })
})

test("an exact match with one known address outranks resembling another", () => {
  // Shares its first six characters with KNOWN, but IS a different known
  // address in the list — typing a saved address must not be interrupted.
  const other = `0x${body("aaaaaa", "eeeeee", "3")}`
  assert.deepEqual(screenAddress(other, [KNOWN, other]), { suspect: false })
})

// ===== Similarity screening =====

test("sharing the first six characters is suspect", () => {
  const candidate = `0x${body("aaaaaa", "cccccc", "2")}`
  const screen = screenAddress(candidate, [KNOWN])
  assert.equal(screen.suspect, true)
  if (screen.suspect) {
    assert.equal(screen.shared, "leading")
    assert.equal(screen.matchedAddress, KNOWN)
  }
})

test("sharing the last six characters is suspect", () => {
  const candidate = `0x${body("cccccc", "bbbbbb", "2")}`
  const screen = screenAddress(candidate, [KNOWN])
  assert.equal(screen.suspect, true)
  if (screen.suspect) {
    assert.equal(screen.shared, "trailing")
    assert.equal(screen.matchedAddress, KNOWN)
  }
})

test("sharing both ends is the classic poisoning pattern", () => {
  const candidate = `0x${body("aaaaaa", "bbbbbb", "2")}`
  const screen = screenAddress(candidate, [KNOWN])
  assert.equal(screen.suspect, true)
  if (screen.suspect) {
    assert.equal(screen.shared, "both")
    assert.equal(screen.matchedAddress, KNOWN)
    assert.match(screen.detail, /first 6 and last 6 characters/)
  }
})

test("similarity is case-insensitive", () => {
  // The candidate is typed in uppercase; the known address is lowercase.
  const candidate = `0x${body("aaaaaa", "cccccc", "2").toUpperCase()}`
  const screen = screenAddress(candidate, [KNOWN])
  assert.equal(screen.suspect, true)
  if (screen.suspect) {
    assert.equal(screen.shared, "leading")
    // The matched address is reported normalized, not as typed.
    assert.equal(screen.matchedAddress, KNOWN)
  }
})

test("the 0x prefix is optional on both sides", () => {
  assert.deepEqual(screenAddress(body("aaaaaa", "bbbbbb"), [KNOWN]), { suspect: false })
  const screen = screenAddress(`0x${body("aaaaaa", "cccccc", "2")}`, [body("aaaaaa", "bbbbbb")])
  assert.equal(screen.suspect, true)
})

test("a five-character overlap stays below the threshold", () => {
  // Shares exactly five leading ("aaaaa") and five trailing ("bbbbb")
  // characters — close, but under the six that real lookalikes are built to.
  const candidate = `0x${body("aaaaac", "cbbbbb", "2")}`
  assert.deepEqual(screenAddress(candidate, [KNOWN]), { suspect: false })
})

test("an unrelated address is safe", () => {
  const candidate = `0x${body("cccccc", "dddddd", "3")}`
  assert.deepEqual(screenAddress(candidate, [KNOWN]), { suspect: false })
})

test("an empty known list cannot flag a valid address", () => {
  const candidate = `0x${body("aaaaaa", "cccccc", "2")}`
  assert.deepEqual(screenAddress(candidate, []), { suspect: false })
})

// ===== Homoglyph and zero-width detection =====

test("a non-ASCII lookalike character inside an address is suspect", () => {
  // Cyrillic "а" (U+0430) renders exactly like the hex letter it replaces.
  const homoglyph = `0x${"а"}${body("aaaaaa", "bbbbbb").slice(1)}`
  const screen = screenAddress(homoglyph, [KNOWN])
  assert.equal(screen.suspect, true)
  if (screen.suspect) {
    assert.equal(screen.shared, "non-hex")
    assert.equal(screen.matchedAddress, "")
    assert.match(screen.detail, /non-ASCII lookalike/)
  }
})

test("an ASCII lookalike substitution inside an address is suspect", () => {
  // Lowercase L where a "1" belongs: valid ASCII, but not hex.
  const original = body("aaaaaa", "bbbbbb")
  const typo = `0x${original.slice(0, 20)}l${original.slice(21)}`
  const screen = screenAddress(typo, [KNOWN])
  assert.equal(screen.suspect, true)
  if (screen.suspect) {
    assert.equal(screen.shared, "non-hex")
    assert.match(screen.detail, /not valid hex/)
  }
})

test("a zero-width character hidden inside an address is suspect", () => {
  const original = body("aaaaaa", "bbbbbb")
  const poisoned = `0x${original.slice(0, 20)}\u200B${original.slice(20)}`
  const screen = screenAddress(poisoned, [KNOWN])
  assert.equal(screen.suspect, true)
  if (screen.suspect) {
    assert.equal(screen.shared, "non-hex")
    assert.match(screen.detail, /invisible characters/)
  }
})

test("a homoglyph is flagged even with no known addresses", () => {
  // The character trick is suspicious on its own: it does not need a
  // counterparty to compare against, only something to imitate.
  const homoglyph = `0x${"а"}${body("aaaaaa", "bbbbbb").slice(1)}`
  assert.equal(screenAddress(homoglyph, []).suspect, true)
})

// ===== Invalid input is not an attack =====

test("short or empty garbage is plain invalid input, not poisoning", () => {
  for (const bad of ["", "   ", "0x", "0x123", "not-an-address", "hello world"]) {
    assert.deepEqual(screenAddress(bad, [KNOWN]), { suspect: false }, JSON.stringify(bad))
  }
})

test("a 40-character string that is not hex-dense is not address-shaped", () => {
  // 30 hex characters out of 40 is not a disguised address; the send form's
  // own validation reports it.
  const loose = `z`.repeat(10) + `1`.repeat(30)
  assert.deepEqual(screenAddress(loose, [KNOWN]), { suspect: false })
})

test("a transaction hash is not address-shaped", () => {
  const hash = `0x${"ab".repeat(32)}`
  assert.deepEqual(screenAddress(hash, [KNOWN]), { suspect: false })
})

// ===== UI sentence =====

test("describeSharedPattern names the matched end and address", () => {
  const both = screenAddress(`0x${body("aaaaaa", "bbbbbb", "2")}`, [KNOWN])
  if (both.suspect) {
    assert.match(describeSharedPattern(both), /first and last 6 characters/)
    assert.match(describeSharedPattern(both), /0xaaaaaa…bbbbbb/)
    assert.match(describeSharedPattern(both), /Verify it carefully\./)
  } else {
    assert.fail("expected a suspect screen")
  }

  const trailing = screenAddress(`0x${body("cccccc", "bbbbbb", "2")}`, [KNOWN])
  if (trailing.suspect) {
    assert.match(describeSharedPattern(trailing), /last 6 characters/)
  }
})

test("describeSharedPattern explains the non-hex case without a matched address", () => {
  const original = body("aaaaaa", "bbbbbb")
  const poisoned = `0x${original.slice(0, 20)}\u200B${original.slice(20)}`
  const screen = screenAddress(poisoned, [])
  if (screen.suspect) {
    assert.match(describeSharedPattern(screen), /characters that do not belong/)
  } else {
    assert.fail("expected a suspect screen")
  }
})

test("describeSharedPattern is empty for a safe screen", () => {
  assert.equal(describeSharedPattern({ suspect: false }), "")
})

// ===== Known-address collection =====

test("collects bookmarks and history recipients, deduped and normalized", () => {
  withEmptyStore(() => {
    const one = `0x${body("aaaaaa", "bbbbbb")}`
    const two = `0x${body("cccccc", "dddddd", "2")}`
    const three = `0x${body("eeeeee", "ffffff", "3")}`
    const sender = `0x${body("123456", "7890ab", "4")}`

    assert.equal(saveBookmark(one, "Counterparty").ok, true)
    assert.equal(saveBookmark(two, "Other").ok, true)

    // "two" arrives again from history in a different casing (as a
    // checksummed-looking address from another wallet would) and must dedupe.
    assert.equal(
      saveTransaction({
        hash: `0x${"ab".repeat(32)}`,
        network: "ethereum",
        from: sender,
        to: `0x${two.slice(2).toUpperCase()}`,
        amount: "1",
        currency: "ETH",
        status: "success",
      }).ok,
      true
    )
    assert.equal(
      saveTransaction({
        hash: `0x${"cd".repeat(32)}`,
        network: "ethereum",
        from: sender,
        to: three,
        amount: "1",
        currency: "ETH",
        status: "success",
      }).ok,
      true
    )

    assert.deepEqual(collectKnownAddresses(), [one, two, three])
  })
})

test("collects nothing when nothing is stored", () => {
  withEmptyStore(() => {
    assert.deepEqual(collectKnownAddresses(), [])
  })
})

test("a collected recipient drives a poisoning warning end to end", () => {
  withEmptyStore(() => {
    const real = `0x${body("aaaaaa", "bbbbbb")}`
    assert.equal(saveBookmark(real, "Counterparty").ok, true)

    const lookalike = `0x${body("aaaaaa", "bbbbbb", "2")}`
    const screen = screenAddress(lookalike, collectKnownAddresses())
    assert.equal(screen.suspect, true)
    if (screen.suspect) {
      assert.equal(screen.shared, "both")
      assert.equal(screen.matchedAddress, real)
    }
  })
})
