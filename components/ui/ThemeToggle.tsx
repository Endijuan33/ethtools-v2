"use client"

/**
 * Theme switcher.
 *
 * `next-themes` was already a dependency but was never wired up: the app
 * hardcoded a dark palette, and the `ThemeProvider` wrapper component was never
 * imported by anything.
 *
 * Cycles light -> dark -> system. The button renders a neutral placeholder until
 * mounted, because the resolved theme is unknown during SSR and rendering the
 * wrong icon then swapping it causes a visible flash.
 */

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Monitor, Moon, Sun } from "lucide-react"
import { cn } from "@/lib/utils"

const ORDER = ["light", "dark", "system"] as const
type ThemeChoice = (typeof ORDER)[number]

const META: Record<ThemeChoice, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
  system: { label: "System", Icon: Monitor },
}

export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  if (!mounted) {
    // Reserve the exact footprint so the header does not shift on hydration.
    return <div className={cn("h-10 w-10", className)} aria-hidden="true" />
  }

  const current: ThemeChoice = ORDER.includes(theme as ThemeChoice)
    ? (theme as ThemeChoice)
    : "system"
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]
  const { Icon, label } = META[current]

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      // The name states the current value and what activating it will do, so a
      // screen reader user is not left guessing which way the toggle moves.
      aria-label={`Theme: ${label}. Switch to ${META[next].label.toLowerCase()}.`}
      title={`Theme: ${label}`}
      className={cn(
        "inline-flex h-10 w-10 items-center justify-center rounded-lg",
        "text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
  )
}
