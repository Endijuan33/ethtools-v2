/**
 * P6: the frame embed follows the site's own origin instead of a hardcoded
 * production URL, with a safe canonical fallback.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  PRODUCTION_SITE_ORIGIN,
  buildFrameHtml,
  buildMiniAppEmbed,
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
