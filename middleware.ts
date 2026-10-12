import { NextRequest, NextResponse } from "next/server"
import { FRAME_CSP, buildDocumentCsp, isFrameRoute } from "./lib/csp"

/**
 * Content-Security-Policy, issued per request from middleware.
 *
 * The policies themselves are built by the pure helpers in `lib/csp.ts`
 * (unit-tested there); this adapter only mints the nonce, picks the policy
 * for the route, and sets the headers. See `lib/csp.ts` for the rationale
 * behind every directive.
 *
 * The Farcaster frame route is the one exception to per-request nonces: its
 * HTML is identical for every visitor and publicly cacheable, so it receives
 * the static, nonce-free {@link FRAME_CSP} instead. A cacheable nonce would
 * be replayed to every visitor and protects a page that runs no scripts.
 */

const isDevelopment = process.env.NODE_ENV !== "production"

export function middleware(request: NextRequest): NextResponse {
  if (isFrameRoute(request.nextUrl.pathname)) {
    const response = NextResponse.next()
    response.headers.set("Content-Security-Policy", FRAME_CSP)
    return response
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const contentSecurityPolicy = buildDocumentCsp(nonce, isDevelopment)

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
       * Router prefetch requests are skipped per the Next.js CSP guide:
       * they are not full document loads and re-running the middleware for
       * them would mint nonces nothing consumes.
       *
       * Only `next-router-prefetch` marks a router prefetch. An earlier
       * revision also excluded requests carrying `purpose: prefetch`, but
       * that header is sent by browsers for plain document prefetches that
       * DO become full document loads — those responses went out with no
       * CSP at all. They now run through the middleware like any other
       * document request.
       */
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
}
