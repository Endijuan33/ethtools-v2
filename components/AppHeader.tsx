"use client"

/**
 * Application header.
 *
 * Sticky, frosted, and the permanent home of three things:
 * - identity (so the user can confirm they are on the right app)
 * - the trust indicator, which states the security posture without nagging
 * - the theme control
 *
 * The trust indicator is the "quiet" half of the security UX: a persistent,
 * low-key statement of fact. Loud warnings are reserved for the moment of actual
 * risk — revealing a secret, exporting a backup, sending funds — because a banner
 * that is always shouting gets tuned out, which is exactly when it stops working.
 */

import { Lock } from "lucide-react"
import Badge from "./ui/Badge"
import BrandMark from "./BrandMark"
import ThemeToggle from "./ui/ThemeToggle"

export interface AppHeaderProps {
  /** Rendered on the right, before the theme control. */
  actions?: React.ReactNode
  /** Shows a locked indicator when the vault exists but is not unlocked. */
  isLocked?: boolean
}

export default function AppHeader({ actions, isLocked }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 surface-glass">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        {/* Identity */}
        <a
          href="/"
          className="flex min-w-0 items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandMark size={36} className="shrink-0 rounded-xl shadow-glow-sm" />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold leading-tight tracking-tight">
              EthTools
            </span>
            <span className="hidden text-xs leading-tight text-muted-foreground sm:block">
              Ethereum wallet utility
            </span>
          </span>
        </a>

        <div className="ml-auto flex items-center gap-2">
          {/* Quiet, always-present statement of the security model. */}
          <Badge tone="success" dot className="hidden sm:inline-flex">
            Local only
          </Badge>

          {isLocked && (
            <Badge tone="neutral">
              <Lock className="h-3 w-3" aria-hidden="true" />
              Locked
            </Badge>
          )}

          {actions}
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
