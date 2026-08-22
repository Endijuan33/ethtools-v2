"use client"

/**
 * Card surfaces.
 *
 * The frosted look comes from `.surface-glass` plus the layered `shadow-glass`
 * defined in the Tailwind config. Both were previously unusable: `shadow-glass`
 * lived only in a Tailwind config file that was shadowed by a `.cjs` sibling, so
 * every card in the app rendered with no shadow at all.
 */

 
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const cardVariants = cva("rounded-2xl border text-card-foreground", {
  variants: {
    variant: {
      /** Frosted panel used for primary content. */
      glass: "surface-glass border-border/60 shadow-glass",
      /** Opaque card, for content that must stay legible over any backdrop. */
      solid: "bg-card border-border shadow-glass",
      /** Recessed well used for grouping inside a card. */
      inset: "bg-muted/40 border-border/50",
      /** No chrome; useful when only the padding scale is wanted. */
      plain: "border-transparent bg-transparent",
    },
    padding: {
      none: "",
      sm: "p-4",
      md: "p-5 sm:p-6",
      lg: "p-6 sm:p-8",
    },
  },
  defaultVariants: { variant: "glass", padding: "md" },
})

export interface CardProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof cardVariants> {
  /**
   * Element to render. Use `section` or `article` when the card is a landmark
   * with its own accessible name, so it appears in the document outline.
   */
  as?: "div" | "section" | "article"
}

/**
 * Not a `forwardRef` component on purpose: forwarding a ref through a
 * polymorphic `as` makes TypeScript intersect the ref types of every permitted
 * element, which does not typecheck. No call site needs a ref here.
 */
function Card({ className, variant, padding, as: Tag = "div", ...rest }: CardProps) {
  return <Tag className={cn(cardVariants({ variant, padding }), className)} {...rest} />
}

/** Header row. Use with {@link CardTitle} and {@link CardDescription}. */
export function CardHeader({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4 flex items-start justify-between gap-3", className)} {...rest} />
}

/**
 * Card heading.
 *
 * Defaults to `h2`; pass `as` to keep the document outline correct when a card
 * is nested inside another titled section.
 */
export function CardTitle({
  className,
  as: Tag = "h2",
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: "h1" | "h2" | "h3" | "h4" }) {
  return (
    <Tag
      className={cn("text-base font-semibold leading-tight tracking-tight sm:text-lg", className)}
      {...rest}
    />
  )
}

export function CardDescription({
  className,
  ...rest
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-1 text-sm text-muted-foreground", className)} {...rest} />
}

export function CardContent({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-4", className)} {...rest} />
}

export function CardFooter({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4", className)}
      {...rest}
    />
  )
}

export default Card
export { cardVariants }
