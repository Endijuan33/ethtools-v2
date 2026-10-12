/**
 * Next.js configuration.
 *
 * @type {import('next').NextConfig}
 */

/**
 * Static security headers.
 *
 * The Content-Security-Policy is deliberately NOT here: it is issued per
 * request by `middleware.ts`, because the production `script-src` carries a
 * fresh nonce that a static config header cannot express. Everything below
 * is request-independent and stays in the config.
 */
const securityHeaders = [
  {
    // App-level HSTS, equivalent to what the production platform adds at
    // the edge, so the policy is a property of the app rather than of one
    // hosting configuration. Two years, subdomains included, preload-ready.
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
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

  // Do not advertise the framework in a response header.
  poweredByHeader: false,

  images: {
    unoptimized: true,
  },

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
}

export default nextConfig
