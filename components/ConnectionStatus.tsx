"use client"

/**
 * Offline banner.
 *
 * Mount once, near the root. Renders nothing while the connection is healthy —
 * a permanent "online" indicator is noise, and the interesting state is the
 * exception.
 *
 * The copy names the consequence rather than the condition. "Offline" alone
 * leaves a wallet user wondering whether their keys are still there; the answer
 * is that the vault is local and encrypted and only network reads are affected.
 */

import { useEffect } from "react"
import { WifiOff } from "lucide-react"
import { notify } from "@/components/ui/Toast"
import { useOnlineStatus } from "@/lib/useOnlineStatus"

export default function ConnectionStatus() {
  const { isOnline, wasOffline } = useOnlineStatus()

  useEffect(() => {
    // Fires once per recovery: `wasOffline` latches on the drop and `isOnline`
    // only returns to true on the edge back up.
    if (isOnline && wasOffline) {
      notify.success("Back online", "Balances and transaction history can be fetched again.")
    }
  }, [isOnline, wasOffline])

  if (isOnline) return null

  return (
    <div
      role="status"
      aria-live="polite"
      // Bottom-anchored and inert: it sits in the thumb zone on a phone without
      // covering the header, and never intercepts a tap meant for the page.
      // Raised above the mobile tab bar (56px + safe area + gap) on small
      // screens; on desktop there is no tab bar to clear.
      className="pb-safe pointer-events-none fixed inset-x-0 bottom-24 z-50 px-4 lg:bottom-0"
    >
      <div className="mx-auto flex max-w-md items-start gap-3 rounded-xl border border-warning/35 bg-card/95 px-3 py-2.5 shadow-glass-lg backdrop-blur">
        <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">You are offline</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Balances, prices, and transaction history cannot be fetched until the connection
            returns. Your vault stays encrypted on this device and remains available.
          </p>
        </div>
      </div>
    </div>
  )
}
