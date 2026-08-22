"use client"

/**
 * Copy-to-clipboard button with honest feedback.
 *
 * The codebase had three different clipboard implementations: two never handled a
 * rejected promise, and one showed a success tick unconditionally, so a blocked
 * clipboard still reported success. This reports the real outcome, announces it,
 * and routes confirmation for secrets through a themed toast rather than
 * `window.confirm`.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Copy, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { confirmAction, notify } from "./Toast"

type CopyState = "idle" | "copied" | "failed"

export interface CopyButtonProps {
  /** Text placed on the clipboard. */
  value: string
  /** What is being copied, e.g. "address". Used for the accessible name. */
  label: string
  /** When set, the user must confirm before the value reaches the clipboard. */
  confirmMessage?: string
  /** Show the label text beside the icon. */
  showText?: boolean
  className?: string
}

export default function CopyButton({
  value,
  label,
  confirmMessage,
  showText = false,
  className,
}: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const handleCopy = useCallback(async () => {
    if (confirmMessage) {
      const confirmed = await confirmAction({
        message: `Copy ${label}?`,
        description: confirmMessage,
        confirmLabel: "Copy",
      })
      if (!confirmed) return
    }

    try {
      // Requires a secure context; absent in some in-app WebViews.
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(value)
      setState("copied")
    } catch {
      setState("failed")
      notify.error("Could not copy", "Your browser blocked clipboard access. Select and copy manually.")
    }

    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState("idle"), 2000)
  }, [confirmMessage, label, value])

  const Icon = state === "copied" ? Check : state === "failed" ? X : Copy
  const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : `Copy ${label}`

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={text}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-lg p-2 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          state === "copied"
            ? "text-success"
            : state === "failed"
              ? "text-destructive"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground",
          className
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        {showText && <span className="text-xs font-medium">{text}</span>}
      </button>

      {/* Announce the outcome without moving focus. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? `${label} copied` : state === "failed" ? "Copy failed" : ""}
      </span>
    </>
  )
}
