// @vitest-environment node
/**
 * `/api/frame` route handler (AG-01; P3, P6).
 *
 * Pins the route-level contract the re-audit called out: the embed
 * document is publicly cacheable and nonce-free (a cached per-request
 * nonce would be replayed to every visitor), and the embed origin
 * follows the request instead of a hardcoded production URL.
 */
import { describe, expect, it } from "vitest"
import { GET } from "@/app/api/frame/route"
import { FRAME_CSP } from "@/lib/csp"

describe("GET /api/frame", () => {
  it("returns 200 HTML with the static nonce-free CSP and a 5-minute cache", async () => {
    const response = await GET(new Request("https://preview.example.com/api/frame"))

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("text/html")
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300")

    const csp = response.headers.get("Content-Security-Policy")
    expect(csp).toBe(FRAME_CSP)
    expect(csp).not.toContain("nonce-")
  })

  it("embeds the origin the request arrived on, not production (P6)", async () => {
    const response = await GET(new Request("https://preview.example.com/api/frame"))
    const html = await response.text()

    expect(html).toContain("https://preview.example.com")
    expect(html).not.toContain("ethtools.vercel.app")
  })

  it("produces identical, cacheable bytes for repeat requests", async () => {
    const first = await GET(new Request("https://ethtools.example/api/frame"))
    const second = await GET(new Request("https://ethtools.example/api/frame"))
    expect(await first.text()).toBe(await second.text())
  })
})
