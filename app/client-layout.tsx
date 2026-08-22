// app/client-layout.tsx
"use client"

/**
 * Client shell.
 *
 * Detects a Farcaster Mini App host, loads the SDK, signals readiness so the
 * host dismisses its splash screen, and renders the host-style close affordance.
 * Outside a Mini App it renders nothing but its children.
 */

import { useCallback, useEffect, useState } from "react"
import { logger } from "@/lib/logger"

/**
 * The Mini App SDK's own type, derived from the module rather than declared by
 * hand, so a breaking SDK change surfaces at compile time.
 *
 * `import type` in a type position is erased, so this costs nothing at runtime —
 * the SDK is still only fetched by the dynamic import below.
 */
type MiniAppSdk = (typeof import("@farcaster/miniapp-sdk"))["sdk"]

/**
 * Loaded SDK handle, shared between the effect that resolves it and the close
 * button that uses it.
 *
 * Module scope rather than `window`: the previous `(window as any).farcasterSDK`
 * cast defeated type checking, exposed the SDK to any script on the page, and
 * could be clobbered by a host that defines the same global.
 */
let miniAppSdk: MiniAppSdk | null = null

/**
 * Detect an embedding Mini App host.
 *
 * Uses `window.self !== window.top` rather than comparing `window.location` with
 * `window.parent.location`. Reading the parent's `location` across an origin
 * boundary throws `SecurityError` — which is precisely the Mini App case this
 * check exists for. That throw aborted the whole effect, so the SDK never
 * loaded, `sdk.actions.ready()` never fired, and the host's splash screen never
 * dismissed. `window.self !== window.top` is same-origin-policy safe and cannot
 * throw; the try/catch is belt and braces against an exotic sandbox.
 */
function detectMiniApp(): boolean {
  try {
    return /Warpcast/i.test(navigator.userAgent) || window.self !== window.top
  } catch (error) {
    logger.debug("Mini App detection failed", { error })
    return false
  }
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  // Starts false so the server markup and the first client render agree; the
  // detection result can only be known after mount.
  const [isMiniApp, setIsMiniApp] = useState(false)

  useEffect(() => {
    if (!detectMiniApp()) return

    const root = document.documentElement
    const { body } = document

    // Capture the inline values so cleanup restores them. Clearing them
    // unconditionally would discard styles this component never set.
    const previous = {
      bodyOverflowX: body.style.overflowX,
      bodyOverflowY: body.style.overflowY,
      bodyHeight: body.style.height,
      rootHeight: root.style.height,
    }

    setIsMiniApp(true)
    root.classList.add("farcaster-miniapp")

    // Mini App hosts render in a WebView with a fixed document height, which
    // clips every panel below the fold and leaves it unreachable.
    body.style.overflowY = "auto"
    body.style.overflowX = "hidden"
    body.style.height = "auto"
    root.style.height = "auto"

    // Guards against the import resolving after an unmount, which would leave a
    // stale handle behind for a shell that is no longer on screen.
    let cancelled = false

    void import("@farcaster/miniapp-sdk")
      .then(async ({ sdk }) => {
        if (cancelled) return
        miniAppSdk = sdk

        // Dismisses the host splash screen. Anything that can fail is kept out
        // of the way until after this resolves.
        await sdk.actions.ready()

        try {
          const capabilities = await sdk.getCapabilities()
          if (capabilities.includes("haptics.impactOccurred")) {
            await sdk.haptics.impactOccurred("light")
          }
        } catch (error) {
          // Haptics are cosmetic; a host without them is not a failure worth
          // reporting, but it should still be visible while developing.
          logger.debug("Mini App haptics unavailable", { error })
        }
      })
      .catch((error: unknown) => {
        logger.debug("Mini App SDK failed to load", { error })
      })

    return () => {
      cancelled = true
      miniAppSdk = null
      root.classList.remove("farcaster-miniapp")
      body.style.overflowX = previous.bodyOverflowX
      body.style.overflowY = previous.bodyOverflowY
      body.style.height = previous.bodyHeight
      root.style.height = previous.rootHeight
    }
  }, [])

  const handleClose = useCallback(() => {
    const sdk = miniAppSdk
    if (sdk) {
      void sdk.actions.close().catch((error: unknown) => {
        logger.debug("Mini App close was rejected", { error })
      })
      return
    }

    // Fallback for a host that embeds the app without injecting the SDK. The
    // target origin stays "*" because a sandboxed frame has an opaque origin
    // that no explicit value matches; the payload carries no sensitive data.
    window.postMessage({ type: "farcaster:close" }, "*")
  }, [])

  return (
    <>
      {children}
      {/*
        Rendered by React rather than created with `document.createElement` and
        appended to `document.body`. The imperative version sat outside the tree,
        so React could not clean it up on unmount and its click handler kept a
        reference to a global that TypeScript could not check. The class name is
        unchanged, so the styling in `app/globals.css` still applies.
      */}
      {isMiniApp && (
        <button
          type="button"
          onClick={handleClose}
          className="farcaster-miniapp-close"
          aria-label="Close mini app"
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </>
  )
}
