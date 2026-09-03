/**
 * Address-poisoning guard.
 *
 * The attack this module exists for: a scammer generates an address whose
 * first and/or last characters match a counterparty the victim already knows,
 * sends them a tiny "dust" transaction, and waits for the victim to copy the
 * lookalike out of their history instead of the real address. Wallet UIs
 * shorten addresses to roughly their first and last few characters, so the
 * lookalike reads as the same address and real funds go to the scammer.
 *
 * The guard compares a candidate address against the addresses the user
 * already knows — bookmarks and past recipients — and reports suspicious
 * similarity. It produces a WARNING, never a block: a legitimately new
 * address can look similar by chance, and the user may have a valid reason to
 * send to it. A second trick is caught without any known addresses at all: a
 * string that reads as an address but contains characters that cannot be in
 * one (Cyrillic lookalikes of hex letters, invisible zero-width characters),
 * which makes a copied lookalike indistinguishable from the real thing.
 *
 * `screenAddress` and `describeSharedPattern` are pure; only
 * `collectKnownAddresses` reads (never writes) local storage.
 */

import { getBookmarks } from "./bookmarks"
import { getTransactionHistoryData } from "./transactionHistory"
import { truncateHex } from "./format"

// ===== Types =====

/** Outcome of screening one address against the user's known addresses. */
export type AddressScreen =
  | { suspect: false }
  | {
      /** True when the candidate resembles something the user knows. */
      suspect: true
      /**
       * The known address the candidate resembles, lowercase with an `0x`
       * prefix. Empty for the "non-hex" variant, which is about the
       * candidate's own characters rather than any single known address.
       */
      matchedAddress: string
      /** Which end of the address matches, or that the string is not hex. */
      shared: "leading" | "trailing" | "both" | "non-hex"
      /** Short human-readable reason, for logs and tests. */
      detail: string
    }

// ===== Bounds =====

/**
 * How many leading and/or trailing hex characters two different addresses
 * must share before the guard treats one as a possible lookalike of the
 * other.
 *
 * Real poisoning payloads copy roughly the first and/or last 4–8 characters,
 * because that is all a wallet UI typically shows of an address. Six sits in
 * the middle of that range while keeping the false-positive rate negligible:
 * two random addresses share a given 6-character prefix with probability
 * 16⁻⁶ ≈ 1 in 16.8 million, so even hundreds of saved addresses rarely trip
 * the guard by accident. Dropping to 4 raises that to ~1 in 65 536 per known
 * address — about one false alarm per hundred pastes once a few addresses
 * are saved — which would train the user to ignore the warning.
 */
const SHARED_CHARS = 6

/**
 * How many characters of a 40-character, address-shaped string may fail to be
 * hex before the guard stops treating it as a disguised address.
 *
 * A homoglyph or zero-width poisoning payload is a real address with one to a
 * few characters swapped or injected, so nearly all of its visible characters
 * are still hex. Ordinary mistyped or unrelated text that happens to be 40
 * characters long is almost never that hex-dense, and reporting plain invalid
 * input as an attack would be noise: validity is the send form's job, not the
 * guard's.
 */
const MAX_LOOKALIKE_SUBSTITUTIONS = 4

/** Length of an Ethereum address body, i.e. without the `0x` prefix. */
const ADDRESS_BODY_LENGTH = 40

// ===== Internal helpers =====

/** An Ethereum address body: exactly 40 hexadecimal characters. */
const HEX_BODY = /^[0-9a-fA-F]{40}$/

/** A single hexadecimal character. Global: used with `String.match` only. */
const HEX_CHAR = /[0-9a-fA-F]/g

/** An optional leading `0x` or `0X` prefix. */
const LEADING_0X = /^0[xX]/

/**
 * Characters that render as nothing but still travel inside a copied string.
 *
 * Zero-width spaces/joiners hide between visible characters, bidi controls
 * can reorder how a string displays, and the BOM/soft hyphen smuggle
 * themselves into the middle of pasted text. `trim()` removes none of these
 * from the middle of a string, so they are stripped explicitly. Global flag:
 * only ever used with `String.replace`.
 */
const INVISIBLE_CHARS = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g

/** Characters outside ASCII, i.e. anything hex can never be. */
const NON_ASCII = /[^\u0000-\u007F]/

/**
 * Trim, and drop one optional `0x`/`0X` prefix.
 *
 * @param value - Candidate address or known address, any casing.
 */
function stripAddressPrefix(value: string): string {
  const trimmed = value.trim()
  return LEADING_0X.test(trimmed) ? trimmed.slice(2) : trimmed
}

/**
 * Remove invisible characters from a string.
 * @param body - Address body, any casing.
 */
function stripInvisible(body: string): string {
  return body.replace(INVISIBLE_CHARS, "")
}

/**
 * Length of the common prefix of two strings.
 * @param a - First string.
 * @param b - Second string.
 */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charAt(i) === b.charAt(i)) i += 1
  return i
}

/**
 * Length of the common suffix of two strings.
 * @param a - First string.
 * @param b - Second string.
 */
function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charAt(a.length - 1 - i) === b.charAt(b.length - 1 - i)) i += 1
  return i
}

/**
 * Human reason for a similarity match, with the true overlap lengths.
 *
 * @param shared - Which end(s) matched.
 * @param lead - Actual count of shared leading characters.
 * @param trail - Actual count of shared trailing characters.
 * @param matched - The matched known address.
 */
function describeSimilarity(
  shared: "leading" | "trailing" | "both",
  lead: number,
  trail: number,
  matched: string
): string {
  const shortened = truncateHex(matched, 8, 6)
  if (shared === "both") {
    return `first ${lead} and last ${trail} characters match ${shortened}`
  }
  return shared === "leading"
    ? `first ${lead} characters match ${shortened}`
    : `last ${trail} characters match ${shortened}`
}

// ===== Public API =====

/**
 * Screen one candidate address against the user's known addresses.
 *
 * Rules, in order:
 *
 * 1. Empty (or bare `0x`) input is nothing to warn about — the send form's
 *    own validation reports it.
 * 2. An exact, case-insensitive match with ANY known address is safe, even
 *    when the same string also resembles a different one.
 * 3. A well-formed address sharing at least {@link SHARED_CHARS} leading
 *    and/or trailing characters with a known address is suspect. Sharing both
 *    ends is the classic poisoning pattern and outranks a single-ended match.
 * 4. A string shaped like an address (40 characters, almost all hex) that
 *    contains non-hex characters — homoglyphs or invisible characters — is
 *    suspect on its own, with no known addresses required.
 * 5. Any other invalid input is ordinary invalid input, not an attack, and
 *    stays safe so the guard never cries wolf.
 *
 * @param candidate - Pasted or typed address, with or without `0x`.
 * @param knownAddresses - Addresses the user already trusts, any casing.
 */
export function screenAddress(
  candidate: string,
  knownAddresses: readonly string[]
): AddressScreen {
  const rawBody = stripAddressPrefix(candidate)
  if (rawBody === "") return { suspect: false }

  // Known entries are normalized once and malformed ones (an empty label
  // could never be a bookmark, but a hostile payload could be anything) are
  // dropped: they cannot be resembled and must not crash the comparison.
  const known = knownAddresses
    .map((address) => stripAddressPrefix(address).toLowerCase())
    .filter((body) => HEX_BODY.test(body))

  if (HEX_BODY.test(rawBody)) {
    const body = rawBody.toLowerCase()

    // Pass 1: exact match wins over any resemblance, because typing a known
    // address is the normal case the guard must not interrupt.
    if (known.includes(body)) return { suspect: false }

    // Pass 2: lookalike check. "both" is reported the moment it is found
    // (strongest signal); otherwise the first single-ended match is kept.
    let partial: AddressScreen | null = null
    for (const knownAddress of known) {
      const lead = commonPrefixLength(body, knownAddress)
      const trail = commonSuffixLength(body, knownAddress)
      if (lead < SHARED_CHARS && trail < SHARED_CHARS) continue

      const matched = `0x${knownAddress}`
      if (lead >= SHARED_CHARS && trail >= SHARED_CHARS) {
        return {
          suspect: true,
          matchedAddress: matched,
          shared: "both",
          detail: describeSimilarity("both", lead, trail, matched),
        }
      }
      if (partial === null) {
        const shared = lead >= SHARED_CHARS ? "leading" : "trailing"
        partial = {
          suspect: true,
          matchedAddress: matched,
          shared,
          detail: describeSimilarity(shared, lead, trail, matched),
        }
      }
    }
    return partial ?? { suspect: false }
  }

  // Not a well-formed address. Only a string that is shaped like one —
  // 40 characters after invisible characters are removed, almost all hex —
  // is worth a warning; everything else is the form's invalid-input case.
  const visible = stripInvisible(rawBody)
  const hexCount = (visible.match(HEX_CHAR) ?? []).length
  const addressShaped =
    visible.length === ADDRESS_BODY_LENGTH &&
    hexCount >= ADDRESS_BODY_LENGTH - MAX_LOOKALIKE_SUBSTITUTIONS

  if (addressShaped) {
    const hasInvisible = visible.length !== rawBody.length
    const hasNonAscii = NON_ASCII.test(visible)
    const detail = hasInvisible
      ? "contains invisible characters inside an address-shaped string"
      : hasNonAscii
        ? "contains non-ASCII lookalike characters inside an address-shaped string"
        : "contains characters that are not valid hex inside an address-shaped string"
    return { suspect: true, matchedAddress: "", shared: "non-hex", detail }
  }

  return { suspect: false }
}

/**
 * Turn a screening result into the sentence shown next to the address.
 *
 * Returns an empty string for a safe result, so callers can render
 * `describeSharedPattern(screen)` without their own suspect check when the
 * sentence is the only content.
 *
 * @param screen - Result of `screenAddress`.
 */
export function describeSharedPattern(screen: AddressScreen): string {
  if (!screen.suspect) return ""

  if (screen.shared === "non-hex") {
    return (
      "This looks like an address but contains characters that do not belong in one — " +
      "possibly lookalike letters or invisible characters, which scammers use to fake an " +
      "address. Verify it carefully."
    )
  }

  const which =
    screen.shared === "both" ? "first and last" : screen.shared === "leading" ? "first" : "last"
  return (
    `This address shares its ${which} ${SHARED_CHARS} characters with ` +
    `${truncateHex(screen.matchedAddress, 8, 6)}, an address you have used before — ` +
    "a common scam pattern. Verify it carefully."
  )
}

/**
 * Assemble the addresses the user already knows: every bookmark on every
 * network, plus every recipient in the local transaction history.
 *
 * Recipients matter as much as bookmarks: the poisoning payload arrives as a
 * transfer the user received, so the scammer's lookalike is designed to sit
 * next to a real counterparty in that history. Senders are deliberately
 * excluded — that is normally the user's own address, which says nothing
 * about who they intend to pay.
 *
 * Server-safe: the storage layer falls back to an in-memory backend when
 * `window` is absent, so no caller needs its own `typeof window` guard.
 *
 * @returns Deduplicated addresses, lowercase, `0x`-prefixed.
 */
export function collectKnownAddresses(): string[] {
  const seen = new Set<string>()

  const add = (address: string): void => {
    const body = stripAddressPrefix(address).toLowerCase()
    if (HEX_BODY.test(body)) seen.add(body)
  }

  for (const bookmark of getBookmarks()) add(bookmark.address)
  for (const transaction of getTransactionHistoryData()) add(transaction.to)

  return [...seen].map((body) => `0x${body}`)
}
