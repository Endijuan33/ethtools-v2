"use client"

/**
 * Toast host and helpers.
 *
 * `sonner` was already a dependency but unused. Adopting it replaces three
 * native `window.confirm` calls and several inline status banners that competed
 * for the same screen space.
 *
 * Toasts are styled through the design tokens so they follow the active theme,
 * and are positioned bottom-centre on mobile (thumb reach, clear of the header)
 * and top-right on desktop.
 */

import { Toaster as SonnerToaster, toast } from "sonner"
import { useIsDesktop } from "./useMediaQuery"

/** Mount once, near the root. */
export function Toaster() {
  const isDesktop = useIsDesktop()

  return (
    <SonnerToaster
      position={isDesktop ? "top-right" : "bottom-center"}
      // Errors stay until dismissed; a failed transaction must not vanish.
      duration={4500}
      gap={10}
      // Desktop toasts start below the 64px sticky header so a persistent
      // error toast can never sit on top of the header controls; mobile toasts
      // are lifted above the fixed section tab bar (56px + safe area).
      offset={isDesktop ? 80 : 92}
      toastOptions={{
        classNames: {
          toast:
            "!rounded-xl !border !border-border !bg-card !text-card-foreground !shadow-glass-lg",
          title: "!text-sm !font-semibold",
          description: "!text-sm !text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground !rounded-md",
          cancelButton: "!bg-secondary !text-secondary-foreground !rounded-md",
          icon: "!shrink-0",
          success: "[&_[data-icon]]:!text-success",
          error: "[&_[data-icon]]:!text-destructive",
          warning: "[&_[data-icon]]:!text-warning",
          info: "[&_[data-icon]]:!text-info",
        },
      }}
    />
  )
}

/**
 * Semantic toast helpers.
 *
 * Thin wrappers rather than raw `toast` calls so tone usage stays consistent and
 * the underlying library remains swappable.
 */
export const notify = {
  success: (message: string, description?: string) => toast.success(message, { description }),
  error: (message: string, description?: string) =>
    // Errors persist: a dismissed-too-fast failure is worse than a stale toast.
    toast.error(message, { description, duration: Number.POSITIVE_INFINITY }),
  warning: (message: string, description?: string) => toast.warning(message, { description }),
  info: (message: string, description?: string) => toast.info(message, { description }),

  /**
   * Bind a promise to a toast that reports its outcome.
   *
   * @param promise - Work to track.
   * @param messages - Copy for each state.
   */
  promise: <T,>(
    promise: Promise<T>,
    messages: { loading: string; success: string; error: string }
  ) => toast.promise(promise, messages),

  dismiss: () => toast.dismiss(),
}

/**
 * Destructive-action confirmation.
 *
 * Replaces `window.confirm`, which is unstyled, ignores the theme, blocks the
 * main thread, and is suppressible by the browser. The promise resolves true only
 * when the user activates the confirm action.
 *
 * @param options - Copy for the prompt and its actions.
 */
export function confirmAction(options: {
  message: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
}): Promise<boolean> {
  const { message, description, confirmLabel = "Confirm", cancelLabel = "Cancel" } = options

  return new Promise((resolve) => {
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const id = toast.warning(message, {
      description,
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: confirmLabel,
        onClick: () => settle(true),
      },
      cancel: {
        label: cancelLabel,
        onClick: () => settle(false),
      },
      // Dismissing by any other route counts as declining.
      onDismiss: () => settle(false),
      onAutoClose: () => settle(false),
    })
    void id
  })
}
