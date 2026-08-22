"use client"

/**
 * Status badge.
 *
 * Every tone pairs a colour with a text label, and the optional dot carries an
 * accessible name. Colour alone must never be the only signal — the previous RPC
 * health indicator was a bare green or red circle, which conveys nothing to a
 * colourblind user and nothing at all in a screenshot.
 */

import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        primary: "border-primary/30 bg-primary/15 text-primary",
        success: "border-success/30 bg-success/15 text-success",
        warning: "border-warning/35 bg-warning/15 text-warning",
        danger: "border-destructive/35 bg-destructive/15 text-destructive",
        info: "border-info/30 bg-info/15 text-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
)

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: React.ReactNode
  /** Render a leading status dot. */
  dot?: boolean
  /** Animate the dot, for genuinely in-progress states only. */
  pulse?: boolean
  className?: string
}

export default function Badge({ tone, children, dot = false, pulse = false, className }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)}>
      {dot && (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          {pulse && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          )}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {children}
    </span>
  )
}

export { badgeVariants }
