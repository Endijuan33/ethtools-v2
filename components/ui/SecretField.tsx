"use client"

/**
 * Reveal-on-demand display for a private key or recovery phrase.
 *
 * The critical property: while hidden, the secret is **not rendered at all**. The
 * original implementation always placed the plaintext key in the DOM and applied
 * a `blur-sm` class, so the key stayed readable via DevTools, with CSS disabled,
 * through select-all-and-copy, to screen readers, and to any extension reading
 * the DOM. A CSS filter is a visual effect, not an access control.
 *
 * The countdown is visible rather than silent, so a revealed secret never hides
 * unexpectedly mid-transcription.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Eye, EyeOff, ShieldAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import CopyButton from "./CopyButton"
import { confirmAction } from "./Toast"

export interface SecretFieldProps {
  label: string
  /** The secret. Only enters the DOM while revealed. */
  value: string
  /** Allow copying to the system clipboard. */
  allowCopy?: boolean
  /** Require confirmation before revealing. Defaults to true. */
  warnOnReveal?: boolean
  /** Auto-hide after this many milliseconds. 0 disables. */
  autoHideMs?: number
  /** `phrase` renders a numbered word grid, for recovery phrases. */
  variant?: "text" | "phrase"
  className?: string
}

/** Fixed-length placeholder, so the mask leaks nothing about the value. */
const MASK = "•".repeat(44)

export default function SecretField({
  label,
  value,
  allowCopy = false,
  warnOnReveal = true,
  autoHideMs = 60_000,
  variant = "text",
  className,
}: SecretFieldProps) {
  const [revealed, setRevealed] = useState(false)
  const [remaining, setRemaining] = useState(0)
  const interval = useRef<ReturnType<typeof setInterval> | null>(null)

  const hide = useCallback(() => {
    setRevealed(false)
    setRemaining(0)
  }, [])

  // Re-hide whenever the secret itself changes, so switching accounts never
  // exposes the next secret just because the previous one was revealed.
  useEffect(() => {
    hide()
  }, [value, hide])

  // Visible countdown while revealed.
  useEffect(() => {
    if (interval.current) clearInterval(interval.current)
    if (!revealed || autoHideMs <= 0) return

    setRemaining(Math.ceil(autoHideMs / 1000))
    interval.current = setInterval(() => {
      setRemaining((seconds) => {
        if (seconds <= 1) {
          hide()
          return 0
        }
        return seconds - 1
      })
    }, 1000)

    return () => {
      if (interval.current) clearInterval(interval.current)
    }
  }, [revealed, autoHideMs, hide])

  const toggle = useCallback(async () => {
    if (revealed) {
      hide()
      return
    }
    if (warnOnReveal) {
      const confirmed = await confirmAction({
        message: `Reveal ${label.toLowerCase()}?`,
        description:
          "This displays sensitive information on screen. Check that nobody can see your display and that you are not sharing or recording your screen.",
        confirmLabel: "Reveal",
      })
      if (!confirmed) return
    }
    setRevealed(true)
  }, [hide, label, revealed, warnOnReveal])

  const words = revealed && variant === "phrase" ? value.trim().split(/\s+/) : []

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {revealed && autoHideMs > 0 && (
            <span
              className="mr-1 font-mono text-xs tabular-nums text-muted-foreground"
              aria-hidden="true"
            >
              {remaining}s
            </span>
          )}
          {allowCopy && revealed && (
            <CopyButton
              value={value}
              label={label.toLowerCase()}
              confirmMessage="The system clipboard is readable by other applications and is often synced across devices and kept in clipboard history."
            />
          )}
          <button
            type="button"
            onClick={toggle}
            aria-pressed={revealed}
            aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {revealed ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {revealed ? (
        variant === "phrase" ? (
          <ol className="grid grid-cols-2 gap-1.5 rounded-lg border border-warning/30 bg-warning/5 p-3 sm:grid-cols-3">
            {words.map((word, index) => (
              <li
                key={`${index}-${word}`}
                className="flex items-baseline gap-1.5 font-mono text-sm text-foreground"
              >
                <span className="w-5 shrink-0 select-none text-right text-xs text-muted-foreground">
                  {index + 1}
                </span>
                {word}
              </li>
            ))}
          </ol>
        ) : (
          <p className="break-all rounded-lg border border-warning/30 bg-warning/5 p-3 font-mono text-sm text-foreground">
            {value}
          </p>
        )
      ) : (
        <p
          aria-hidden="true"
          className="select-none overflow-hidden rounded-lg border border-border bg-muted/50 p-3 font-mono text-sm leading-6 text-muted-foreground/50"
        >
          {MASK}
        </p>
      )}

      {revealed ? (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Visible on screen
          {autoHideMs > 0 && " — hides automatically"}
        </p>
      ) : (
        <p className="sr-only">{label} is hidden. Use the reveal button to display it.</p>
      )}
    </div>
  )
}
