"use client"

/**
 * Dialog that adapts to the viewport.
 *
 * Desktop renders a centred Radix dialog; touch viewports render a `vaul` bottom
 * sheet with a drag handle, which is the platform-native pattern and puts
 * controls within thumb reach.
 *
 * Both libraries provide focus trapping, focus restoration, Escape handling, and
 * background scroll locking. The app previously hand-rolled seven `fixed inset-0`
 * overlays with none of that: no `role="dialog"`, no focus trap, no Escape, and
 * the page scrolled behind them.
 */

import { Drawer } from "vaul"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useIsDesktop } from "./useMediaQuery"

export interface ResponsiveDialogProps {
  isOpen: boolean
  onClose: () => void
  /** Heading text, and the dialog's accessible name. */
  title: string
  /** Optional supporting text under the heading. */
  description?: string
  children: React.ReactNode
  /** Optional footer, typically actions. */
  footer?: React.ReactNode
  size?: "sm" | "md" | "lg"
  /**
   * Set false for a dialog the user must resolve, suppressing Escape, the
   * backdrop, and the close button. Use sparingly.
   */
  dismissible?: boolean
}

const SIZE_CLASS: Record<NonNullable<ResponsiveDialogProps["size"]>, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-lg",
}

export default function ResponsiveDialog({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
}: ResponsiveDialogProps) {
  const isDesktop = useIsDesktop()

  const handleOpenChange = (open: boolean): void => {
    if (!open && dismissible) onClose()
  }

  const body = (
    <>
      <div className="space-y-4">{children}</div>
      {footer && (
        <div className="mt-6 flex flex-wrap justify-end gap-3 border-t border-border pt-4">
          {footer}
        </div>
      )}
    </>
  )

  // Touch viewports: bottom sheet.
  if (!isDesktop) {
    return (
      <Drawer.Root
        open={isOpen}
        onOpenChange={handleOpenChange}
        dismissible={dismissible}
        // Keeps a focused input above the on-screen keyboard.
        repositionInputs
      >
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
          <Drawer.Content
            // Same toast rule as the desktop dialog above: vaul is built on
            // Radix Dialog, so approving a confirmAction toast sitting over the
            // sheet would otherwise dismiss the sheet mid-flow.
            onInteractOutside={(event) => {
              const target = event.target as HTMLElement | null
              if (target?.closest("[data-sonner-toast]")) {
                event.preventDefault()
                return
              }
              if (!dismissible) event.preventDefault()
            }}
            className={cn(
              "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col",
              "rounded-t-3xl border-t border-border bg-card text-card-foreground",
              "shadow-glass-lg focus-visible:outline-none"
            )}
          >
            {/* Drag affordance. Decorative: dragging and Escape both already work. */}
            {dismissible && (
              <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-border" aria-hidden="true" />
            )}

            <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-4">
              <div className="min-w-0">
                <Drawer.Title className="text-base font-semibold tracking-tight">
                  {title}
                </Drawer.Title>
                {description && (
                  <Drawer.Description className="mt-1 text-sm text-muted-foreground">
                    {description}
                  </Drawer.Description>
                )}
              </div>
              {dismissible && (
                <Drawer.Close
                  aria-label={`Close ${title}`}
                  className="-mr-1 -mt-1 shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </Drawer.Close>
              )}
            </div>

            <div className="overflow-y-auto px-5 pb-safe pt-2">{body}</div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    )
  }

  // Desktop: centred dialog.
  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
          )}
        />
        <DialogPrimitive.Content
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            // A confirmAction toast spawned from inside this dialog renders in
            // a portal outside it, so approving one counts as an outside
            // interaction — without this guard the dialog would close itself
            // in the middle of the flow the toast is confirming.
            const target = event.target as HTMLElement | null
            if (target?.closest("[data-sonner-toast]")) {
              event.preventDefault()
              return
            }
            if (!dismissible) event.preventDefault()
          }}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2",
            "max-h-[90dvh] overflow-y-auto rounded-2xl border border-border",
            "bg-card p-6 text-card-foreground shadow-glass-lg focus-visible:outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            SIZE_CLASS[size]
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            {dismissible && (
              <DialogPrimitive.Close
                aria-label={`Close ${title}`}
                className="-mr-1 -mt-1 shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            )}
          </div>

          {body}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
