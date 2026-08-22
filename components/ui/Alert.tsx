"use client"

/**
 * Inline status message.
 *
 * Errors and warnings use `role="alert"` so assistive technology announces them
 * immediately; informational and success tones use a polite live region so they
 * do not interrupt whatever the user is doing.
 */

import { cva, type VariantProps } from "class-variance-authority"
import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from "lucide-react"
import { cn } from "@/lib/utils"

const alertVariants = cva("flex gap-3 rounded-lg border p-3 text-sm", {
  variants: {
    tone: {
      // Tinted background with a full-strength foreground keeps these readable
      // in both themes without a second set of per-theme classes.
      info: "border-info/30 bg-info/10 text-foreground [&>svg]:text-info",
      success: "border-success/30 bg-success/10 text-foreground [&>svg]:text-success",
      warning: "border-warning/35 bg-warning/10 text-foreground [&>svg]:text-warning",
      danger:
        "border-destructive/35 bg-destructive/10 text-foreground [&>svg]:text-destructive",
    },
  },
  defaultVariants: { tone: "info" },
})

export type AlertTone = NonNullable<VariantProps<typeof alertVariants>["tone"]>

export interface AlertProps extends VariantProps<typeof alertVariants> {
  tone: AlertTone
  /** Optional bold lead-in sentence. */
  title?: string
  children?: React.ReactNode
  className?: string
}

const ICON: Record<AlertTone, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: ShieldAlert,
}

export default function Alert({ tone, title, children, className }: AlertProps) {
  const Icon = ICON[tone]
  const assertive = tone === "danger" || tone === "warning"

  return (
    <div
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      className={cn(alertVariants({ tone }), className)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
    </div>
  )
}
