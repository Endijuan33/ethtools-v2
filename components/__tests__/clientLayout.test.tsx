/**
 * ClientLayout Farcaster close fallback (RA-12).
 *
 * The fallback used to `window.postMessage({type: "farcaster:close"}, "*")`
 * — a wildcard post to the app's own window. It is now gated on a
 * detected Mini App context (as before) and posts to the parent frame
 * once per known host origin, with no wildcard anywhere. The SDK module
 * is mocked with a never-resolving import so the SDK handle stays null
 * and the fallback path — not `sdk.actions.close()` — is what runs.
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import ClientLayout from "@/app/client-layout"
import { FARCASTER_HOST_ORIGINS } from "@/lib/frameEmbed"

vi.mock("@farcaster/miniapp-sdk", async () => new Promise<never>(() => {}))

function stubUserAgent(value: string): void {
  Object.defineProperty(window.navigator, "userAgent", {
    value,
    configurable: true,
  })
}

describe("ClientLayout close fallback (RA-12)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders no close affordance and posts nothing outside a Mini App context", () => {
    const postSpy = vi.spyOn(window, "postMessage")
    render(
      <ClientLayout>
        <p>app body</p>
      </ClientLayout>
    )

    expect(screen.queryByRole("button", { name: "Close mini app" })).not.toBeInTheDocument()
    expect(postSpy).not.toHaveBeenCalled()
  })

  it("posts the close signal to the parent per known host origin, never to '*'", async () => {
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Warpcast/1.2.3")
    const postSpy = vi.spyOn(window, "postMessage")

    render(
      <ClientLayout>
        <p>app body</p>
      </ClientLayout>
    )

    const closeButton = await screen.findByRole("button", { name: "Close mini app" })
    fireEvent.click(closeButton)

    expect(postSpy).toHaveBeenCalledTimes(FARCASTER_HOST_ORIGINS.length)
    const targets = postSpy.mock.calls.map(([, targetOrigin]) => targetOrigin)
    expect(targets).toEqual([...FARCASTER_HOST_ORIGINS])
    expect(targets).not.toContain("*")
    for (const [message] of postSpy.mock.calls) {
      expect(message).toEqual({ type: "farcaster:close" })
    }
  })
})
