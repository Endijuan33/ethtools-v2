"use client"

/**
 * Labelled form field.
 *
 * Generates an id and wires `htmlFor`, `aria-describedby`, and `aria-invalid`
 * automatically. Only 2 of 16 labels in the original codebase were associated
 * with their control, so screen readers announced most inputs as unlabelled;
 * routing fields through this component makes that impossible to get wrong.
 */

import { useId } from "react"
import { cn } from "@/lib/utils"

export interface FieldProps {
  label: string
  /** Helper text under the control, linked via `aria-describedby`. */
  hint?: string
  /** Error text. Sets `aria-invalid` and is announced immediately. */
  error?: string
  required?: boolean
  /** Visually hide the label while keeping it available to assistive tech. */
  hideLabel?: boolean
  /** Optional control rendered on the label row, e.g. a unit switch. */
  action?: React.ReactNode
  className?: string
  /** Receives the generated ids to spread onto the control. */
  children: (props: {
    id: string
    "aria-describedby": string | undefined
    "aria-invalid": boolean | undefined
    "aria-required": boolean | undefined
  }) => React.ReactNode
}

export default function Field({
  label,
  hint,
  error,
  required = false,
  hideLabel = false,
  action,
  className,
  children,
}: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ")

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={id}
          className={cn(
            "block text-sm font-medium text-foreground",
            hideLabel && "sr-only"
          )}
        >
          {label}
          {required && (
            <span className="ml-1 text-destructive" aria-hidden="true">
              *
            </span>
          )}
          {required && <span className="sr-only"> (required)</span>}
        </label>
        {action}
      </div>

      {children({
        id,
        "aria-describedby": describedBy === "" ? undefined : describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}

      {hint && !error && (
        <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * Shared control styling.
 *
 * `text-base sm:text-sm` is deliberate: iOS Safari zooms the page when a focused
 * input has a font size below 16px.
 */
export const inputClassName = cn(
  "w-full min-h-[44px] rounded-lg border border-input bg-background/60 px-3 py-2",
  "text-base text-foreground placeholder:text-muted-foreground sm:text-sm",
  "transition-colors hover:border-input/80",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  "aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive",
  "disabled:cursor-not-allowed disabled:opacity-60"
)

/** Monospace variant for hex, paths, and calldata. */
export const monoInputClassName = cn(inputClassName, "font-mono text-sm")

/**
 * Attributes required on any control that receives a mnemonic or private key.
 *
 * Without these, mobile keyboards and browser spell-checkers can transmit typed
 * words to third-party prediction services, and autocapitalisation silently
 * corrupts BIP-39 words. None of these attributes appeared anywhere in the
 * original codebase.
 */
export const secretInputProps = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-lpignore": "true",
  "data-1p-ignore": "true",
} as const
