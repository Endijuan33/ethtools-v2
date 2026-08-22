"use client"

/**
 * Root-layout error boundary.
 *
 * The last line of defence: it catches throws from `app/layout.tsx` itself, so
 * it must render its own `<html>` and `<body>` — the document shell it replaces
 * may be exactly what failed.
 *
 * For the same reason it is deliberately dependency-light. It imports no
 * provider, no design-system primitive, and no icon: any of those could be the
 * thing that crashed, and re-rendering it here would fail identically.
 *
 * Styling is inline and uses the CSS system colours `Canvas`/`CanvasText`
 * together with `color-scheme: light dark`. The Tailwind design tokens live in
 * `globals.css`, which is imported by the layout that just failed, so a
 * token-based class or an `hsl(var(--background))` value can resolve to nothing
 * here and leave black-on-black text. System colours need no stylesheet and
 * still follow the operating system's light or dark preference.
 */

import { useEffect } from "react"
import { logger } from "@/lib/logger"

const BODY_STYLE: React.CSSProperties = {
  margin: 0,
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1.5rem",
  background: "Canvas",
  color: "CanvasText",
  fontFamily: "system-ui, -apple-system, sans-serif",
  lineHeight: 1.55,
}

const PANEL_STYLE: React.CSSProperties = {
  maxWidth: "26rem",
  // `currentColor` keeps the outline visible in either colour scheme without a
  // second declaration or a hardcoded value.
  border: "1px solid currentColor",
  borderRadius: "0.75rem",
  padding: "1.5rem",
  textAlign: "center",
}

const BUTTON_STYLE: React.CSSProperties = {
  marginTop: "1.25rem",
  minHeight: "44px",
  padding: "0 1.25rem",
  border: "1px solid currentColor",
  borderRadius: "0.5rem",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
}

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    logger.error("Root layout failed to render", { component: "app/layout", error })
  }, [error])

  return (
    <html lang="en" style={{ colorScheme: "light dark" }}>
      <body style={BODY_STYLE}>
        {/*
          `reset` is not offered here. It re-renders the same root layout that
          just threw, so it almost always fails again; a full reload is the only
          action with a real chance of recovering.
        */}
        <main role="alert" style={PANEL_STYLE}>
          <h1 style={{ margin: 0, fontSize: "1.125rem", fontWeight: 600 }}>
            EthTools could not start
          </h1>
          <p style={{ marginTop: "0.75rem", fontSize: "0.875rem" }}>
            The app failed to load. Nothing was sent anywhere and no stored data was changed — your
            encrypted vault is still in this browser and will be there after a reload.
          </p>
          {error.digest && (
            <p style={{ marginTop: "0.75rem", fontSize: "0.75rem", opacity: 0.75 }}>
              {/* A correlation id, unlike the message, which can embed key material. */}
              Reference: <code style={{ fontFamily: "ui-monospace, monospace" }}>{error.digest}</code>
            </p>
          )}
          <button type="button" onClick={() => window.location.reload()} style={BUTTON_STYLE}>
            Reload page
          </button>
        </main>
      </body>
    </html>
  )
}
