// @vitest-environment node
/**
 * Middleware behavior (AG-01; P1, P3).
 *
 * The CSP policies are pure and unit-tested in `lib/csp`; what was never
 * covered is this adapter: that a document request gets a fresh nonce
 * policy, that the frame route gets the static nonce-free policy, and
 * that the matcher no longer skips browser document prefetches (P1).
 */
import { NextRequest } from "next/server"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { FRAME_CSP } from "@/lib/csp"

// The middleware picks its policy from NODE_ENV at module load; the
// nonce behavior under test is the production one, so the module is
// imported only after the environment is pinned to production.
let middleware: typeof import("@/middleware").middleware
let config: typeof import("@/middleware").config

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production")
  vi.resetModules()
  const mod = await import("@/middleware")
  middleware = mod.middleware
  config = mod.config
})

function requestFor(path: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://ethtools.test${path}`, { headers })
}

describe("middleware", () => {
  it("issues a per-request nonce CSP for document routes", () => {
    const response = middleware(requestFor("/tools"))
    const csp = response.headers.get("Content-Security-Policy") ?? ""

    expect(csp).toContain("script-src 'self' 'nonce-")
    expect(csp).toContain("'strict-dynamic'")
    expect(csp).not.toContain("'unsafe-inline' 'nonce-")
    // The nonce is forwarded on the request headers Next reads back.
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy()
  })

  it("mints a different nonce for every request", () => {
    const first = middleware(requestFor("/")).headers.get("Content-Security-Policy")
    const second = middleware(requestFor("/")).headers.get("Content-Security-Policy")
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(first).not.toBe(second)
  })

  it("serves the static, nonce-free FRAME_CSP on the frame route (P3)", () => {
    const response = middleware(requestFor("/api/frame"))
    const csp = response.headers.get("Content-Security-Policy")

    expect(csp).toBe(FRAME_CSP)
    expect(csp).not.toContain("nonce-")
  })

  it("still applies the document CSP to browser document prefetches (P1)", () => {
    // A `purpose: prefetch` request is a document load in the making; the
    // response must carry the nonce policy like any other document.
    const response = middleware(requestFor("/", { purpose: "prefetch" }))
    const csp = response.headers.get("Content-Security-Policy") ?? ""
    expect(csp).toContain("'nonce-")
  })

  it("matcher excludes only router prefetches, never `purpose: prefetch` (P1)", () => {
    const matcher = config.matcher[0]
    expect(matcher.source).toContain("_next/static")
    const missingKeys = (matcher.missing ?? []).map((entry) => entry.key)
    expect(missingKeys).toContain("next-router-prefetch")
    expect(missingKeys).not.toContain("purpose")
    expect(JSON.stringify(config.matcher)).not.toContain("purpose")
  })
})
