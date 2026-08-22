"use client"

/**
 * Button.
 *
 * Variants are declared with `class-variance-authority` so the mapping from
 * intent to classes lives in one place rather than being re-derived at each call
 * site. All colours resolve through design tokens, so a button is correct in
 * either theme with no conditional logic.
 */

import { forwardRef } from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg",
    "text-sm font-semibold transition-all duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
    // Press feedback confirms the tap on touch devices, which have no hover.
    "active:scale-[0.98]",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline:
          "border border-input bg-transparent hover:bg-secondary hover:text-secondary-foreground",
        ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
        danger: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        success: "bg-success text-success-foreground shadow-sm hover:bg-success/90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-9 px-3 text-xs",
        // 44px is the minimum comfortable touch target on both platforms.
        md: "h-11 px-4",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
      },
      fullWidth: { true: "w-full" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
)

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Shows a spinner and blocks interaction. */
  isLoading?: boolean
  /** Replaces the label while loading. */
  loadingLabel?: string
  /** Rendered before the label; hidden from assistive technology. */
  icon?: React.ReactNode
  /**
   * Render the single child element instead of a `<button>`, merging these props
   * onto it. Use for an anchor that should look like a button, so navigation
   * stays a real link rather than a button with an onClick.
   *
   * `isLoading` is ignored in this mode: an anchor has no busy state, and a
   * spinner would replace the child's own content.
   */
  asChild?: boolean
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    fullWidth,
    isLoading = false,
    loadingLabel,
    icon,
    asChild = false,
    disabled,
    children,
    // Defaults to "button": a bare <button> inside a form submits and reloads.
    type = "button",
    ...rest
  },
  ref
) {
  const classes = cn(buttonVariants({ variant, size, fullWidth }), className)

  if (asChild) {
    return (
      <Slot className={classes} {...rest}>
        {children}
      </Slot>
    )
  }

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={classes}
      {...rest}
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      {isLoading && loadingLabel ? loadingLabel : children}
    </button>
  )
})

export default Button
export { buttonVariants }
