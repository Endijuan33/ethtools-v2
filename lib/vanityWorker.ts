/**
 * Web Worker entry for the vanity address search.
 *
 * Runs in a dedicated worker so the search can churn at full speed without
 * freezing the UI. The loop generates one bounded batch per tick
 * (`BATCH_SIZE` keys) and then yields via `setTimeout(0)`, posting a progress
 * message each tick; that keeps the attempts counter in the UI live while
 * still leaving this worker's event loop free between batches.
 *
 * There is deliberately no "stop" command: `Worker#terminate()` from the UI is
 * the only stop that is guaranteed instant, and the UI owns this worker's
 * lifecycle — it terminates on stop, on unmount, and as soon as a hit is
 * delivered. A worker therefore serves exactly one search.
 *
 * `self` is structurally typed below instead of using the `webworker` lib
 * because the project compiles with the DOM lib, whose `self: Window`
 * declaration conflicts with the worker scope's; the structural cast gives
 * exactly the two members this file uses, and nothing else.
 */

import { runVanityBatch, type VanityWorkerCommand, type VanityWorkerMessage } from "./vanityEngine"

/**
 * Keys per postMessage tick. At browser generation speeds this is tens of
 * milliseconds of work — enough to keep the counter moving smoothly without
 * flooding React with updates.
 */
const BATCH_SIZE = 250

/** Minimal dedicated-worker scope, structurally declared (see module note). */
interface WorkerScope {
  postMessage(message: VanityWorkerMessage): void
  onmessage: ((event: MessageEvent<VanityWorkerCommand>) => void) | null
}

const ctx = self as unknown as WorkerScope

/** Whether a search is in flight; a worker serves exactly one search. */
let searching = false

ctx.onmessage = (event: MessageEvent<VanityWorkerCommand>): void => {
  const command = event.data
  if (command?.type !== "start" || searching) return

  searching = true
  const pattern = command.pattern
  let attempts = 0

  const step = (): void => {
    const batch = runVanityBatch(pattern, BATCH_SIZE)
    attempts += batch.attempts

    if (batch.hit) {
      searching = false
      ctx.postMessage({
        type: "found",
        attempts,
        address: batch.hit.address,
        privateKey: batch.hit.privateKey,
      })
      return
    }

    ctx.postMessage({ type: "progress", attempts })
    setTimeout(step, 0)
  }

  step()
}
