/**
 * Vanity key generation: the batch primitive shared by the Web Worker
 * (lib/vanityWorker.ts) and the main-thread fallback in the UI.
 *
 * This is the only module that creates keys, so both execution paths check
 * prefixes with the same logic and draw from the same entropy source. Keys
 * come from ethers' `randomBytes` (crypto.getRandomValues) — never
 * `Math.random`, which is predictable and unsuitable for key material.
 *
 * A fresh `Wallet` is built from raw entropy rather than
 * `Wallet.createRandom()`: createRandom derives through a random mnemonic,
 * which costs 2048 PBKDF2 rounds per key and would collapse the search rate by
 * orders of magnitude for no security benefit. Both paths yield a uniformly
 * random secp256k1 key, which is what the difficulty estimate assumes.
 */

import { Wallet, hexlify, randomBytes } from "ethers"
import { matchesVanityAddress } from "./vanity"

/** A found key. Contains a private key: treat as secret, never log or persist. */
export interface VanityHit {
  /** EIP-55 checksummed address. */
  address: string
  /** Hex private key, `0x`-prefixed. */
  privateKey: string
}

/** Outcome of one batch of generation. */
export interface VanityBatchResult {
  /** Keys generated in this batch, including the hit itself if there was one. */
  attempts: number
  hit: VanityHit | null
}

/** Message the worker posts to the UI; `attempts` is cumulative per search. */
export type VanityWorkerMessage =
  | { type: "progress"; attempts: number }
  | { type: "found"; attempts: number; address: string; privateKey: string }

/** Command the UI posts to the worker. */
export type VanityWorkerCommand = { type: "start"; pattern: string }

/**
 * Generate up to `batchSize` random keys, stopping at the first address that
 * matches the pattern.
 *
 * @param pattern - Normalized pattern from `validateVanityPattern`.
 * @param batchSize - Maximum keys to try in this call. Callers on the UI
 *   thread must keep this small enough that one call stays well under a frame.
 */
export function runVanityBatch(pattern: string, batchSize: number): VanityBatchResult {
  let attempts = 0
  while (attempts < batchSize) {
    attempts += 1
    const wallet = new Wallet(hexlify(randomBytes(32)))
    if (matchesVanityAddress(wallet.address, pattern)) {
      return { attempts, hit: { address: wallet.address, privateKey: wallet.privateKey } }
    }
  }
  return { attempts, hit: null }
}
