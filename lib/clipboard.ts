/**
 * Best-effort clipboard hygiene for copied secrets.
 *
 * A copied private key or recovery phrase otherwise sits on the system
 * clipboard indefinitely — readable by other apps, synced to other devices,
 * and kept in clipboard history. After a delay the app clears it, but ONLY
 * when the clipboard still holds exactly what it wrote: overwriting a value
 * the user has since copied on purpose would destroy their data.
 *
 * The decision half is pure and unit-tested; the browser half is a small
 * adapter that treats every failure (permission denied, no clipboard API,
 * unfocused document) as a silent no-op.
 */

/** Delay before a copied secret is cleared from the clipboard. */
export const SECRET_CLIPBOARD_CLEAR_MS = 45_000

/**
 * Whether the clipboard may be cleared.
 *
 * @param copiedValue - The secret this app placed on the clipboard.
 * @param currentValue - What the clipboard holds now, or null when unreadable.
 * @returns True only on an exact match.
 */
export function shouldClearClipboard(copiedValue: string, currentValue: string | null): boolean {
  if (copiedValue.length === 0) return false
  return currentValue !== null && currentValue === copiedValue
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Schedule a best-effort clear of a just-copied secret.
 *
 * Calling it again replaces the pending clear, so copying a second secret
 * restarts the window for the newest value. All errors are swallowed:
 * clipboard permission prompts must never interrupt the user for hygiene.
 *
 * @param value - The exact string that was written to the clipboard.
 * @param delayMs - Delay before clearing; defaults to
 *   {@link SECRET_CLIPBOARD_CLEAR_MS}.
 */
export function scheduleSecretClipboardClear(
  value: string,
  delayMs: number = SECRET_CLIPBOARD_CLEAR_MS
): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return
  if (pendingTimer !== null) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    void (async () => {
      try {
        if (!navigator.clipboard?.readText || !navigator.clipboard?.writeText) return
        const current = await navigator.clipboard.readText()
        if (shouldClearClipboard(value, current)) {
          await navigator.clipboard.writeText("")
        }
      } catch {
        // Permission denied or document not focused: leave the clipboard as
        // it is. Hygiene is best-effort, never a user-facing failure.
      }
    })()
  }, delayMs)
}
