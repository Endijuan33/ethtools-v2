import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import ClientLayout from "./client-layout"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/Toast"
import { Analytics } from "@vercel/analytics/next"

/**
 * `display: swap` avoids a blank text flash while the webfont loads, and
 * declaring the CSS variable lets Tailwind reference the family instead of
 * relying on the injected class reaching every portal.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
})

/**
 * Declared through the Next.js viewport export rather than a hand-written meta
 * tag, which previously emitted two conflicting viewport tags.
 *
 * Zooming stays enabled on purpose: `maximum-scale=1` with `user-scalable=no`
 * blocks pinch-zoom and fails WCAG 2.1 SC 1.4.4 (Resize Text).
 *
 * `themeColor` follows the active theme so mobile browser chrome matches the page
 * instead of showing a light bar above a dark app.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#070b18" },
  ],
}

/**
 * `metadataBase` resolves relative asset URLs and silences the Next.js warning
 * about it. It follows the Vercel-provided host so preview deployments describe
 * themselves correctly instead of pointing at production.
 */
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL !== undefined
    ? `https://${process.env.VERCEL_URL}`
    : "https://ethtools.vercel.app")

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "EthTools — Ethereum Wallet Utility",
    template: "%s · EthTools",
  },
  description:
    "Client-side Ethereum wallet utility. Keys are encrypted in your browser and never sent to a server.",
  applicationName: "EthTools",
  icons: {
    // The brand mark is a coloured tile that reads on both light and dark
    // chrome, so a single SVG serves every scheme — no per-theme PNG pair.
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: "/apple-icon.png",
  },

  // Base Mini App identifier.
  other: {
    "base:app_id": "6a00cc0e9ee68cd142d1b0bd",
  },

  openGraph: {
    title: "EthTools",
    description:
      "Derive addresses, generate wallets, and manage encrypted accounts — entirely client-side.",
    url: siteUrl,
    siteName: "EthTools",
    type: "website",
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is required by next-themes: it sets the theme class
    // on <html> before React hydrates, which is an intentional mismatch.
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <body className={inter.className}>
        <ThemeProvider>
          <ClientLayout>{children}</ClientLayout>
          <Toaster />
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  )
}
