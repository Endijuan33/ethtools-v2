"use client"

/**
 * Route-level error boundary.
 *
 * Catches anything that escapes the per-panel {@link ErrorBoundary} instances in
 * `app/page.tsx`, including throws from the App Router's own data phase. It
 * replaces the route's content but keeps the root layout — so the theme,
 * fonts, and toast host are still alive here.
 */

import { useEffect } from "react"
import { RotateCcw } from "lucide-react"
import Button from "@/components/ui/Button"
import Card, { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { logger } from "@/lib/logger"

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    logger.error("Route boundary caught an error", { component: "app/page", error })
  }, [error])

  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-4 py-10">
      <Card as="section" variant="solid" className="w-full max-w-md" aria-labelledby="route-error-title">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="route-error-title">This page could not be loaded</CardTitle>
            <CardDescription>
              Something failed while rendering. Nothing was sent anywhere and no stored data was
              changed — your encrypted vault is still on this device.
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          <p className="text-sm text-muted-foreground">
            Retrying re-renders the page without a full reload, which usually clears a transient
            failure. If it returns, reloading rebuilds the app from scratch.
          </p>

          {/*
            The digest is a server-generated hash used to correlate this failure
            with a server log. Unlike `error.message`, it cannot carry a
            mnemonic, a private key, or an API-keyed RPC URL, so it is the only
            part of the error safe to put on screen.
          */}
          {error.digest && (
            <p className="text-xs text-muted-foreground">
              Reference:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                {error.digest}
              </code>
            </p>
          )}

          <div className="flex flex-wrap gap-3 pt-1">
            <Button onClick={reset} icon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}>
              Try again
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
