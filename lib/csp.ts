/**
 * Content-Security-Policy construction.
 *
 * Extracted from `middleware.ts` as pure functions so the exact policies the
 * edge ships can be unit-tested without a Next.js server. The middleware is
 * a thin adapter: it mints the nonce, asks here which policy applies, and
 * sets the headers.
 *
 * The document policy lives here rather than in `next.config.mjs` headers
 * because production `script-src` is nonce-based: every response mints a
 * fresh nonce, Next stamps it onto the inline bootstrap scripts it
 * generates, and the layout reads it back (via the `x-nonce` request
 * header) for the one hand-rendered inline script in the tree —
 * next-themes' theme bootstrap. A static header cannot carry a per-request
 * value.
 */

/** Path of the Farcaster frame route, which gets its own policy. */
export const FRAME_ROUTE_PATH = "/api/frame"

/** Whether a pathname is the frame route. */
export function isFrameRoute(pathname: string): boolean {
  return pathname === FRAME_ROUTE_PATH
}

/**
 * Hosts allowed to embed the app.
 *
 * An allowlist rather than DENY: this app is meant to be embedded by
 * Farcaster Mini App clients, and DENY would break that while leaving it
 * open to every other embedder.
 */
const FRAME_ANCESTORS =
  "'self' https://warpcast.com https://*.warpcast.com https://farcaster.xyz https://*.farcaster.xyz https://base.org https://*.base.org"

/**
 * Per-request document policy.
 *
 * Production `script-src` is `'self' 'nonce-…' 'strict-dynamic'`:
 * - No `'unsafe-inline'`: an injected inline script without the nonce does
 *   not execute. `'strict-dynamic'` then extends that trust to the scripts
 *   the nonced bootstrap itself loads (the app's own chunks), which is what
 *   lets the bundle keep code-splitting without a host allowlist.
 * - The nonce is unguessable per request (a base64 UUID from the platform
 *   CSPRNG), so this is not a static-token bypass.
 *
 * Dev/prod genuinely differ: Next's dev server evaluates every module
 * through `eval()` and drives Fast Refresh over a plaintext `ws://` socket,
 * so the development policy keeps `'unsafe-inline'`/`'unsafe-eval'` and the
 * localhost socket allowances. None of those relaxations ship to production.
 *
 * Two deliberate residuals:
 * - `style-src` keeps `'unsafe-inline'`. Inline `style` attributes cannot
 *   carry a nonce, and the UI writes them at runtime (framer-motion
 *   transforms, Radix positioning, React `style` props). Style injection is
 *   also a far weaker primitive than script injection in modern browsers —
 *   CSS cannot execute code — and the exfiltration side-channels are bounded
 *   by `img-src`/`connect-src`.
 * - `connect-src` cannot be a fixed host list because users add their own
 *   RPC endpoints at runtime. Restricting it to `https:`/`wss:` still blocks
 *   a plaintext or `data:` exfiltration channel.
 *
 * @param nonce - This request's nonce (production only; ignored in dev).
 * @param isDevelopment - Whether the dev policy should be produced.
 */
export function buildDocumentCsp(nonce: string, isDevelopment: boolean): string {
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
    `frame-ancestors ${FRAME_ANCESTORS}`,
  ]

  // Upgrading requests would rewrite http://localhost during development.
  if (!isDevelopment) directives.push("upgrade-insecure-requests")

  return directives.join("; ")
}

/**
 * Policy for the Farcaster frame route.
 *
 * The frame HTML is identical for every visitor and is served with
 * `Cache-Control: public, max-age=300`, so it must NOT carry a per-request
 * nonce: a shared cache would replay one request's nonce to everyone, which
 * both breaks the nonce model and buys nothing — the page runs no scripts
 * at all. The policy therefore forbids script outright, mirrors the
 * document policy's other directives, and keeps the same `frame-ancestors`
 * allowlist the embed depends on.
 */
export const FRAME_CSP = [
  "default-src 'self'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${FRAME_ANCESTORS}`,
  "upgrade-insecure-requests",
].join("; ")
