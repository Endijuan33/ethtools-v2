/**
 * Farcaster frame-route content.
 *
 * Pure builders extracted from `app/api/frame/route.ts` so the embed payload
 * and the site-origin resolution can be unit-tested without a server. The
 * route handler is a thin adapter over these functions.
 */

/** Canonical production origin, used when nothing safer is configured. */
export const PRODUCTION_SITE_ORIGIN = "https://ethtools.vercel.app"

/** GitHub profile linked by the frame's second button. */
const GITHUB_URL = "https://github.com/endijuan33"

/**
 * Resolve the site origin the frame embed should point at.
 *
 * Priority mirrors the root layout's `metadataBase`: an explicit
 * `NEXT_PUBLIC_SITE_URL` wins, then the request's own origin (so preview
 * deployments describe themselves), then the canonical production origin.
 * A candidate is accepted only when it parses as an http(s) URL; anything
 * else falls through, so a malformed env value or a hostile `Origin` /
 * forwarded host can never smuggle another scheme into the embed.
 *
 * @param envSiteUrl - `NEXT_PUBLIC_SITE_URL`, when configured.
 * @param requestOrigin - Origin derived from the incoming request, if any.
 */
export function resolveSiteOrigin(
  envSiteUrl?: string | null,
  requestOrigin?: string | null
): string {
  for (const candidate of [envSiteUrl, requestOrigin]) {
    if (!candidate) continue
    try {
      const url = new URL(candidate)
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin
    } catch {
      // Not a URL at all: fall through to the next candidate.
    }
  }
  return PRODUCTION_SITE_ORIGIN
}

/** The `fc:miniapp` embed JSON for a site origin. */
export function buildMiniAppEmbed(origin: string): string {
  return JSON.stringify({
    version: "1",
    imageUrl: `${origin}/apple-icon.png`,
    buttons: [
      {
        title: "Open App",
        action: {
          type: "launch_miniapp",
          url: origin,
          name: "EthTools",
          splashImageUrl: `${origin}/apple-icon.png`,
          splashBackgroundColor: "#8B5CF6",
        },
      },
      {
        title: "GitHub",
        action: {
          type: "link",
          url: GITHUB_URL,
        },
      },
    ],
  })
}

/** The complete frame HTML document for a site origin. */
export function buildFrameHtml(origin: string): string {
  const miniappEmbed = buildMiniAppEmbed(origin)
  const icon = `${origin}/apple-icon.png`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EthTools MiniApp</title>

  <!-- Farcaster Mini App Embed (PRIMARY) -->
  <meta name="fc:miniapp" content='${miniappEmbed}' />

  <!-- Legacy Frames v1 Fallback (MUST use name, not property) -->
  <meta name="fc:frame" content="vNext" />
  <meta name="fc:frame:image" content="${icon}" />
  <meta name="fc:frame:image:aspect_ratio" content="1.91:1" />
  <meta name="fc:frame:button:1" content="Open App" />
  <meta name="fc:frame:button:1:action" content="link" />
  <meta name="fc:frame:button:1:target" content="${origin}" />
  <meta name="fc:frame:button:2" content="GitHub" />
  <meta name="fc:frame:button:2:action" content="link" />
  <meta name="fc:frame:button:2:target" content="${GITHUB_URL}" />

  <!-- OpenGraph (still uses property) -->
  <meta property="og:title" content="EthTools MiniApp" />
  <meta property="og:description" content="Tools for Ethereum users" />
  <meta property="og:image" content="${icon}" />
</head>
<body>
  <h1>Welcome to EthTools</h1>
  <p>Open this in Warpcast for the full Mini App experience.</p>
</body>
</html>`
}
