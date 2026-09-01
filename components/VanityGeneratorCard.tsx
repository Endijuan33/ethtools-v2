"use client"

/**
 * Vanity address generator card.
 *
 * Mines uniformly random keys until one's address starts with a user-chosen
 * 1–4 character hex prefix. Generation is 100% client-side: entropy comes from
 * ethers' `randomBytes` (crypto.getRandomValues) inside a Web Worker, the
 * private key exists only in this component's state, is displayed only through
 * SecretField, and is wiped when a new search starts or the card unmounts.
 * Nothing is logged or persisted.
 *
 * The search runs in a dedicated worker (see lib/vanityWorker.ts) so it can
 * churn at full speed without freezing the UI. Where a Worker cannot be
 * constructed — or its chunk fails to load, which surfaces as an `error` event
 * before the first message rather than a thrown constructor — the same batch
 * primitive runs on the main thread in small setTimeout slices, so the
 * counter, live rate, and Stop button keep working everywhere.
 *
 * Honesty rules for the progress UI: no progress bar, because a geometric
 * search has no meaningful percentage. Attempts, rate, and an expected wait
 * derived from the live rate are the whole truth this panel can tell.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Pencil, RotateCcw, Search, Square } from "lucide-react"
import Card, { CardDescription, CardHeader, CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Badge, { type BadgeTone } from "./ui/Badge"
import Field, { monoInputClassName } from "./ui/Field"
import Alert from "./ui/Alert"
import CopyButton from "./ui/CopyButton"
import SecretField from "./ui/SecretField"
import { estimateVanityAttempts, formatAttemptCount, validateVanityPattern } from "@/lib/vanity"
import { runVanityBatch, type VanityWorkerMessage } from "@/lib/vanityEngine"

/**
 * Batch size for the main-thread fallback. Much smaller than the worker's
 * batch because it shares the UI thread: one slice must stay well under a
 * frame budget so clicks and paints still get through.
 */
const FALLBACK_BATCH_SIZE = 50

/** Elapsed-time refresh cadence; also paces the screen-reader announcement. */
const TICK_MS = 250

type SearchStatus = "idle" | "running" | "found" | "stopped"

/** A completed search. Contains a private key: treat as secret. */
interface FoundVanity {
  address: string
  privateKey: string
  attempts: number
  elapsedMs: number
}

/**
 * Tone for the odds badge. Colour is never the only signal — the badge text
 * always carries the exact odds — but the tone gives the shape of it at a
 * glance.
 */
function oddsTone(patternLength: number): BadgeTone {
  if (patternLength <= 2) return "success"
  if (patternLength === 3) return "info"
  return "warning"
}

/** mm:ss, or h:mm:ss once past an hour. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, "0")
  const ss = String(seconds).padStart(2, "0")
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`
}

/**
 * Plain-language expected wait, derived from the live key rate.
 *
 * Deliberately bucketed to seconds/minutes/hours: the search is a geometric
 * process, so quoting "8,412 seconds" would imply a precision it does not
 * have. The figure is an average, not a bound — a hit can take far longer.
 */
function describeWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  if (seconds < 1) return "under a second"
  if (seconds < 60) return `about ${Math.round(seconds)}s`
  if (seconds < 3600) return `about ${Math.max(1, Math.round(seconds / 60))}m`
  if (seconds < 172_800) return `about ${Math.round(seconds / 3600)}h`
  return "days"
}

export default function VanityGeneratorCard() {
  const [status, setStatus] = useState<SearchStatus>("idle")
  const [patternInput, setPatternInput] = useState("")
  /** Normalized pattern of the current or most recent run. */
  const [activePattern, setActivePattern] = useState("")
  const [attempts, setAttempts] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  /** Throttled mirror of `attempts` for the aria-live region (once per second). */
  const [liveAttempts, setLiveAttempts] = useState(0)
  const [result, setResult] = useState<FoundVanity | null>(null)
  const [error, setError] = useState("")

  /** Mirrors `attempts` for the loops, which must not re-read state. */
  const attemptsRef = useRef(0)
  /** Start timestamp of the current run; 0 when no run is in flight. */
  const startedAtRef = useRef(0)
  /**
   * Generation counter, bumped on every start, stop, finish, and unmount.
   * Messages and fallback slices from older runs compare it against the run
   * they were created for, so a stale worker or timer can never feed a dead
   * search — or deliver a second "found".
   */
  const runIdRef = useRef(0)
  const workerRef = useRef<Worker | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** Whole second last announced to screen readers. */
  const announcedSecondRef = useRef(-1)

  const running = status === "running"
  const isBlank = patternInput.trim() === ""
  const validation = useMemo(() => validateVanityPattern(patternInput), [patternInput])
  const fieldError = isBlank || validation.ok ? undefined : validation.error
  const canStart = !running && validation.ok

  // Live rate and expected wait are derived, never measured into state: the
  // numbers stay consistent with whatever the last message said.
  const ratePerSecond =
    elapsedMs >= 1000 && attempts > 0 ? attempts / (elapsedMs / 1000) : null
  const expectedAttempts = activePattern ? estimateVanityAttempts(activePattern) : 0
  const waitSeconds = ratePerSecond && expectedAttempts > 0 ? expectedAttempts / ratePerSecond : null

  /**
   * Kill every background task of the current run and mark it finished.
   *
   * Bumping the run id first means any message still in flight is ignored even
   * though it may still fire after terminate().
   */
  const settleRun = (next: "found" | "stopped") => {
    runIdRef.current += 1
    workerRef.current?.terminate()
    workerRef.current = null
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }
    if (tickerRef.current) {
      clearInterval(tickerRef.current)
      tickerRef.current = null
    }
    if (startedAtRef.current > 0) {
      setElapsedMs(Date.now() - startedAtRef.current)
      startedAtRef.current = 0
    }
    setStatus(next)
  }

  /** Wall-clock ticker for the elapsed display; also paces announcements. */
  const startTicker = () => {
    if (tickerRef.current) clearInterval(tickerRef.current)
    announcedSecondRef.current = -1
    tickerRef.current = setInterval(() => {
      if (startedAtRef.current === 0) return
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      const second = Math.floor(elapsed / 1000)
      if (second !== announcedSecondRef.current) {
        announcedSecondRef.current = second
        setLiveAttempts(attemptsRef.current)
      }
    }, TICK_MS)
  }

  /**
   * Main-thread fallback: the same batch primitive in small setTimeout slices.
   * Runs only where a Worker cannot. Each slice checks the run id, so Stop,
   * unmount, or a replacement run ends the chain without further work.
   */
  const runOnMainThread = (pattern: string, runId: number) => {
    const step = () => {
      if (runIdRef.current !== runId) return
      const batch = runVanityBatch(pattern, FALLBACK_BATCH_SIZE)
      attemptsRef.current += batch.attempts
      setAttempts(attemptsRef.current)

      if (batch.hit) {
        setResult({
          address: batch.hit.address,
          privateKey: batch.hit.privateKey,
          attempts: attemptsRef.current,
          elapsedMs: Date.now() - startedAtRef.current,
        })
        settleRun("found")
        return
      }
      fallbackTimerRef.current = setTimeout(step, 0)
    }
    fallbackTimerRef.current = setTimeout(step, 0)
  }

  const startRun = () => {
    if (running) return
    const validated = validateVanityPattern(patternInput)
    if (!validated.ok) {
      setError(validated.error)
      return
    }

    // Defensive cleanup: every settled run already terminated its worker, but
    // starting a search must never inherit background work regardless of how
    // the previous one ended.
    workerRef.current?.terminate()
    workerRef.current = null
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }

    // A new search never inherits the previous find: the old key leaves state
    // before the first batch of the new run executes.
    setResult(null)
    setError("")
    setActivePattern(validated.value)
    attemptsRef.current = 0
    setAttempts(0)
    setLiveAttempts(0)
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setStatus("running")

    const runId = ++runIdRef.current
    const pattern = validated.value
    startTicker()

    try {
      const worker = new Worker(new URL("../lib/vanityWorker.ts", import.meta.url))
      workerRef.current = worker

      // Whether the worker has proved it is alive. An error before the first
      // message means the chunk could not be loaded (CSP, strict WebView,
      // broken cache) — that is the fallback case, not a search failure.
      let workerAlive = false

      worker.onmessage = (event: MessageEvent<VanityWorkerMessage>) => {
        if (runIdRef.current !== runId) return
        workerAlive = true
        const message = event.data
        // The worker reports cumulative attempts, so these are assignments.
        attemptsRef.current = message.attempts
        setAttempts(message.attempts)
        if (message.type === "found") {
          setResult({
            address: message.address,
            privateKey: message.privateKey,
            attempts: message.attempts,
            elapsedMs: Date.now() - startedAtRef.current,
          })
          settleRun("found")
        }
      }

      worker.onerror = () => {
        if (runIdRef.current !== runId) return
        worker.terminate()
        workerRef.current = null
        if (workerAlive) {
          // It ran and then died mid-search; retrying is the honest advice.
          settleRun("stopped")
          setError("The generator stopped unexpectedly. Start the search again.")
        } else {
          runOnMainThread(pattern, runId)
        }
      }

      worker.postMessage({ type: "start", pattern })
    } catch {
      // Worker construction is unsupported in this environment.
      runOnMainThread(pattern, runId)
    }
  }

  const stopRun = () => {
    // terminate() is synchronous: the worker dies before this handler returns,
    // so Stop is instant no matter how deep in a batch the worker is.
    settleRun("stopped")
  }

  const backToIdle = () => {
    // Leaving the result view must clear the key from state.
    setResult(null)
    setStatus("idle")
    setAttempts(0)
    setLiveAttempts(0)
    setElapsedMs(0)
    setActivePattern("")
  }

  useEffect(() => {
    return () => {
      /*
       * Leaving the section mid-search must not leave an orphaned worker
       * mining keys — and holding a found key — in the background. terminate()
       * is synchronous and drops anything still in flight; the private key in
       * state dies with the component.
       */
      runIdRef.current += 1
      workerRef.current?.terminate()
      workerRef.current = null
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
      if (tickerRef.current) clearInterval(tickerRef.current)
    }
  }, [])

  const oddsBadge =
    validation.ok && !isBlank ? (
      <Badge tone={oddsTone(validation.value.length)}>
        1 in {formatAttemptCount(estimateVanityAttempts(validation.value))}
      </Badge>
    ) : undefined

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Vanity address generator</CardTitle>
        <CardDescription>
          Mine a random address that starts with characters you choose. Runs entirely in this
          browser.
        </CardDescription>
      </CardHeader>

      <div className="space-y-4">
        <Alert tone="warning" title="Your keys never leave this browser">
          Generation happens locally and nothing is transmitted. Even so, avoid generating keys
          you plan to fund on a shared or public device.
        </Alert>

        {status === "found" && result ? (
          <div className="space-y-4">
            <Alert tone="success" title="Match found">
              An address starting 0x{activePattern} appeared after{" "}
              {formatAttemptCount(result.attempts)} keys in {formatElapsed(result.elapsedMs)}.
            </Alert>

            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">Address</p>
              <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/40 p-3">
                <p className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">
                  <span className="text-muted-foreground">0x</span>
                  <span className="font-semibold text-primary">
                    {result.address.slice(2, 2 + activePattern.length)}
                  </span>
                  {result.address.slice(2 + activePattern.length)}
                </p>
                <CopyButton value={result.address} label="address" />
              </div>
              <p className="text-xs text-muted-foreground">
                Highlighted: the 0x{activePattern} prefix this search asked for. The remaining
                characters are just as important — see the note below.
              </p>
            </div>

            <SecretField label="Private Key" value={result.privateKey} variant="text" allowCopy />

            <Alert tone="warning" title="This key needs a home">
              It exists only in this panel right now. Import it into the vault — where it is
              encrypted in this browser — or write it down offline. EthTools stores nothing, and
              starting another search or leaving this section wipes the key.
            </Alert>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                fullWidth
                onClick={startRun}
                disabled={!canStart}
                icon={<RotateCcw size={16} aria-hidden="true" />}
              >
                Search again
              </Button>
              <Button
                fullWidth
                variant="secondary"
                onClick={backToIdle}
                icon={<Pencil size={16} aria-hidden="true" />}
              >
                Change prefix
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Field
              label="Address prefix"
              error={fieldError}
              action={oddsBadge}
              hint="1–4 hex characters (0-9 and a-f). The 0x is optional and case is ignored."
            >
              {(field) => (
                <input
                  {...field}
                  type="text"
                  value={patternInput}
                  onChange={(event) => setPatternInput(event.target.value)}
                  // The pattern of a run cannot change mid-search; the field
                  // stays visible (disabled) so the target remains in view.
                  disabled={running}
                  placeholder="0xdead"
                  className={monoInputClassName}
                />
              )}
            </Field>

            {status === "idle" && validation.ok && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                About {formatAttemptCount(estimateVanityAttempts(validation.value))} keys on
                average before an address starting 0x{validation.value} appears.
              </p>
            )}

            {(running || status === "stopped") && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    {running ? (
                      <Badge tone="primary" dot pulse>
                        Searching
                      </Badge>
                    ) : (
                      <Badge tone="neutral" dot>
                        Stopped
                      </Badge>
                    )}
                    <span className="font-mono text-xs text-muted-foreground">
                      0x{activePattern}…
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    expected ≈ {formatAttemptCount(expectedAttempts)} keys
                  </span>
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-border/50 bg-muted/30 p-3 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">Keys checked</dt>
                    <dd className="mt-0.5 font-mono text-sm tabular-nums text-foreground">
                      {formatAttemptCount(attempts)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Rate</dt>
                    <dd className="mt-0.5 font-mono text-sm tabular-nums text-foreground">
                      {ratePerSecond ? `${formatAttemptCount(Math.round(ratePerSecond))}/s` : "…"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Elapsed</dt>
                    <dd className="mt-0.5 font-mono text-sm tabular-nums text-foreground">
                      {formatElapsed(elapsedMs)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Expected wait</dt>
                    <dd className="mt-0.5 text-sm text-foreground">
                      {running ? (waitSeconds ? `${describeWait(waitSeconds)} at this rate` : "…") : "—"}
                    </dd>
                  </div>
                </dl>

                {running && waitSeconds !== null && waitSeconds >= 3600 && (
                  <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    At this rate a match could take{" "}
                    {describeWait(waitSeconds).replace("about ", "")} — consider a shorter prefix.
                  </p>
                )}
              </div>
            )}

            {running ? (
              <Button
                variant="secondary"
                fullWidth
                onClick={stopRun}
                icon={<Square size={16} aria-hidden="true" />}
              >
                Stop
              </Button>
            ) : (
              <Button
                fullWidth
                onClick={startRun}
                disabled={!canStart}
                icon={<Search size={16} aria-hidden="true" />}
              >
                Start search
              </Button>
            )}

            {error && <Alert tone="danger">{error}</Alert>}
          </>
        )}

        {/* Announced politely: enough to follow the search without flooding
            the user; the visual counter updates far more often than this. */}
        <p role="status" aria-live="polite" className="sr-only">
          {running
            ? liveAttempts > 0
              ? `Searching… ${formatAttemptCount(liveAttempts)} keys checked.`
              : "Searching for a matching address."
            : status === "found" && result
              ? `Match found after ${formatAttemptCount(result.attempts)} keys.`
              : status === "stopped"
                ? `Search stopped after ${formatAttemptCount(attempts)} keys.`
                : ""}
        </p>

        <Alert tone="warning" title="Never trust a prefix">
          Vanity search is safe, but a look-alike address proves nothing: anyone can generate an
          address that starts with the same characters. Before sending funds, verify every
          character of the full address — not just the part you recognize.
        </Alert>
      </div>
    </Card>
  )
}
