"use client"

/**
 * Skeleton placeholders.
 *
 * Used while data is genuinely in flight. The important property is that a
 * skeleton is visually distinct from a real zero: rendering "0.00000" for a
 * balance that has not loaded is indistinguishable from an empty account, which
 * is alarming in a wallet.
 *
 * The whole group is wrapped in one `role="status"` so a screen reader hears
 * "Loading balances" once, not once per placeholder row.
 */

import { cn } from "@/lib/utils"

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Render as a circle, for avatars and status dots. */
  circle?: boolean
}

/** A single shimmering placeholder block. */
export function Skeleton({ className, circle = false, ...rest }: SkeletonProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-muted/70",
        circle ? "rounded-full" : "rounded-md",
        className
      )}
      {...rest}
    >
      {/* Sweep is decorative; reduced-motion callers get a static block via the
          global media query in globals.css. */}
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />
    </div>
  )
}

export interface SkeletonGroupProps {
  /** Announced once while the group is visible. */
  label: string
  children: React.ReactNode
  className?: string
}

/** Wraps several skeletons in a single polite live region. */
export function SkeletonGroup({ label, children, className }: SkeletonGroupProps) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

/** Placeholder shaped like a network balance row. */
export function SkeletonRow() {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 p-3">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Skeleton circle className="h-2 w-2" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <Skeleton className="h-8 w-16 rounded-lg" />
    </div>
  )
}

/** Several {@link SkeletonRow}s in one live region. */
export function SkeletonList({ rows = 4, label = "Loading…" }: { rows?: number; label?: string }) {
  return (
    <SkeletonGroup label={label} className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </SkeletonGroup>
  )
}

export default Skeleton
