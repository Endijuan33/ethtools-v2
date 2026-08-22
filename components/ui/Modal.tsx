"use client"

/**
 * Compatibility alias for {@link ResponsiveDialog}.
 *
 * The hand-rolled implementation that lived here has been replaced by
 * `ResponsiveDialog`, which delegates focus management, Escape handling, and
 * scroll locking to Radix on desktop and to `vaul` on touch viewports.
 *
 * The prop contract is unchanged, so existing call sites keep working and gain
 * mobile bottom sheets without modification. Prefer importing `ResponsiveDialog`
 * directly in new code.
 */

export { default, type ResponsiveDialogProps as ModalProps } from "./ResponsiveDialog"
