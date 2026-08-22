"use client"

/**
 * Loading, empty, and error state placeholders.
 *
 * These three states are visually distinct on purpose. Collapsing them — showing
 * a blank area or a literal "0" for all of them — is what makes an unloaded
 * balance indistinguishable from an empty account.
 */

import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SpinnerProps {
  /** Announced while busy. */
  label?: string
  className?: string
  size?: "sm" | "md" | "lg"
}

const SPINNER_SIZE: Record<NonNullable<SpinnerProps["size"]>, string> = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
}

/** Centred busy indicator. */
export function Spinner({ label = "Loading…", className, size = "md" }: SpinnerProps) {
  return (
    <div role="status" className={cn("flex items-center justify-center gap-2 py-6", className)}>
      <Loader2 className={cn("animate-spin text-primary", SPINNER_SIZE[size])} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  )
}

export interface EmptyStateProps {
  /** What is missing. */
  title: string
  /** How to populate it. */
  description?: string
  /** Optional call to action. */
  action?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}

/** Placeholder for a genuinely empty collection. */
export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-4 py-10 text-center", className)}>
      {icon && (
        <span
          className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <div className="space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export interface ErrorStateProps {
  /** What failed, in plain language. */
  title: string
  /** Detail, ideally including what the user can do next. */
  description?: string
  /** Retry affordance. */
  action?: React.ReactNode
  className?: string
}

/**
 * Placeholder for a failed load.
 *
 * Announced assertively, because a silent failure leaves the user staring at an
 * empty panel with no idea whether to wait.
 */
export function ErrorState({ title, description, action, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-8 text-center",
        className
      )}
    >
      <div className="space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
