/**
 * Cross-component notification events.
 *
 * Several components need to react to state that lives in `localStorage` rather
 * than in React, so the app uses `window` events as a lightweight bus.
 *
 * The names live here because the previous arrangement let them drift: a
 * `walletDataUpdated` listener in `WalletCard` survived after the code that
 * dispatched it was rewritten, so the component sat waiting for an event that
 * could never arrive. Referencing a constant makes that impossible — a typo is a
 * compile error, and an unused key is visible in one place.
 */

/** Every event the application dispatches. */
export const APP_EVENTS = {
  /** Transaction history was added to, updated, or pruned. */
  TRANSACTIONS_CHANGED: "ethtools:transactions-changed",
  /** A bookmark was created, edited, or deleted. */
  BOOKMARKS_CHANGED: "ethtools:bookmarks-changed",
  /**
   * A backup was restored, or all data was erased.
   *
   * Consumers must re-read everything they cache from storage, including custom
   * networks — which are otherwise only loaded on mount, so a restored network
   * would stay invisible until a manual page reload.
   */
  DATA_RESTORED: "ethtools:data-restored",
} as const

/** An event name the application can dispatch. */
export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS]

/**
 * Dispatch an application event.
 *
 * Safe to call during server rendering, where it is a no-op.
 *
 * @param name - Event to dispatch.
 */
export function emitAppEvent(name: AppEventName): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(name))
}

/**
 * Subscribe to an application event.
 *
 * @param name - Event to listen for.
 * @param handler - Invoked on each dispatch.
 * @returns An unsubscribe function, suitable for returning from `useEffect`.
 */
export function onAppEvent(name: AppEventName, handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined
  window.addEventListener(name, handler)
  return () => window.removeEventListener(name, handler)
}
