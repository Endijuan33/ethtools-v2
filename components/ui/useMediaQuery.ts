"use client"

/**
 * Media query hook.
 *
 * Starts as `false` and updates after mount, so the server and the first client
 * render agree and no hydration mismatch is possible. Callers must therefore
 * treat the first paint as the "no match" branch.
 */

import { useEffect, useState } from "react"

/**
 * Track whether a CSS media query currently matches.
 *
 * @param query - A media query string, e.g. `(min-width: 640px)`.
 * @returns True when the query matches. Always false during SSR and first paint.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    const list = window.matchMedia(query)
    setMatches(list.matches)

    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches)
    list.addEventListener("change", onChange)
    return () => list.removeEventListener("change", onChange)
  }, [query])

  return matches
}

/** Matches the Tailwind `sm` breakpoint, the app's phone/tablet boundary. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 640px)")
}
