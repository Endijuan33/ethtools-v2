import type { Config } from "tailwindcss"

/**
 * Single source of truth for Tailwind.
 *
 * There used to be both `tailwind.config.cjs` and this file. Tailwind v3
 * resolves `.js` -> `.cjs` -> `.mjs` -> `.ts`, so the `.cjs` file won and this
 * one was dead config — which is why `shadow-glass`, used by five components,
 * silently rendered nothing. The `.cjs` file has been removed.
 *
 * Colours map to the CSS variables declared in `app/globals.css`, written as
 * `hsl(var(--token) / <alpha-value>)` so alpha modifiers such as `bg-primary/20`
 * compose correctly.
 */
const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: { DEFAULT: "1rem", sm: "1.5rem", lg: "2rem" },
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        success: {
          DEFAULT: "hsl(var(--success) / <alpha-value>)",
          foreground: "hsl(var(--success-foreground) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--warning) / <alpha-value>)",
          foreground: "hsl(var(--warning-foreground) / <alpha-value>)",
        },
        info: {
          DEFAULT: "hsl(var(--info) / <alpha-value>)",
          foreground: "hsl(var(--info-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        surface: {
          DEFAULT: "hsl(var(--surface) / <alpha-value>)",
          foreground: "hsl(var(--surface-foreground) / <alpha-value>)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "calc(var(--radius) + 4px)",
        "2xl": "calc(var(--radius) + 8px)",
      },
      boxShadow: {
        // Layered rather than one large blur: a single wide shadow produces a
        // muddy halo on dark backgrounds instead of reading as elevation.
        glass:
          "0 1px 1px hsl(230 26% 4% / 0.04), 0 8px 24px -8px hsl(230 26% 4% / 0.12), 0 16px 48px -24px hsl(230 26% 4% / 0.18)",
        "glass-lg":
          "0 1px 1px hsl(230 26% 4% / 0.05), 0 16px 40px -12px hsl(230 26% 4% / 0.18), 0 32px 72px -32px hsl(230 26% 4% / 0.24)",
        // Elevation used when a card lifts on hover.
        "glass-hover":
          "0 1px 1px hsl(230 26% 4% / 0.05), 0 12px 32px -10px hsl(230 26% 4% / 0.18), 0 24px 64px -28px hsl(230 26% 4% / 0.26)",
        // Brand halo for primary actions and the active nav pill.
        glow: "0 0 0 1px hsl(var(--primary) / 0.25), 0 4px 20px -2px hsl(var(--primary) / 0.45)",
        "glow-sm": "0 2px 12px -2px hsl(var(--primary) / 0.4)",
        "glow-success": "0 2px 12px -2px hsl(var(--success) / 0.45)",
        "glow-destructive": "0 2px 12px -2px hsl(var(--destructive) / 0.45)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        // Skeleton placeholder sweep.
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        // Marks a value that just changed, without shifting layout.
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 hsl(var(--primary) / 0.4)" },
          "70%": { boxShadow: "0 0 0 8px hsl(var(--primary) / 0)" },
          "100%": { boxShadow: "0 0 0 0 hsl(var(--primary) / 0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        shimmer: "shimmer 1.8s infinite",
        "pulse-ring": "pulse-ring 1.2s ease-out",
      },
      transitionTimingFunction: {
        emphasized: "cubic-bezier(0.2, 0, 0, 1)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}

export default config
