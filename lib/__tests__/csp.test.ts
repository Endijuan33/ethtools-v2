/**
 * AG-01: middleware/CSP coverage through the extracted pure builders, plus
 * structural guards on the middleware adapter itself (frame-route branch,
 * P1 matcher).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FRAME_CSP, buildDocumentCsp, isFrameRoute } from "../csp"

const REPO_ROOT = join(__dirname, "..", "..")
const NONCE = "test-nonce-abc123"

test("the document policy is nonce-based with strict-dynamic and no unsafe-inline script", () => {
  const csp = buildDocumentCsp(NONCE, false)
  assert.ok(csp.includes(`script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`))
  assert.equal(csp.includes("'unsafe-inline' 'unsafe-eval'"), false)
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src must not allow inline")
  assert.ok(csp.includes("object-src 'none'"))
  assert.ok(csp.includes("frame-ancestors 'self' https://warpcast.com"))
  assert.ok(csp.includes("upgrade-insecure-requests"))
})

test("the development policy keeps the dev-server relaxations and drops upgrade-insecure-requests", () => {
  const csp = buildDocumentCsp(NONCE, true)
  assert.ok(csp.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval'"))
  assert.ok(csp.includes("ws://localhost:*"))
  assert.equal(csp.includes("upgrade-insecure-requests"), false)
  assert.equal(csp.includes("strict-dynamic"), false)
})

test("the frame policy carries no nonce and keeps the embed allowlist (P3)", () => {
  assert.equal(FRAME_CSP.includes("nonce"), false)
  assert.ok(FRAME_CSP.includes("script-src 'none'"))
  assert.ok(FRAME_CSP.includes("frame-ancestors 'self' https://warpcast.com"))
  assert.ok(FRAME_CSP.includes("https://*.farcaster.xyz"))
})

test("only /api/frame is the frame route", () => {
  assert.equal(isFrameRoute("/api/frame"), true)
  assert.equal(isFrameRoute("/"), false)
  assert.equal(isFrameRoute("/api/frame/extra"), false)
})

test("middleware branches the frame route to the nonce-free policy", () => {
  const source = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf8")
  assert.ok(source.includes("isFrameRoute(request.nextUrl.pathname)"))
  assert.ok(source.includes("FRAME_CSP"))
})

test("the matcher no longer excludes purpose:prefetch documents (P1)", () => {
  const source = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf8")
  assert.ok(source.includes('{ type: "header", key: "next-router-prefetch" }'))
  assert.equal(source.includes('key: "purpose"'), false)
})
