/**
 * Pure sweep planning.
 *
 * Turning balances and gas estimates into an ORDERED list of transfers is the
 * one decision-heavy part of a sweep, so it lives here as a pure function:
 * no network, no React, no storage — fully testable against hostile inputs.
 * The card (`components/SweepCard.tsx`) stays a thin shell that fetches the
 * inputs, renders the plan, and executes it.
 *
 * Ordering rule: ERC-20 transfers go FIRST and the native transfer goes LAST.
 * Every transfer burns native gas, so spending the native balance before the
 * tokens have moved could leave the sweep half-done with no fuel to finish it.
 *
 * Native amount rule: balance minus a gas RESERVE, never the full balance. The
 * reserve is the estimated fee for every transfer in the plan plus 50% headroom
 * (the same margin `components/SendForm.tsx` uses), because the base fee can
 * rise between estimate and inclusion and OP-stack chains add an L1 data fee
 * the estimate does not include. A sweep that bounces its last transfer for
 * insufficient funds is worse than one that leaves a little dust behind.
 */

import { getAddress, isAddress } from "ethers"

// ===== Types =====

/** Upper bound on tokens in one sweep, mirroring the tracked-token cap. */
export const MAX_SWEEP_TOKENS = 50

/**
 * Fee headroom over the total estimate kept as reserve, as a divisor: 2n keeps
 * an extra 50% on top of the estimated total, matching the send form's margin.
 */
const RESERVE_HEADROOM_DIVISOR = 2n

/** A tracked ERC-20 with its live balance and gas estimate, ready for planning. */
export interface SweepTokenInput {
  contractAddress: string
  symbol: string
  decimals: number
  /** Base-unit balance. Zero-balance tokens are skipped; negative is rejected. */
  balance: bigint
  /** Gas limit estimated for this token's transfer. Must be positive. */
  gasLimit: bigint
}

/** Everything the planner needs; every field is untrusted until validated. */
export interface PlanSweepInput {
  /** The account being swept. Must not equal the destination. */
  from: string
  destination: string
  /** Native balance in base units. */
  nativeBalance: bigint
  /** Decimal places of the native currency. */
  nativeDecimals: number
  /** Native currency symbol, for row labels and totals. */
  nativeSymbol: string
  /** Gas limit estimated for the native transfer. Required when one is planned. */
  nativeGasLimit: bigint
  tokens: SweepTokenInput[]
  /**
   * Node-suggested price per gas unit, or null when the node offered none.
   * With null, fee figures are reported as unknown and no gas reserve is kept
   * (the send-time estimate then decides honestly whether the transfer fits).
   */
  feePerGas: bigint | null
}

/** One planned transfer, in execution order. */
export interface PlannedTransfer {
  kind: "token" | "native"
  /** ERC-20 contract for token transfers; the destination for the native one. */
  to: string
  symbol: string
  decimals: number
  /** Base-unit amount to send. */
  amount: bigint
  gasLimit: bigint
  /** gasLimit × feePerGas, or null when the fee is unknown. */
  estimatedFeeWei: bigint | null
}

/** The ordered plan the card reviews and executes. */
export interface SweepPlan {
  /** Destination in exact EIP-55 form. */
  destination: string
  /** Token transfers first, native transfer last. May be empty: nothing to sweep. */
  transfers: PlannedTransfer[]
  totalGasLimit: bigint
  totalEstimatedFeeWei: bigint | null
  /** The native amount the plan would send (0n when none is planned). */
  nativeAmount: bigint
  /** Native base units held back to cover gas for the whole plan. */
  reserveWei: bigint
}

/** Outcome of planning, mirroring the app's result convention. */
export type SweepPlanResult = { ok: true; value: SweepPlan } | { ok: false; error: string }

// ===== Planner =====

/**
 * Build the ordered transfer plan.
 *
 * Every input is validated before it influences an amount, because the inputs
 * originate in `localStorage` (token list) and JSON-RPC responses (balances,
 * estimates) — neither of which this module trusts. Structurally invalid input
 * rejects the whole plan rather than producing a partial sweep the user never
 * saw coming; a merely empty balance (zero) is skipped, not an error.
 *
 * @returns The plan (possibly with zero transfers — an honest "nothing to
 *   sweep"), or a user-presentable error.
 */
export function planSweep(input: PlanSweepInput): SweepPlanResult {
  if (typeof input.from !== "string" || !isAddress(input.from)) {
    return { ok: false, error: "The account being swept is not a valid address." }
  }
  if (typeof input.destination !== "string" || !isAddress(input.destination)) {
    return { ok: false, error: "The destination address is not valid." }
  }

  let from: string
  let destination: string
  try {
    from = getAddress(input.from)
    destination = getAddress(input.destination)
  } catch {
    return { ok: false, error: "The destination address is not valid." }
  }

  // Sweeping to the source account is either a mistake or a no-op; either way
  // it would burn fees to move nothing.
  if (from.toLowerCase() === destination.toLowerCase()) {
    return { ok: false, error: "The destination is the account being swept." }
  }

  if (!Number.isInteger(input.nativeDecimals) || input.nativeDecimals < 0 || input.nativeDecimals > 36) {
    return { ok: false, error: "The native currency decimals are not valid." }
  }
  if (typeof input.nativeSymbol !== "string" || input.nativeSymbol === "") {
    return { ok: false, error: "The native currency symbol is not valid." }
  }
  if (input.nativeBalance < 0n) {
    return { ok: false, error: "The native balance is not valid." }
  }
  if (input.feePerGas !== null && input.feePerGas < 0n) {
    return { ok: false, error: "The fee estimate is not valid." }
  }
  if (input.tokens.length > MAX_SWEEP_TOKENS) {
    return { ok: false, error: `A sweep covers at most ${MAX_SWEEP_TOKENS} tokens.` }
  }

  const feeOf = (gasLimit: bigint): bigint | null =>
    input.feePerGas === null ? null : gasLimit * input.feePerGas

  // Deduplicate by contract: a hostile or restored storage entry listed twice
  // must not produce two transfers of the same token.
  const seenContracts = new Set<string>()
  const tokens: PlannedTransfer[] = []
  for (const token of input.tokens) {
    if (typeof token.symbol !== "string" || token.symbol === "" || token.symbol.length > 64) {
      return { ok: false, error: "A tracked token has an unusable symbol." }
    }
    if (typeof token.contractAddress !== "string" || !isAddress(token.contractAddress)) {
      return { ok: false, error: `The ${token.symbol} contract address is not valid.` }
    }
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
      return { ok: false, error: `The decimals for ${token.symbol} are not valid.` }
    }
    if (token.balance < 0n) {
      return { ok: false, error: `The ${token.symbol} balance is not valid.` }
    }
    if (token.gasLimit <= 0n) {
      return { ok: false, error: `The gas estimate for ${token.symbol} is not usable.` }
    }

    const contract = getAddress(token.contractAddress)
    if (seenContracts.has(contract.toLowerCase())) continue
    seenContracts.add(contract.toLowerCase())

    // A zero balance is an honest "nothing of this token", not hostile input.
    if (token.balance === 0n) continue

    tokens.push({
      kind: "token",
      to: contract,
      symbol: token.symbol,
      decimals: token.decimals,
      amount: token.balance,
      gasLimit: token.gasLimit,
      estimatedFeeWei: feeOf(token.gasLimit),
    })
  }

  const needsNative = input.nativeBalance > 0n
  if (needsNative && input.nativeGasLimit <= 0n) {
    return { ok: false, error: "The gas estimate for the native transfer is not usable." }
  }

  // The reserve must cover EVERY transfer in the plan, not just the native one.
  const totalGasLimit =
    tokens.reduce((sum, transfer) => sum + transfer.gasLimit, 0n) +
    (needsNative ? input.nativeGasLimit : 0n)
  const totalEstimatedFeeWei =
    input.feePerGas === null ? null : totalGasLimit * input.feePerGas
  const reserveWei =
    totalEstimatedFeeWei === null
      ? 0n
      : totalEstimatedFeeWei + totalEstimatedFeeWei / RESERVE_HEADROOM_DIVISOR
  const nativeAmount =
    input.nativeBalance > reserveWei ? input.nativeBalance - reserveWei : 0n

  // Tokens first, native last: each transfer burns native gas, so the native
  // balance must not be spent until every token transfer is done.
  const transfers: PlannedTransfer[] = [...tokens]
  if (nativeAmount > 0n) {
    transfers.push({
      kind: "native",
      to: destination,
      symbol: input.nativeSymbol,
      decimals: input.nativeDecimals,
      amount: nativeAmount,
      gasLimit: input.nativeGasLimit,
      estimatedFeeWei: feeOf(input.nativeGasLimit),
    })
  }

  return {
    ok: true,
    value: {
      destination,
      transfers,
      totalGasLimit,
      totalEstimatedFeeWei,
      nativeAmount,
      reserveWei,
    },
  }
}
