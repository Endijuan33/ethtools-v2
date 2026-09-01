/**
 * EthTools brand mark.
 *
 * Original artwork drawn inline (no third-party assets): a hexagonal bolt
 * head with a hex socket — the "tools" half of the name doubling as the
 * six-sided shape the Ethereum ecosystem is visually associated with. The
 * gradient stops match the app's `--primary` and `--info` design tokens, and
 * `currentColor` is avoided so the mark stays legible on any surface.
 *
 * Purely decorative wherever it appears next to the "EthTools" wordmark, so
 * the SVG is aria-hidden and the caller supplies any accessible name.
 */

export interface BrandMarkProps {
  /** Rendered square size in pixels. */
  size?: number
  className?: string
}

export default function BrandMark({ size = 36, className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <linearGradient
          id="brand-mark-tile"
          x1="0"
          y1="0"
          x2="512"
          y2="512"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#3B82F6" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="url(#brand-mark-tile)" />
      <polygon
        points="256,88 401.5,172 401.5,340 256,424 110.5,340 110.5,172"
        fill="#ffffff"
      />
      <polygon
        points="320,256 288,311.4 224,311.4 192,256 224,200.6 288,200.6"
        fill="url(#brand-mark-tile)"
      />
    </svg>
  )
}
