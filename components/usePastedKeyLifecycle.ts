"use client"

/**
 * Lifecycle guard for a pasted private key held in component state.
 *
 * The standalone signers (message / typed-data) accept a raw private key
 * outside the vault. That key must not live for the whole tab session: this
 * hook clears it after an inactivity window, and immediately whenever the
 * vault locks — in this tab (the `VAULT_LOCKED` app event) or in any other
 * tab (the cross-tab session broadcast). Signing itself clears the key in
 * the caller, right after the signature is produced.
 */

import { useEffect, useRef } from "react"
import { APP_EVENTS, onAppEvent } from "@/lib/appEvents"
import { subscribeVaultSessionEvents } from "@/lib/vaultSession"

/** Idle time after which a pasted key is dropped from memory. */
export const PASTED_KEY_INACTIVITY_MS = 5 * 60_000

/**
 * Wire the clearing rules for one pasted-key field.
 *
 * @param hasKey - Whether a key is currently held.
 * @param activitySignal - Value that changes on user activity with the key
 *   (the key itself works); each change restarts the inactivity window.
 * @param clearKey - Drops the key from state.
 */
export function usePastedKeyLifecycle(
  hasKey: boolean,
  activitySignal: unknown,
  clearKey: () => void
): void {
  const clearRef = useRef(clearKey)
  clearRef.current = clearKey

  // Inactivity auto-clear.
  useEffect(() => {
    if (!hasKey) return
    const timer = setTimeout(() => clearRef.current(), PASTED_KEY_INACTIVITY_MS)
    return () => clearTimeout(timer)
  }, [hasKey, activitySignal])

  // Global lock linkage: this tab's vault lock event, and lock/erase
  // broadcasts from other tabs. Session events never echo back into the
  // tab that sent them, so no source filtering is needed here.
  useEffect(() => {
    const offAppEvent = onAppEvent(APP_EVENTS.VAULT_LOCKED, () => clearRef.current())
    const offSession = subscribeVaultSessionEvents(() => clearRef.current())
    return () => {
      offAppEvent()
      offSession()
    }
  }, [])
}
