"use client"

/**
 * Segmented tab control.
 *
 * The app previously had three separate hand-rolled tab strips, none of which
 * were keyboard navigable: they were plain buttons with `aria-selected`, so arrow
 * keys did nothing and every tab was a separate stop in the tab order.
 *
 * This implements the WAI-ARIA tabs pattern properly:
 * - a roving tabindex, so the whole strip is a single stop in the tab order
 * - Arrow keys move between tabs and wrap at the ends
 * - Home and End jump to the first and last tab
 * - the animated indicator is driven by Framer Motion `layoutId`, and is skipped
 *   entirely when the user prefers reduced motion
 */

import { useRef } from "react"
import { motion, useReducedMotion } from "framer-motion"
import { cn } from "@/lib/utils"

export interface TabItem<T extends string> {
  id: T
  label: string
  /** Optional leading icon. Hidden from assistive technology. */
  icon?: React.ComponentType<{ className?: string }>
  /** Optional trailing count or status. */
  badge?: React.ReactNode
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[]
  value: T
  onChange: (id: T) => void
  /** Accessible name for the tab strip. */
  label: string
  /** Distinguishes the animated indicator when several strips are mounted. */
  layoutGroupId?: string
  className?: string
  /** Stretch tabs to fill the available width. */
  stretch?: boolean
}

export default function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  layoutGroupId = "tabs",
  className,
  stretch = true,
}: TabsProps<T>) {
  const reduceMotion = useReducedMotion()
  const refs = useRef<Map<T, HTMLButtonElement>>(new Map())

  const focusTab = (id: T): void => {
    onChange(id)
    // Move focus with selection so the roving tabindex stays consistent.
    refs.current.get(id)?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    const index = items.findIndex((item) => item.id === value)
    if (index === -1) return

    let next = index
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % items.length
        break
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + items.length) % items.length
        break
      case "Home":
        next = 0
        break
      case "End":
        next = items.length - 1
        break
      default:
        return
    }

    event.preventDefault()
    focusTab(items[next].id)
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex gap-1 rounded-xl border border-border/60 bg-muted/40 p-1",
        className
      )}
    >
      {items.map(({ id, label: tabLabel, icon: Icon, badge }) => {
        const selected = id === value
        return (
          <button
            key={id}
            ref={(node) => {
              if (node) refs.current.set(id, node)
              else refs.current.delete(id)
            }}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={selected}
            aria-controls={`panel-${id}`}
            // Roving tabindex: only the active tab is reachable via Tab.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            className={cn(
              "relative flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg px-3",
              "text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              stretch && "flex-1",
              selected ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {selected && !reduceMotion && (
              <motion.span
                layoutId={`${layoutGroupId}-indicator`}
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
                className="absolute inset-0 rounded-lg bg-gradient-to-b from-primary to-primary/90 shadow-glow-sm"
                aria-hidden="true"
              />
            )}
            {selected && reduceMotion && (
              <span className="absolute inset-0 rounded-lg bg-primary" aria-hidden="true" />
            )}

            <span className="relative flex items-center gap-1.5">
              {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
              {tabLabel}
              {badge}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Panel paired with a {@link Tabs} strip.
 *
 * `tabIndex={0}` makes the panel focusable so keyboard users can Tab from the
 * strip straight into its content.
 */
export function TabPanel({
  id,
  children,
  className,
}: {
  id: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      tabIndex={0}
      className={cn("focus-visible:outline-none", className)}
    >
      {children}
    </div>
  )
}
