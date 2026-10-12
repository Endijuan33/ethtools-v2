/**
 * Duplicate-confirmation guard.
 *
 * Destructive flows ask through `confirmAction` (components/ui/Toast). A
 * double-click, a re-render that re-fires a handler, or two components
 * reacting to the same gesture could stack several identical confirmation
 * toasts, each of which the user then had to dismiss — and, worse, each of
 * which would run the destructive action again on confirm. While a
 * confirmation with the same message, description, and labels is pending,
 * later identical calls join the pending promise instead of opening a
 * second toast. Distinct confirmations are never blocked.
 *
 * Pure and dependency-free so the gate can be unit-tested without a DOM.
 */

/** The identifying parts of a confirmation prompt. */
export interface ConfirmationIdentity {
  message: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
}

/** Stable identity key for a confirmation prompt. */
export function confirmationKey(options: ConfirmationIdentity): string {
  return JSON.stringify([
    options.message,
    options.description ?? "",
    options.confirmLabel ?? "Confirm",
    options.cancelLabel ?? "Cancel",
  ])
}

/**
 * A gate that runs at most one pending confirmation per identity key.
 *
 * `run` starts the confirmation through `start` when no identical one is
 * pending, and returns the in-flight promise otherwise. The entry is
 * released as soon as the promise settles, so the *next* identical request
 * after an answer prompts normally.
 */
export function createConfirmationGate() {
  const pending = new Map<string, Promise<boolean>>()

  return {
    run(
      options: ConfirmationIdentity,
      start: () => Promise<boolean>
    ): Promise<boolean> {
      const key = confirmationKey(options)
      const existing = pending.get(key)
      if (existing) return existing

      const promise = start().finally(() => {
        // Release only our own entry; a newer entry for the same key (which
        // cannot exist while this one is pending) must never be evicted.
        if (pending.get(key) === promise) pending.delete(key)
      })
      pending.set(key, promise)
      return promise
    },

    /** Number of distinct confirmations currently pending (diagnostics/tests). */
    pendingCount(): number {
      return pending.size
    },
  }
}

/** Gate type, for the UI layer that owns the shared instance. */
export type ConfirmationGate = ReturnType<typeof createConfirmationGate>
