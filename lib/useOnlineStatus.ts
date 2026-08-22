"use client"

/**
 * Offline detection.
 *
 * This app is an RPC client, so "your device has no network" and "the endpoint
 * is unreachable" call for different copy and different advice. Knowing the
 * former lets the UI stop blaming the RPC for a problem it did not cause.
 *
 * Deliberately hook-only and state-free at module scope: reading `navigator`
 * during module evaluation would break the server build.
 */

import { useEffect, useState } from "react"

/** Result of {@link useOnlineStatus}. */
export interface OnlineStatus {
  /** False only once an `offline` event or the post-mount probe says so. */
  isOnline: boolean
  /**
   * True after the connection has dropped at least once this session. Lets a
   * caller show a "back online" confirmation without tracking the edge itself.
   */
  wasOffline: boolean
}

/**
 * Track browser connectivity.
 *
 * Starts optimistic (`isOnline: true`) and syncs from `navigator.onLine` in an
 * effect rather than during render. Reading `navigator` on the server throws,
 * and reading it in a `useState` initialiser produces markup that disagrees with
 * the server's, which React resolves by discarding the client tree.
 *
 * **Limitation.** `navigator.onLine` reports link-layer state only: it is true
 * whenever an interface has a route, so a captive portal, a DNS blackhole, or a
 * firewall that drops the RPC host all read as online. Treat a `true` result as
 * "no reason to think the network is down", never as "requests will succeed" —
 * request-level failures must still be handled where the request is made.
 *
 * `wasOffline` is sticky for the lifetime of the hook: it is a "has been offline"
 * flag, not a pending notification, so consumers can key an effect on the
 * `isOnline && wasOffline` pair and get exactly one confirmation per recovery.
 */
export function useOnlineStatus(): OnlineStatus {
  const [isOnline, setIsOnline] = useState(true)
  const [wasOffline, setWasOffline] = useState(false)

  useEffect(() => {
    const apply = (online: boolean): void => {
      setIsOnline(online)
      // Latch the drop before the recovery arrives, so the pair is already
      // consistent on the render that reports the connection back.
      if (!online) setWasOffline(true)
    }

    // The connection may have dropped between the server render and hydration.
    apply(navigator.onLine)

    const handleOnline = (): void => apply(true)
    const handleOffline = (): void => apply(false)

    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)

    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  return { isOnline, wasOffline }
}

export default useOnlineStatus
