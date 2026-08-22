/**
 * Next.js configuration.
 *
 * @type {import('next').NextConfig}
 */

const isDevelopment = process.env.NODE_ENV !== "production"

/**
 * Content-Security-Policy directives.
 *
 * The development and production policies genuinely differ, and conflating them
 * breaks the app: Next's dev server evaluates every module through `eval()` (181
 * call sites in the dev `main-app` chunk alone) and drives Fast Refresh over a
 * plaintext `ws://` socket. A policy without `'unsafe-eval'` therefore blocks all
 * script evaluation, so React never hydrates — dynamic panels sit on their
 * loading spinner forever and no event handler is ever attached.
 *
 * Neither relaxation is shipped to production, where the bundle is pre-compiled
 * and needs no `eval`.
 *
 * Two notes on the production policy:
 * - `'unsafe-inline'` is still required for Next's inline bootstrap scripts.
 *   Removing it needs a nonce threaded through the document, which is the right
 *   next step but a larger change.
 * - `connect-src` cannot be a fixed host list because users add their own RPC
 *   endpoints at runtime. Restricting it to `https:`/`wss:` still blocks a
 *   plaintext or `data:` exfiltration channel.
 */
function buildContentSecurityPolicy() {
  const scriptSrc = ["'self'", "'unsafe-inline'"]
  const connectSrc = ["'self'", "https:", "wss:"]

  if (isDevelopment) {
    // Required by webpack's dev module evaluation and by React Refresh.
    scriptSrc.push("'unsafe-eval'")
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
    // An allowlist rather than DENY: this app is meant to be embedded by
    // Farcaster Mini App clients, and DENY would break that while leaving it
    // open to every other embedder.
    "frame-ancestors 'self' https://warpcast.com https://*.warpcast.com https://farcaster.xyz https://*.farcaster.xyz https://base.org https://*.base.org",
  ]

  // Upgrading requests would rewrite http://localhost during development.
  if (!isDevelopment) directives.push("upgrade-insecure-requests")

  return directives.join("; ")
}

const securityHeaders = [
  { key: "Content-Security-Policy", value: buildContentSecurityPolicy() },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    // The app needs none of these capabilities; denying them shrinks the surface
    // available to any injected script.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
]

const nextConfig = {
  reactStrictMode: true,

  images: {
    unoptimized: true,
  },

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
}

export default nextConfig
