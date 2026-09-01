/**
 * EIP-712 typed-data signing and verification.
 *
 * The entry point is {@link validateTypedDataJSON}, which parses the JSON
 * payload a wallet such as MetaMask produces for `eth_signTypedData_v4`
 * (`types`, `primaryType`, `domain`, `message`). Everything downstream — the
 * digest, the signature, the recovery — is computed locally with ethers v6.
 *
 * One ethers v6 detail shapes the whole module: `TypedDataEncoder` requires
 * `types` WITHOUT an `EIP712Domain` entry, while real wallet payloads always
 * include one. The validator therefore checks the declared domain fields and
 * strips the entry, and every function here works with the stripped form.
 */

import {
  TypedDataEncoder,
  Wallet,
  getAddress,
  verifyTypedData as recoverTypedDataSigner,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers"
import {
  normalizeAddress,
  normalizePrivateKey,
  normalizeSignature,
  type SignResult,
  type Verification,
} from "./signMessage"

// ===== Types =====

/** A validated EIP-712 payload, ready to hash, sign, or verify. */
export interface ValidTypedData {
  /** The signing domain, exactly as pasted. */
  domain: TypedDataDomain
  /** The message struct types, with any `EIP712Domain` entry removed. */
  types: Record<string, Array<TypedDataField>>
  /** The message struct value. */
  message: Record<string, any>
  /** The primary type, derived from the type graph. */
  primaryType: string
  /** The EIP-712 digest (`keccak256(0x1901 ‖ domainSeparator ‖ structHash)`). */
  digest: string
}

/** The EIP-712 domain fields and the type each must be declared with. */
const DOMAIN_FIELD_TYPES: Readonly<Record<string, string>> = {
  name: "string",
  version: "string",
  chainId: "uint256",
  verifyingContract: "address",
  salt: "bytes32",
}

// ===== Validation =====

/**
 * Parse and validate an EIP-712 typed-data JSON payload.
 *
 * Validation is deliberately deep rather than syntactic: the type graph is
 * compiled with ethers (which rejects unknown struct references, circular
 * references, and ambiguous primary types), the declared `primaryType` is
 * cross-checked against the derived one, and the full digest is computed (which
 * rejects a message that is missing fields or has values of the wrong shape).
 * A payload that passes can be signed without a second round of surprises.
 *
 * @param text - The raw pasted JSON
 * @returns The validated payload including its digest, or a failure carrying a user-presentable message
 */
export function validateTypedDataJSON(text: string): SignResult<ValidTypedData> {
  const trimmed = text.trim()
  if (trimmed === "") {
    return { ok: false, error: "Paste an EIP-712 typed-data JSON payload." }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (cause) {
    return { ok: false, error: `The JSON is not valid${describeJsonPosition(trimmed, cause)}.` }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "The payload must be a JSON object." }
  }
  const payload = parsed as Record<string, unknown>

  // --- types ---
  if (
    typeof payload.types !== "object" ||
    payload.types === null ||
    Array.isArray(payload.types)
  ) {
    return { ok: false, error: 'The payload must include a "types" object.' }
  }
  const declaredTypes = payload.types as Record<string, unknown>
  const types: Record<string, Array<TypedDataField>> = {}
  for (const [structName, fields] of Object.entries(declaredTypes)) {
    // The domain entry is validated against the fixed EIP-712 field set and
    // then stripped: ethers derives the domain separator from the `domain`
    // object's own keys and rejects a types map that still carries it.
    if (structName === "EIP712Domain") {
      const domainCheck = validateDomainTypeEntry(fields)
      if (domainCheck !== null) {
        return { ok: false, error: domainCheck }
      }
      continue
    }
    if (!Array.isArray(fields)) {
      return { ok: false, error: `The type "${structName}" must be an array of fields.` }
    }
    const checked: TypedDataField[] = []
    for (const [index, field] of fields.entries()) {
      if (
        typeof field !== "object" ||
        field === null ||
        typeof (field as Record<string, unknown>).name !== "string" ||
        typeof (field as Record<string, unknown>).type !== "string"
      ) {
        return {
          ok: false,
          error: `Field ${index + 1} of type "${structName}" must be an object with a "name" and a "type", both strings.`,
        }
      }
      checked.push(field as TypedDataField)
    }
    types[structName] = checked
  }
  if (Object.keys(types).length === 0) {
    return {
      ok: false,
      error: 'The payload declares no message types. "types" must contain at least one struct besides EIP712Domain.',
    }
  }

  // --- domain ---
  if (
    typeof payload.domain !== "object" ||
    payload.domain === null ||
    Array.isArray(payload.domain)
  ) {
    return { ok: false, error: 'The payload must include a "domain" object.' }
  }
  const domain = payload.domain as TypedDataDomain

  // --- message ---
  if (
    typeof payload.message !== "object" ||
    payload.message === null ||
    Array.isArray(payload.message)
  ) {
    return { ok: false, error: 'The payload must include a "message" object.' }
  }
  const message = payload.message as Record<string, any>

  // --- primaryType ---
  const declaredPrimaryType = payload.primaryType
  if (declaredPrimaryType !== undefined && typeof declaredPrimaryType !== "string") {
    return { ok: false, error: '"primaryType", when present, must be a string.' }
  }

  // --- compile the type graph ---
  let encoder: TypedDataEncoder
  try {
    encoder = TypedDataEncoder.from(types)
  } catch (cause) {
    return {
      ok: false,
      error: `The types are not valid EIP-712 types: ${describeError(cause)}`,
    }
  }
  if (declaredPrimaryType !== undefined && declaredPrimaryType !== encoder.primaryType) {
    return {
      ok: false,
      error: `The payload declares primaryType "${declaredPrimaryType}", but the types make "${encoder.primaryType}" the primary type.`,
    }
  }

  // --- hash, which validates domain values and message shape end to end ---
  try {
    TypedDataEncoder.hashDomain(domain)
  } catch (cause) {
    return { ok: false, error: `The domain is not valid: ${describeError(cause)}` }
  }
  let digest: string
  try {
    digest = TypedDataEncoder.hash(domain, types, message)
  } catch (cause) {
    return {
      ok: false,
      error: `The message does not match the declared types: ${describeError(cause)}`,
    }
  }

  return {
    ok: true,
    value: { domain, types, message, primaryType: encoder.primaryType, digest },
  }
}

/**
 * Check a pasted `types.EIP712Domain` entry against the fields EIP-712 defines.
 *
 * ethers hashes the domain from the `domain` object's own keys, so a declared
 * entry cannot add or rename fields — a mismatch is reported rather than
 * silently ignored, because the user should know their domain separator does
 * not describe what they pasted.
 *
 * @param fields - The declared EIP712Domain field array
 * @returns null when the entry is acceptable, or a user-presentable error
 */
function validateDomainTypeEntry(fields: unknown): string | null {
  if (!Array.isArray(fields)) {
    return 'The "EIP712Domain" type must be an array of fields.'
  }
  for (const field of fields) {
    if (
      typeof field !== "object" ||
      field === null ||
      typeof (field as Record<string, unknown>).name !== "string"
    ) {
      return 'Each "EIP712Domain" field must be an object with a "name" string.'
    }
    const { name, type } = field as Record<string, unknown>
    const expected = DOMAIN_FIELD_TYPES[name as string]
    if (expected === undefined) {
      return `The EIP712Domain type may only declare name, version, chainId, verifyingContract and salt fields, not "${name as string}".`
    }
    if (type !== expected) {
      return `The EIP712Domain field "${name as string}" must be typed "${expected}", not "${String(type)}".`
    }
  }
  return null
}

// ===== Sign and verify =====

/**
 * Sign a validated EIP-712 payload.
 *
 * Delegates to `wallet.signTypedData(domain, types, value)`, which uses
 * `TypedDataEncoder` internally and returns a deterministic (RFC 6979)
 * signature.
 *
 * @param privateKey - The key text; see {@link normalizePrivateKey}
 * @param typedData - A payload produced by {@link validateTypedDataJSON}
 * @returns The 65-byte signature as `0x`-prefixed hex, or a failure carrying a user-presentable message
 */
export async function signTypedData(
  privateKey: string,
  typedData: ValidTypedData
): Promise<SignResult<string>> {
  const key = normalizePrivateKey(privateKey)
  if (!key.ok) {
    return key
  }
  try {
    const wallet = new Wallet(key.value)
    return {
      ok: true,
      value: await wallet.signTypedData(typedData.domain, typedData.types, typedData.message),
    }
  } catch {
    return { ok: false, error: "This private key cannot be used for signing." }
  }
}

/**
 * Recover the signer of an EIP-712 signature and compare it with an expected
 * address.
 *
 * Uses ethers' standalone `verifyTypedData(domain, types, value, signature)`.
 * As with personal_sign, a mismatch is a successful outcome (`matches: false`),
 * not an error.
 *
 * @param address - The address the signature is claimed to belong to
 * @param typedData - A payload produced by {@link validateTypedDataJSON}
 * @param signature - The signature text; see {@link normalizeSignature}
 * @returns The recovered address and whether it matches, or a failure carrying a user-presentable message
 */
export function verifyTypedDataSignature(
  address: string,
  typedData: ValidTypedData,
  signature: string
): SignResult<Verification> {
  const expected = normalizeAddress(address)
  if (!expected.ok) {
    return expected
  }
  const sig = normalizeSignature(signature)
  if (!sig.ok) {
    return sig
  }

  try {
    const recovered = getAddress(
      recoverTypedDataSigner(typedData.domain, typedData.types, typedData.message, sig.value)
    )
    return { ok: true, value: { recovered, matches: recovered === expected.value } }
  } catch {
    return { ok: false, error: "The signature could not be verified. Check that it is complete." }
  }
}

// ===== Error helpers =====

/**
 * Derive a "line L, column C" suffix for a JSON syntax error when cheaply possible.
 *
 * V8 and SpiderMonkey both embed an offset in `SyntaxError` messages (as
 * `position N` or `line L, column C`); when an offset is found, the line and
 * column are recomputed from the source so the message is uniform across
 * engines. No offset means no suffix — the raw engine message is kept instead.
 *
 * @param text - The JSON that failed to parse
 * @param cause - The thrown `SyntaxError`
 * @returns A suffix such as " (line 3, column 7)", or an empty string
 */
function describeJsonPosition(text: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  const at = /position (\d+)/.exec(message)
  if (at === null) {
    return `: ${describeError(cause)}`
  }
  const offset = Math.min(Number(at[1]), text.length)
  const before = text.slice(0, offset)
  const line = 1 + (before.match(/\n/g)?.length ?? 0)
  const column = offset - (before.lastIndexOf("\n") + 1) + 1
  return ` (line ${line}, column ${column})`
}

/**
 * Extract a readable message from an unknown thrown value.
 *
 * Prefers ethers' `shortMessage` (e.g. `ambiguous primary types or unused
 * types: "A", "C"`) over the full `message`, which drags along a serialized
 * copy of every argument.
 *
 * @param cause - The thrown value
 * @returns The most specific message available
 */
function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    if ("shortMessage" in cause && typeof cause.shortMessage === "string") {
      return cause.shortMessage
    }
    return cause.message
  }
  return String(cause)
}
