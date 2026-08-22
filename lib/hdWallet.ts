/**
 * BIP-32/39/44 hierarchical deterministic wallet derivation.
 *
 * Everything in this module is pure and synchronous, and runs only in the
 * browser. Seeds and private keys are returned to the caller for in-memory use;
 * nothing here persists or transmits anything.
 *
 * This module is also the single source of truth for deciding whether a piece
 * of user input is a mnemonic or a private key. The rest of the app must call
 * {@link classifySecret} rather than re-implementing that heuristic.
 */

import { HDNodeWallet, Mnemonic, Wallet, isHexString, randomBytes } from "ethers"

/** BIP-39 permits five phrase lengths. All are supported. */
export const MNEMONIC_WORD_COUNTS = [12, 15, 18, 21, 24] as const

/** A valid BIP-39 phrase length. */
export type MnemonicWordCount = (typeof MNEMONIC_WORD_COUNTS)[number]

/** Entropy bytes required for each supported phrase length. */
const ENTROPY_BYTES: Record<MnemonicWordCount, number> = {
  12: 16,
  15: 20,
  18: 24,
  21: 28,
  24: 32,
}

/** A named derivation-path layout. */
export interface DerivationPreset {
  /** Stable identifier used in persisted state. */
  id: string
  /** Human-readable name shown in the UI. */
  label: string
  /** Where this layout is commonly used. */
  description: string
  /** Path template containing exactly one `{index}` placeholder. */
  template: string
}

/**
 * Derivation layouts used by common wallets.
 *
 * The same seed yields entirely different addresses under each layout, which is
 * the usual reason a recovered wallet "shows the wrong address".
 *
 * Note that BIP-44 and Ledger Live resolve to the *same* path at index 0
 * (`m/44'/60'/0'/0/0`) and only diverge from index 1 onward. A user comparing
 * just the first account will therefore see no difference between them.
 */
export const DERIVATION_PRESETS: readonly DerivationPreset[] = [
  {
    id: "bip44",
    label: "BIP-44 (default)",
    description: "MetaMask, Rabby, Trust Wallet, most software wallets",
    template: "m/44'/60'/0'/0/{index}",
  },
  {
    id: "ledger-live",
    label: "Ledger Live",
    description: "Varies the account index; matches BIP-44 only at index 0",
    template: "m/44'/60'/{index}'/0/0",
  },
  {
    id: "legacy",
    label: "Legacy (MEW / Ledger)",
    description: "MyEtherWallet and older Ledger firmware",
    template: "m/44'/60'/0'/{index}",
  },
] as const

/** The layout used when the user has not chosen one. */
export const DEFAULT_PRESET_ID = "bip44"

/** Look up a preset by id. */
export function getPreset(id: string): DerivationPreset | undefined {
  return DERIVATION_PRESETS.find((p) => p.id === id)
}

// ===== Result types =====

/** Outcome of an operation driven by user input. */
export type HdResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** A single derived account. Contains a private key: treat as secret. */
export interface DerivedAccount {
  /** Index substituted into the path template. */
  index: number
  /** Fully resolved derivation path. */
  path: string
  /** Checksummed address. */
  address: string
  /** Hex private key, `0x`-prefixed. */
  privateKey: string
}

/** What kind of secret a piece of input appears to be. */
export type SecretKind = "mnemonic" | "private-key" | "unknown"

/** Result of inspecting untrusted secret input. */
export interface SecretClassification {
  kind: SecretKind
  /** Whitespace-normalized input, safe to hand to ethers. */
  normalized: string
  /** Word count when the input looks like a phrase. */
  wordCount: number
  /** Why the input could not be classified, when `kind` is `unknown`. */
  reason?: string
}

// ===== Input normalization =====

/**
 * Collapse all whitespace runs to single spaces and trim.
 *
 * Phrases copied from a paper backup often arrive newline- or tab-separated, or
 * with a double space between words. Splitting on `" "` alone would treat those
 * as a single unparseable token, so normalize before any other check.
 *
 * @param input - Raw text from a textarea.
 */
export function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, " ")
}

/**
 * Decide whether input is a mnemonic phrase or a private key.
 *
 * Classification is structural only: it reports what the input *looks* like and
 * does not verify a BIP-39 checksum or a key's validity. Use
 * {@link validateMnemonic} or {@link deriveFromPrivateKey} for that.
 *
 * @param input - Raw secret text.
 */
export function classifySecret(input: string): SecretClassification {
  const normalized = normalizeWhitespace(input)

  if (normalized === "") {
    return { kind: "unknown", normalized, wordCount: 0, reason: "Input is empty." }
  }

  const words = normalized.split(" ")

  // A single token containing no spaces is a private key candidate.
  if (words.length === 1) {
    const withPrefix = normalized.startsWith("0x") ? normalized : `0x${normalized}`
    if (isHexString(withPrefix, 32)) {
      return { kind: "private-key", normalized: withPrefix, wordCount: 1 }
    }
    return {
      kind: "unknown",
      normalized,
      wordCount: 1,
      reason: "A private key must be 64 hexadecimal characters.",
    }
  }

  if ((MNEMONIC_WORD_COUNTS as readonly number[]).includes(words.length)) {
    return { kind: "mnemonic", normalized: normalized.toLowerCase(), wordCount: words.length }
  }

  return {
    kind: "unknown",
    normalized,
    wordCount: words.length,
    reason: `A recovery phrase must be ${MNEMONIC_WORD_COUNTS.join(", ")} words. Found ${words.length}.`,
  }
}

// ===== Mnemonic validation and generation =====

/**
 * Validate a BIP-39 phrase, including its checksum.
 *
 * @param phrase - Candidate phrase; whitespace is normalized first.
 * @returns The normalized phrase, or a user-presentable error.
 */
export function validateMnemonic(phrase: string): HdResult<string> {
  const normalized = normalizeWhitespace(phrase).toLowerCase()
  if (normalized === "") return { ok: false, error: "Enter a recovery phrase." }

  const wordCount = normalized.split(" ").length
  if (!(MNEMONIC_WORD_COUNTS as readonly number[]).includes(wordCount)) {
    return {
      ok: false,
      error: `A recovery phrase must be ${MNEMONIC_WORD_COUNTS.join(", ")} words. Found ${wordCount}.`,
    }
  }

  if (!Mnemonic.isValidMnemonic(normalized)) {
    return {
      ok: false,
      error:
        "This phrase is not valid. Check for misspelled words or words in the wrong order.",
    }
  }

  return { ok: true, value: normalized }
}

/**
 * Generate a new random phrase.
 *
 * Entropy comes from ethers' `randomBytes`, which is backed by
 * `crypto.getRandomValues`. Never substitute `Math.random` here.
 *
 * @param wordCount - Desired phrase length.
 */
export function generateMnemonic(wordCount: MnemonicWordCount = 12): HdResult<string> {
  const bytes = ENTROPY_BYTES[wordCount]
  if (bytes === undefined) {
    return { ok: false, error: `Unsupported word count: ${wordCount}.` }
  }
  try {
    return { ok: true, value: Mnemonic.fromEntropy(randomBytes(bytes)).phrase }
  } catch {
    return { ok: false, error: "Could not generate a recovery phrase. Please try again." }
  }
}

// ===== Derivation paths =====

/**
 * Validate a BIP-32 derivation path.
 *
 * Accepts absolute paths only (`m/...`), with optional hardened markers, and
 * bounds each index to 2^31-1 so a hardened index cannot overflow.
 *
 * @param path - Candidate path.
 */
export function validateDerivationPath(path: string): HdResult<string> {
  const trimmed = path.trim()
  if (trimmed === "") return { ok: false, error: "Enter a derivation path." }
  if (!/^m(\/\d+'?)+$/.test(trimmed)) {
    return {
      ok: false,
      error: "Path must look like m/44'/60'/0'/0/0.",
    }
  }

  for (const segment of trimmed.split("/").slice(1)) {
    const index = Number(segment.replace("'", ""))
    if (!Number.isInteger(index) || index < 0 || index > 2_147_483_647) {
      return { ok: false, error: `Path segment "${segment}" is out of range.` }
    }
  }

  return { ok: true, value: trimmed }
}

/**
 * Substitute an index into a preset template.
 *
 * @param template - Template containing one `{index}` placeholder.
 * @param index - Non-negative account or address index.
 */
export function buildPath(template: string, index: number): HdResult<string> {
  if (!Number.isInteger(index) || index < 0 || index > 2_147_483_647) {
    return { ok: false, error: "Index must be a non-negative whole number." }
  }
  if (!template.includes("{index}")) {
    return { ok: false, error: "Path template must contain {index}." }
  }
  return validateDerivationPath(template.replace("{index}", String(index)))
}

// ===== Account derivation =====

/** Inputs for {@link deriveAccounts}. */
export interface DeriveAccountsOptions {
  /** BIP-39 phrase. Validated before use. */
  mnemonic: string
  /** Optional BIP-39 passphrase, sometimes called the 25th word. */
  passphrase?: string
  /** Path template with an `{index}` placeholder. */
  template?: string
  /** First index to derive, inclusive. */
  startIndex?: number
  /** How many consecutive indices to derive. */
  count?: number
}

/** Largest batch a single call will derive, to bound UI work. */
export const MAX_DERIVE_COUNT = 100

/**
 * Derive a contiguous range of accounts from one phrase.
 *
 * The seed is computed once and reused for every index. Deriving each account
 * from the phrase instead would re-run PBKDF2 (2048 HMAC-SHA512 rounds) per
 * account, which is slow enough to stall the main thread on mobile.
 *
 * @param options - Phrase, optional passphrase, path template, and range.
 * @returns Derived accounts in index order, or a user-presentable error.
 */
export function deriveAccounts(options: DeriveAccountsOptions): HdResult<DerivedAccount[]> {
  const {
    mnemonic,
    passphrase = "",
    template = DERIVATION_PRESETS[0].template,
    startIndex = 0,
    count = 1,
  } = options

  const validated = validateMnemonic(mnemonic)
  if (!validated.ok) return validated

  if (!Number.isInteger(startIndex) || startIndex < 0) {
    return { ok: false, error: "Start index must be a non-negative whole number." }
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_DERIVE_COUNT) {
    return { ok: false, error: `Count must be between 1 and ${MAX_DERIVE_COUNT}.` }
  }
  if (!template.includes("{index}")) {
    return { ok: false, error: "Path template must contain {index}." }
  }

  try {
    const phrase = Mnemonic.fromPhrase(validated.value, passphrase)
    const root = HDNodeWallet.fromSeed(phrase.computeSeed())

    const accounts: DerivedAccount[] = []
    for (let i = 0; i < count; i++) {
      const index = startIndex + i
      const path = buildPath(template, index)
      if (!path.ok) return path

      const node = root.derivePath(path.value)
      accounts.push({
        index,
        path: path.value,
        address: node.address,
        privateKey: node.privateKey,
      })
    }

    return { ok: true, value: accounts }
  } catch {
    return {
      ok: false,
      error: "Could not derive accounts. Check the recovery phrase and derivation path.",
    }
  }
}

/**
 * Derive a single account from a raw private key.
 *
 * A raw key has no derivation path, so no HD node is involved.
 *
 * @param privateKey - Hex key, with or without the `0x` prefix.
 */
export function deriveFromPrivateKey(
  privateKey: string
): HdResult<{ address: string; privateKey: string }> {
  const classification = classifySecret(privateKey)
  if (classification.kind !== "private-key") {
    return {
      ok: false,
      error: classification.reason ?? "This is not a valid private key.",
    }
  }

  try {
    const wallet = new Wallet(classification.normalized)
    return { ok: true, value: { address: wallet.address, privateKey: wallet.privateKey } }
  } catch {
    return { ok: false, error: "This is not a valid private key." }
  }
}
