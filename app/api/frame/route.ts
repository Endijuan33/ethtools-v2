import { FRAME_CSP } from "@/lib/csp"
import { buildFrameHtml, resolveSiteOrigin } from "@/lib/frameEmbed"

export const dynamic = "force-dynamic"

/**
 * Farcaster frame / Mini App embed document.
 *
 * The HTML is built by the pure helpers in `lib/frameEmbed.ts` and points at
 * the site's own origin — the configured `NEXT_PUBLIC_SITE_URL` when set,
 * otherwise the origin this request arrived on, otherwise the canonical
 * production origin — instead of a hardcoded production URL, so preview
 * deployments embed themselves rather than production.
 *
 * The response is publicly cacheable for five minutes, which is exactly why
 * it must not carry a per-request CSP nonce: middleware answers this route
 * with the static, nonce-free `FRAME_CSP`, and the same header is set here
 * as a second layer so the route stays safe even if the matcher changes.
 */
export async function GET(request: Request) {
  const requestOrigin = (() => {
    try {
      return new URL(request.url).origin
    } catch {
      return null
    }
  })()
  const origin = resolveSiteOrigin(process.env.NEXT_PUBLIC_SITE_URL, requestOrigin)

  return new Response(buildFrameHtml(origin), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": FRAME_CSP,
    },
  })
}
