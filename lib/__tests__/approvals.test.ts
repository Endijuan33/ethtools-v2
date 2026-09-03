import { test } from "node:test"
import assert from "node:assert/strict"
import { getAddress } from "ethers"

import {
  APPROVAL_TOPIC0,
  CHUNK_BLOCK_SIZE,
  LOG_PAGE_CAP,
  MAX_LOGS_PER_NETWORK,
  chunkBlockRanges,
  decodeAllowanceResult,
  extractApprovalPairs,
  isUnlimitedAllowance,
  needsSplitting,
  splitBlockRange,
} from "../approvals"

/**
 * These tests cover the pure policy helpers only — no network, no mocks. They
 * are the security boundary between the explorers and the UI: every rule that
 * decides which log entries are believed, how block ranges are walked, when a
 * page must be split, which allowances read as unlimited, and which eth_call
 * results decode at all is exercised with plain fixtures. Real eth_getLogs
 * payloads carry reorg flags, spam contracts, and malformed fields; hostile
 * samples are the assumption, not the edge case.
 */

/** A distinct valid address per index, so dedupe and ordering assertions stay unambiguous. */
function addr(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`
}

/** Left-pad a 20-byte address into its 32-byte indexed-topic encoding. */
function topic(index: number): string {
  return `0x000000000000000000000000${index.toString(16).padStart(40, "0")}`
}

/** ABI-encoded uint256 as log `data`, hex. */
function dataHex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`
}

/** A boring, valid Approval log for pair (tokenIndex, spenderIndex). */
function approvalLog(
  tokenIndex: number,
  spenderIndex: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    address: addr(tokenIndex),
    topics: [APPROVAL_TOPIC0, topic(99), topic(spenderIndex)],
    data: dataHex(10n ** 18n),
    blockNumber: "0x1b4",
    ...overrides,
  }
}

// ===== extractApprovalPairs =====

test("an empty log list yields no pairs and no truncation", () => {
  for (const logs of [[], { result: [] }, { result: null }, null, undefined, {}, "nope", 42]) {
    const result = extractApprovalPairs(logs)
    assert.deepEqual(result.pairs, [], `payload ${String(logs)} must yield no pairs`)
    assert.equal(result.truncated, false)
  }
})

test("a valid approval log yields a checksummed pair", () => {
  const result = extractApprovalPairs([approvalLog(1, 2)])
  assert.equal(result.pairs.length, 1)
  assert.equal(result.pairs[0].token, addr(1))
  assert.equal(result.pairs[0].spender, addr(2))
  assert.equal(result.truncated, false)
})

test("a full JSON-RPC envelope is unwrapped", () => {
  const result = extractApprovalPairs({ jsonrpc: "2.0", id: 1, result: [approvalLog(3, 4)] })
  assert.equal(result.pairs.length, 1)
  assert.equal(result.pairs[0].token, addr(3))
  assert.equal(result.pairs[0].spender, addr(4))
})

test("duplicate pairs collapse regardless of block or value", () => {
  const result = extractApprovalPairs([
    approvalLog(1, 2, { blockNumber: "0x1" }),
    approvalLog(1, 2, { blockNumber: "0x2", data: dataHex(5n) }),
    approvalLog(1, 2, { blockNumber: "0x3", data: dataHex(0n) }),
    approvalLog(2, 2),
  ])
  assert.deepEqual(result.pairs, [
    { token: addr(1), spender: addr(2) },
    { token: addr(2), spender: addr(2) },
  ])
})

test("an approval to zero still yields a pair — history is history", () => {
  const result = extractApprovalPairs([approvalLog(1, 2, { data: dataHex(0n) })])
  assert.equal(result.pairs.length, 1)
})

test("hostile and malformed entries are discarded while a valid sibling survives", () => {
  const result = extractApprovalPairs([
    approvalLog(1, 2, { address: "not-an-address" }),
    approvalLog(2, 2, { address: "0xzzzz" }),
    // Mixed-case with a broken checksum: isAddress-shaped, getAddress-invalid.
    approvalLog(3, 2, { address: `0xAbCd${"ef".repeat(18)}` }),
    approvalLog(4, 2, { topics: [] }),
    approvalLog(5, 2, { topics: [APPROVAL_TOPIC0, topic(99)] }),
    approvalLog(6, 2, { topics: ["0x" + "ab".repeat(32), topic(99), topic(2)] }),
    approvalLog(7, 2, { topics: [APPROVAL_TOPIC0, topic(99), "0x1234"] }),
    // Nonzero left-padding in the spender topic is not an address encoding.
    approvalLog(8, 2, {
      topics: [APPROVAL_TOPIC0, topic(99), `0x${"00".repeat(11)}01${"ab".repeat(20)}`],
    }),
    approvalLog(9, 2, { data: "0x1" }), // odd-length hex
    approvalLog(10, 2, { data: "nope" }),
    approvalLog(11, 2, { data: dataHex(10n ** 78n) }), // beyond uint256
    approvalLog(12, 2, { data: `0x${"ff".repeat(33)}` }), // 33 bytes
    approvalLog(13, 2, { data: undefined }),
    approvalLog(14, 2, { blockNumber: "12345" }),
    approvalLog(15, 2, { blockNumber: "0xGG" }),
    approvalLog(16, 2, { removed: true }),
    "just a string",
    42,
    null,
    {},
    // The valid sibling that must survive all of the above.
    approvalLog(99, 3),
  ])

  assert.deepEqual(result.pairs, [{ token: addr(99), spender: addr(3) }])
  assert.equal(result.truncated, false)
})

test("a non-boolean removed flag is ignored — only a real reorg flag skips a log", () => {
  const result = extractApprovalPairs([approvalLog(1, 2, { removed: "true" })])
  assert.equal(result.pairs.length, 1)
})

test("uppercase hex in address and topics is normalized, not discarded", () => {
  // Indexes chosen so the addresses actually contain hex letters.
  const token = addr(0xabc)
  const spender = topic(0xdef)
  const result = extractApprovalPairs([
    {
      address: `0x${token.slice(2).toUpperCase()}`,
      topics: [APPROVAL_TOPIC0, topic(99), `0x${spender.slice(2).toUpperCase()}`],
      data: dataHex(1n),
      blockNumber: "0x1",
    },
  ])
  assert.equal(result.pairs.length, 1)
  // Whatever case the payload used, the pair must come back EIP-55 checksummed.
  assert.equal(result.pairs[0].token, getAddress(token))
  assert.equal(result.pairs[0].spender, getAddress(addr(0xdef)))
})

test("the pair cap bounds the result and reports truncation honestly", () => {
  const logs = [approvalLog(1, 1), approvalLog(2, 2), approvalLog(3, 3), approvalLog(4, 4)]

  const atCap = extractApprovalPairs(logs, 4)
  assert.equal(atCap.pairs.length, 4)
  assert.equal(atCap.truncated, false)

  const overCap = extractApprovalPairs(logs, 2)
  assert.equal(overCap.pairs.length, 2)
  assert.deepEqual(overCap.pairs, [
    { token: addr(1), spender: addr(1) },
    { token: addr(2), spender: addr(2) },
  ])
  assert.equal(overCap.truncated, true)
})

test("duplicates do not consume the cap", () => {
  const logs = [
    approvalLog(1, 1),
    approvalLog(1, 1),
    approvalLog(1, 1),
    approvalLog(2, 2),
    approvalLog(3, 3),
  ]
  const result = extractApprovalPairs(logs, 2)
  assert.equal(result.pairs.length, 2)
  assert.equal(result.truncated, true)
})

test("a non-positive or fractional cap falls back to the default rather than misbehaving", () => {
  for (const cap of [0, -5, 2.5]) {
    const result = extractApprovalPairs([approvalLog(1, 1)], cap)
    assert.equal(result.pairs.length, 1, `cap ${String(cap)} must not drop valid pairs`)
    assert.equal(result.truncated, false)
  }
})

test("a payload beyond the parse bound is truncated without stalling", () => {
  const hostile = Array.from({ length: 20_000 }, (_, index) => approvalLog(index, index))
  const result = extractApprovalPairs(hostile, 100_000)
  assert.ok(result.pairs.length <= 5000, "the parse bound must cap examined entries")
  assert.equal(result.truncated, true)
})

// ===== chunkBlockRanges =====

test("a single-block chain yields one single-block range", () => {
  assert.deepEqual(chunkBlockRanges(0, 2_000_000), [{ fromBlock: 0, toBlock: 0 }])
})

test("ranges tile the chain exactly, with no gaps or overlaps", () => {
  const ranges = chunkBlockRanges(4_999_999, 2_000_000)
  assert.deepEqual(ranges, [
    { fromBlock: 0, toBlock: 1_999_999 },
    { fromBlock: 2_000_000, toBlock: 3_999_999 },
    { fromBlock: 4_000_000, toBlock: 4_999_999 },
  ])

  let previous = -1
  for (const range of ranges) {
    assert.equal(range.fromBlock, previous + 1)
    assert.ok(range.toBlock >= range.fromBlock)
    previous = range.toBlock
  }
  assert.equal(previous, 4_999_999)
})

test("an exact multiple of the chunk size ends exactly at the tip", () => {
  const ranges = chunkBlockRanges(3_999_999, 2_000_000)
  assert.equal(ranges.length, 2)
  assert.equal(ranges[1].toBlock, 3_999_999)
})

test("invalid tips and chunk sizes yield no ranges", () => {
  for (const latestBlock of [-1, -1_000_000, 1.5]) {
    assert.deepEqual(chunkBlockRanges(latestBlock, 2_000_000), [])
  }
  for (const chunkSize of [0, -1, 2.5]) {
    assert.deepEqual(chunkBlockRanges(100, chunkSize), [])
  }
})

test("a hostile tip with a tiny chunk cannot exhaust memory", () => {
  const ranges = chunkBlockRanges(50_000, 1)
  assert.ok(ranges.length < 50_000, "the range count must be bounded")
  assert.ok(ranges.length >= 1)
  assert.deepEqual(ranges[0], { fromBlock: 0, toBlock: 0 })
})

// ===== needsSplitting =====

test("a page at or above the cap must be split", () => {
  assert.equal(needsSplitting(LOG_PAGE_CAP, LOG_PAGE_CAP), true)
  assert.equal(needsSplitting(LOG_PAGE_CAP + 1, LOG_PAGE_CAP), true)
})

test("a page below the cap is complete", () => {
  assert.equal(needsSplitting(LOG_PAGE_CAP - 1, LOG_PAGE_CAP), false)
  assert.equal(needsSplitting(0, LOG_PAGE_CAP), false)
})

test("a non-positive or fractional cap never requests splitting", () => {
  for (const cap of [0, -1, 10.5]) {
    assert.equal(needsSplitting(1000, cap), false)
  }
})

test("a non-integer log count never requests splitting", () => {
  assert.equal(needsSplitting(1000.5, 1000), false)
})

// ===== splitBlockRange =====

test("an even-sized range splits into equal halves", () => {
  assert.deepEqual(splitBlockRange({ fromBlock: 0, toBlock: 9 }), [
    { fromBlock: 0, toBlock: 4 },
    { fromBlock: 5, toBlock: 9 },
  ])
})

test("an odd-sized range splits with the smaller half first", () => {
  assert.deepEqual(splitBlockRange({ fromBlock: 0, toBlock: 8 }), [
    { fromBlock: 0, toBlock: 3 },
    { fromBlock: 4, toBlock: 8 },
  ])
})

test("a two-block range splits into single blocks", () => {
  assert.deepEqual(splitBlockRange({ fromBlock: 5, toBlock: 6 }), [
    { fromBlock: 5, toBlock: 5 },
    { fromBlock: 6, toBlock: 6 },
  ])
})

test("a single-block range cannot be split", () => {
  assert.equal(splitBlockRange({ fromBlock: 5, toBlock: 5 }), null)
})

test("a malformed range cannot be split", () => {
  assert.equal(splitBlockRange({ fromBlock: 10, toBlock: 5 }), null)
  assert.equal(splitBlockRange({ fromBlock: 1.5, toBlock: 5 }), null)
  assert.equal(splitBlockRange({ fromBlock: -1, toBlock: 5 }), null)
})

test("halves always cover the input exactly", () => {
  for (const [from, to] of [
    [0, 1],
    [3, 102],
    [1_999_999, 2_000_003],
  ]) {
    const halves = splitBlockRange({ fromBlock: from, toBlock: to })
    assert.notEqual(halves, null)
    if (halves === null) continue
    assert.equal(halves[0].fromBlock, from)
    assert.equal(halves[1].toBlock, to)
    assert.equal(halves[0].toBlock + 1, halves[1].fromBlock)
  }
})

// ===== isUnlimitedAllowance =====

test("values below 2^128 are not unlimited", () => {
  assert.equal(isUnlimitedAllowance(0n), false)
  assert.equal(isUnlimitedAllowance(1n), false)
  assert.equal(isUnlimitedAllowance(10n ** 38n), false) // just under 2^128
  assert.equal(isUnlimitedAllowance(2n ** 128n - 1n), false)
})

test("2^128 and above are unlimited, including max uint256", () => {
  assert.equal(isUnlimitedAllowance(2n ** 128n), true)
  assert.equal(isUnlimitedAllowance(2n ** 160n), true) // the USDT-style "unlimited" value
  assert.equal(isUnlimitedAllowance(2n ** 256n - 1n), true)
})

// ===== decodeAllowanceResult =====

test("a 32-byte hex result decodes to the exact bigint", () => {
  assert.equal(decodeAllowanceResult(`0x${"00".repeat(31)}01`), 1n)
  assert.equal(decodeAllowanceResult(dataHex(10n ** 18n)), 10n ** 18n)
  assert.equal(decodeAllowanceResult(`0x${"f".repeat(64)}`), 2n ** 256n - 1n)
})

test("an all-zero result is a valid zero, not an error", () => {
  assert.equal(decodeAllowanceResult(`0x${"00".repeat(32)}`), 0n)
})

test("uppercase hex digits decode", () => {
  assert.equal(decodeAllowanceResult(`0x${"FF".repeat(32)}`), 2n ** 256n - 1n)
})

test("garbage results decode to null, never to a guessed value", () => {
  const garbage = [
    "0x", // empty
    `0x${"0".repeat(63)}`, // one nibble short
    `0x${"0".repeat(65)}`, // one nibble long
    "nope",
    "1234", // no 0x prefix
    "0X" + "0".repeat(64), // wrong prefix case
    "",
    42,
    null,
    undefined,
    {},
    [],
    true,
  ]
  for (const value of garbage) {
    assert.equal(decodeAllowanceResult(value), null, `${String(value)} must not decode`)
  }
})

// ===== Policy constants =====

test("the pagination policy constants match the measured explorer behaviour", () => {
  // The live-measured page cap and the spec's safety bounds; pinning them here
  // means a change is a conscious decision, not a drift.
  assert.equal(LOG_PAGE_CAP, 1000)
  assert.equal(MAX_LOGS_PER_NETWORK, 3000)
  assert.equal(CHUNK_BLOCK_SIZE, 2_000_000)
  assert.ok(
    MAX_LOGS_PER_NETWORK > LOG_PAGE_CAP,
    "the collected-log cap must exceed a single page"
  )
})
