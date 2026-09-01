/**
 * Vanity address patterns: validation, matching, and difficulty estimation.
 *
 * Everything here is pure and dependency-free (not even ethers) so the Web
 * Worker, the main-thread fallback, and the unit tests all share exactly one
 * implementation of the rules. Key *generation* deliberately lives in
 * `lib/vanityEngine.ts` — keeping this module free of crypto keeps it fully
 * testable and lets the UI import validation without dragging key-handling
 * code into scope.
 *
 * Difficulty model: an address is 40 uniformly distributed hex characters, so
 * a random key matches an n-character prefix with probability 16^-n and the
 * expected number of attempts before a hit is 16^n. The cap of 4 characters
 * exists because that expectation grows sixteen-fold per extra character —
 * 4 characters is minutes of browser work, 6 is usually hours.
 */

/** Longest prefix this tool will search for. See the module note above. */
export const MAX_VANITY_LENGTH = 4

/**
 * Outcome of an operation driven by user input.
 *
 * Mirrors the `HdResult` convention of `lib/hdWallet.ts` rather than importing
 * it, because importing it would pull ethers into this otherwise dependency-
 * free module.
 */
export type VanityResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Validate and normalize a vanity prefix.
 *
 * Accepts an optional `0x` (either case) and any letter case; returns the
 * lowercase hex characters without the prefix, ready for
 * {@link matchesVanityAddress}. Patterns longer than {@link MAX_VANITY_LENGTH}
 * are rejected with the expected-attempts figure for the entered length, so
 * the refusal explains itself instead of looking like an arbitrary limit.
 *
 * @param input - Raw text from the pattern field.
 */
export function validateVanityPattern(input: string): VanityResult<string> {
  const trimmed = input.trim()
  if (trimmed === "") {
    return { ok: false, error: "Enter 1 to 4 hexadecimal characters, for example 0xdead." }
  }

  // The 0x belongs to every address, not to the pattern; strip it so the
  // returned value matches against the hex body directly.
  const normalized = trimmed.replace(/^0[xX]/, "").toLowerCase()

  if (normalized === "") {
    return { ok: false, error: "Enter 1 to 4 hexadecimal characters after the 0x." }
  }

  if (!/^[0-9a-f]+$/.test(normalized)) {
    return {
      ok: false,
      error: "A prefix can only contain hexadecimal characters (0-9 and a-f).",
    }
  }

  if (normalized.length > MAX_VANITY_LENGTH) {
    const attempts = estimateVanityAttempts(normalized)
    // 16^n overflows to Infinity around n ≈ 258; past that the figure is past
    // any human scale anyway, so name it qualitatively instead of printing
    // "Infinity".
    const figure = Number.isFinite(attempts) ? formatAttemptCount(attempts) : "more than 10^300"
    return {
      ok: false,
      error:
        `Prefixes are limited to ${MAX_VANITY_LENGTH} characters. ` +
        `A ${normalized.length}-character prefix needs about ${figure} keys on average ` +
        `(a ${MAX_VANITY_LENGTH}-character prefix needs about ${formatAttemptCount(
          16 ** MAX_VANITY_LENGTH
        )}), and each extra character multiplies the work by 16.`,
    }
  }

  return { ok: true, value: normalized }
}

/**
 * Whether an address starts with the pattern.
 *
 * Addresses from ethers are EIP-55 checksummed (mixed case), so both sides are
 * lowercased before comparing. An empty pattern matches every address; that can
 * only happen when this is called directly, because validation rejects empty
 * input.
 *
 * @param address - Hex address, with or without the `0x` prefix, any case.
 * @param normalizedPattern - Pattern from {@link validateVanityPattern}.
 */
export function matchesVanityAddress(address: string, normalizedPattern: string): boolean {
  const hex = (address.startsWith("0x") || address.startsWith("0X") ? address.slice(2) : address)
    .toLowerCase()
  return hex.startsWith(normalizedPattern.toLowerCase())
}

/**
 * Expected number of random keys before an address matches the pattern.
 *
 * Each hex character of prefix divides the chance of a match by 16, so the
 * expectation is 16^n. An empty pattern "matches" immediately (16^0 = 1).
 *
 * @param normalizedPattern - Pattern from {@link validateVanityPattern}.
 */
export function estimateVanityAttempts(normalizedPattern: string): number {
  return 16 ** normalizedPattern.length
}

/**
 * Format an attempt count for display.
 *
 * Pinned to `en-US` grouping rather than the user's locale: these are technical
 * counts, and deterministic output keeps the too-long-pattern error (which
 * embeds the figure) testable in any environment. Very large counts collapse
 * to exponential form — a 49-digit integer in an error message convinces no
 * one.
 */
export function formatAttemptCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "unknown"
  if (count < 1e15) return new Intl.NumberFormat("en-US").format(count)

  const [mantissa, exponent] = count.toExponential(1).split("e")
  return `${mantissa}×10^${Number(exponent)}`
}
