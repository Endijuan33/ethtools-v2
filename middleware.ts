import { NextRequest, NextResponse } from "next/server"

/**
 * Content-Security-Policy, issued per request from middleware.
 *
 * The policy lives here rather than in `next.config.mjs` headers because the
 * production `script-src` is nonce-based: every response mints a fresh nonce,
 * Next stamps it onto the inline bootstrap scripts it generates, and the
 * layout reads it back (via the `x-nonce` request header) for the one
 * hand-rendered inline script in the tree — next-themes' theme bootstrap.
 * A static header in the config cannot carry a per-request value.
 *
 * Production `script-src` is `'self' 'nonce-…' 'strict-dynamic'`:
 * - No `'unsafe-inline'`: an injected inline script without the nonce does
 *   not execute. `'strict-dynamic'` then extends that trust to the scripts
 *   the nonced bootstrap itself loads (the app's own chunks), which is what
 *   lets the bundle keep code-splitting without a host allowlist.
 * - The nonce is unguessable per request (a base64 UUID from the platform
 *   CSPRNG), so this is not a static-token bypass.
 *
 * Dev/prod genuinely differ, as they did when the policy lived in the config:
 * Next's dev server evaluates every module through `eval()` and drives Fast
 * Refresh over a plaintext `ws://` socket, so the development policy keeps
 * `'unsafe-inline'`/`'unsafe-eval'` and the localhost socket allowances.
 * None of those relaxations ship to production, where the bundle is
 * pre-compiled and needs no `eval`.
 *
 * Two deliberate residuals:
 * - `style-src` keeps `'unsafe-inline'`. Inline `style` attributes cannot
 *   carry a nonce, and the UI writes them at runtime (framer-motion
 *   transforms, Radix positioning, React `style` props). Style injection is
 *   also a far weaker primitive than script injection in modern browsers —
 *   CSS cannot execute code — and the exfiltration side-channels are bounded
 *   by `img-src`/`connect-src` below.
 * - `connect-src` cannot be a fixed host list because users add their own
 *   RPC endpoints at runtime. Restricting it to `https:`/`wss:` still blocks
 *   a plaintext or `data:` exfiltration channel.
 *
 * `frame-ancestors` is an allowlist rather than DENY: this app is meant to
 * be embedded by Farcaster Mini App clients, and DENY would break that while
 * leaving it open to every other embedder.
 *
 * Introducing this middleware is also what closes the last precondition of
 * the old policy: the app no longer relies on a feature (nonce-less inline
 * bootstrapping) that several framework advisories have targeted.
 */

const isDevelopment = process.env.NODE_ENV !== "production"

function buildContentSecurityPolicy(nonce: string): string {
  const scriptSrc = isDevelopment
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
    : ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]
  const connectSrc = ["'self'", "https:", "wss:"]

  if (isDevelopment) {
    // Fast Refresh's HMR socket is ws:// on localhost, not wss://.
    connectSrc.push("ws:", "http://localhost:*", "ws://localhost:*")
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self' https://warpcast.com https://*.warpcast.com https://farcaster.xyz https://*.farcaster.xyz https://base.org https://*.base.org",
  ]

  // Upgrading requests would rewrite http://localhost during development.
  if (!isDevelopment) directives.push("upgrade-insecure-requests")

  return directives.join("; ")
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce)

  // Next reads the nonce out of the CSP request header and stamps it onto
  // the scripts it generates; `x-nonce` carries it to the root layout for
  // the hand-rendered theme bootstrap script.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy)

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })
  response.headers.set("Content-Security-Policy", contentSecurityPolicy)

  return response
}

export const config = {
  matcher: [
    {
      /*
       * Everything except Next's static/image pipelines and the favicon:
       * documents (the page, the Farcaster frame route, public files) all
       * carried the CSP under the old config headers and keep it here.
       * Static chunks are not documents — a CSP on them would be inert —
       * and running middleware on every chunk request is pure overhead.
       * Prefetch requests are skipped per the Next.js CSP guide: they are
       * not full document loads and re-running the middleware for them
       * would mint nonces nothing consumes.
       */
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
}
