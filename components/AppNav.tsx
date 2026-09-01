"use client"

/**
 * Section navigation.
 *
 * Two presentations of the same list:
 * - `SidebarNav`: the desktop rail. Sticky, with the section description under
 *   each label, and an animated active pill shared across items via a Framer
 *   Motion `layoutId` so the selection appears to physically slide.
 * - `MobileTabBar`: a fixed glass bar in the thumb zone, replacing the old
 *   horizontal scroller, which sat under the header where thumbs do not reach
 *   and clipped its last item.
 *
 * Both preserve the shell's navigation contract: plain buttons with
 * `aria-current="page"`, one `nav` landmark each, and no animation at all when
 * the user prefers reduced motion.
 */

import { motion, useReducedMotion } from "framer-motion"
import { cn } from "@/lib/utils"

export interface NavEntry<T extends string> {
  id: T
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
}

export interface AppNavProps<T extends string> {
  items: readonly NavEntry<T>[]
  value: T
  onChange: (id: T) => void
}

const SPRING = { type: "spring", stiffness: 400, damping: 34 } as const

export function SidebarNav<T extends string>({ items, value, onChange }: AppNavProps<T>) {
  const reduceMotion = useReducedMotion()

  return (
    <nav aria-label="Sections">
      <ul className="flex flex-col gap-1">
        {items.map(({ id, label, description, icon: Icon }) => {
          const selected = id === value
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onChange(id)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "group relative flex w-full min-h-[48px] items-center gap-3 rounded-xl px-3 py-2.5 text-left",
                  "transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !selected && "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
                )}
              >
                {selected && !reduceMotion && (
                  <motion.span
                    layoutId="sidebar-nav-active"
                    transition={SPRING}
                    className="absolute inset-0 rounded-xl border border-primary/25 bg-gradient-to-r from-primary/15 to-info/10"
                    aria-hidden="true"
                  />
                )}
                {selected && reduceMotion && (
                  <span
                    className="absolute inset-0 rounded-xl border border-primary/25 bg-primary/10"
                    aria-hidden="true"
                  />
                )}

                <span
                  className={cn(
                    "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150",
                    selected
                      ? "bg-primary/15 text-primary shadow-glow-sm"
                      : "text-muted-foreground group-hover:text-foreground"
                  )}
                  aria-hidden="true"
                >
                  <Icon className="h-4 w-4" />
                </span>

                <span className="relative min-w-0">
                  <span
                    className={cn(
                      "block text-sm font-medium leading-tight",
                      selected ? "text-foreground" : undefined
                    )}
                  >
                    {label}
                  </span>
                  <span className="block truncate text-xs leading-tight text-muted-foreground">
                    {description}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function MobileTabBar<T extends string>({ items, value, onChange }: AppNavProps<T>) {
  const reduceMotion = useReducedMotion()

  return (
    <nav
      aria-label="Sections"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border/60 surface-glass lg:hidden"
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        {items.map(({ id, label, icon: Icon }) => {
          const selected = id === value
          return (
            <li key={id} className="flex-1">
              <button
                type="button"
                onClick={() => onChange(id)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "relative flex min-h-[56px] w-full flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5",
                  "transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                {selected && !reduceMotion && (
                  <motion.span
                    layoutId="mobile-nav-active"
                    transition={SPRING}
                    className="absolute top-0 h-0.5 w-8 rounded-full bg-primary shadow-glow-sm"
                    aria-hidden="true"
                  />
                )}
                {selected && reduceMotion && (
                  <span
                    className="absolute top-0 h-0.5 w-8 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                )}

                <Icon
                  className={cn(
                    "h-5 w-5 transition-colors duration-150",
                    selected ? "text-primary" : "text-muted-foreground"
                  )}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    "text-[10px] font-medium leading-none",
                    selected ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {label}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
