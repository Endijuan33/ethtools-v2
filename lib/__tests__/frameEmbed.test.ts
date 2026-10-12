/**
 * P6: the frame embed follows the site's own origin instead of a hardcoded
 * production URL, with a safe canonical fallback.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  FARCASTER_HOST_ORIGINS,
  MINIAPP_CLOSE_MESSAGE,
  PRODUCTION_SITE_ORIGIN,
  buildFrameHtml,
  buildMiniAppEmbed,
  postMiniAppClose,
  resolveSiteOrigin,
} from "../frameEmbed"

test("origin resolution prefers the configured site URL", () => {
  assert.equal(
    resolveSiteOrigin("https://preview.example.com", "https://other.example.com"),
    "https://preview.example.com"
  )
})

test("origin resolution falls back to the request origin, then production", () => {
  assert.equal(resolveSiteOrigin(undefined, "https://preview.example.com"), "https://preview.example.com")
  assert.equal(resolveSiteOrigin(null, null), PRODUCTION_SITE_ORIGIN)
  assert.equal(resolveSiteOrigin("", ""), PRODUCTION_SITE_ORIGIN)
})

test("hostile or malformed origins never reach the embed", () => {
  assert.equal(resolveSiteOrigin("javascript:alert(1)", null), PRODUCTION_SITE_ORIGIN)
  assert.equal(resolveSiteOrigin("not a url", "also not a url"), PRODUCTION_SITE_ORIGIN)
  assert.equal(
    resolveSiteOrigin("ftp://example.com", null),
    PRODUCTION_SITE_ORIGIN,
    "non-http(s) schemes are rejected"
  )
  // A path on a valid origin is stripped to the origin itself.
  assert.equal(resolveSiteOrigin("https://example.com/some/path?x=1", null), "https://example.com")
})

test("the embed and HTML use the resolved origin everywhere", () => {
  const origin = "https://preview.example.com"
  const embed = JSON.parse(buildMiniAppEmbed(origin)) as {
    imageUrl: string
    buttons: Array<{ action: { url?: string; splashImageUrl?: string } }>
  }
  assert.equal(embed.imageUrl, `${origin}/apple-icon.png`)
  assert.equal(embed.buttons[0].action.url, origin)
  assert.equal(embed.buttons[0].action.splashImageUrl, `${origin}/apple-icon.png`)

  const html = buildFrameHtml(origin)
  assert.ok(html.includes(`content="${origin}/apple-icon.png"`))
  assert.equal(html.includes("ethtools.vercel.app"), false, "no hardcoded production origin remains")
})

// ===== RA-12: targeted close signal, no wildcard =====

test("host origins are explicit https origins with no wildcard anywhere", () => {
  assert.ok(FARCASTER_HOST_ORIGINS.length >= 3)
  for (const origin of FARCASTER_HOST_ORIGINS) {
    assert.equal(origin.includes("*"), false, `wildcard in ${origin}`)
    const url = new URL(origin)
    assert.equal(url.protocol, "https:")
    assert.equal(url.origin, origin, "entries are bare origins")
  }
  // The deliverable set covers the hosts the CSP frame-ancestors names.
  assert.ok(FARCASTER_HOST_ORIGINS.includes("https://warpcast.com"))
  assert.ok(FARCASTER_HOST_ORIGINS.includes("https://farcaster.xyz"))
  assert.ok(FARCASTER_HOST_ORIGINS.includes("https://base.org"))
})

test("postMiniAppClose posts the close signal to the parent once per host origin", () => {
  const calls: Array<{ message: unknown; targetOrigin: string }> = []
  const fakeWindow = {
    parent: {
      postMessage: (message: unknown, targetOrigin: string) => {
        calls.push({ message, targetOrigin })
      },
    },
  }

  const posted = postMiniAppClose(fakeWindow)

  assert.equal(posted, FARCASTER_HOST_ORIGINS.length)
  assert.deepEqual(
    calls.map((c) => c.targetOrigin),
    [...FARCASTER_HOST_ORIGINS]
  )
  assert.ok(calls.every((c) => c.targetOrigin !== "*"), "no wildcard target is ever used")
  for (const call of calls) {
    assert.deepEqual(call.message, { ...MINIAPP_CLOSE_MESSAGE })
    assert.deepEqual(call.message, { type: "farcaster:close" })
  }
})

test("postMiniAppClose addresses the parent, never the window itself", () => {
  let selfCalled = false
  const parentCalls: string[] = []
  const fakeWindow = {
    postMessage: () => {
      selfCalled = true
    },
    parent: {
      postMessage: (_message: unknown, targetOrigin: string) => {
        parentCalls.push(targetOrigin)
      },
    },
  }

  postMiniAppClose(fakeWindow)

  assert.equal(selfCalled, false)
  assert.equal(parentCalls.length, FARCASTER_HOST_ORIGINS.length)
})
