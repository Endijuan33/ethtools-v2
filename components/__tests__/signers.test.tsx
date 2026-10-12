/**
 * Standalone signer cards (RA-05).
 *
 * A pasted private key in these dev-tools signers used to live for the
 * whole tab session. The fix clears it after signing, after five idle
 * minutes, and whenever the vault locks. These tests pin all three
 * clearing paths against the real components — with the public Hardhat
 * test key, never a real one.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import MessageSignCard from "@/components/MessageSignCard"
import TypedDataSignCard from "@/components/TypedDataSignCard"
import { APP_EVENTS, emitAppEvent } from "@/lib/appEvents"
import { PASTED_KEY_INACTIVITY_MS } from "@/components/usePastedKeyLifecycle"

/** Public Hardhat test account #0 — test material, holds no real funds. */
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

const TYPED_DATA_JSON = JSON.stringify({
  domain: { name: "EthTools Test", version: "1", chainId: 1 },
  types: {
    Mail: [
      { name: "from", type: "address" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  message: { from: TEST_ADDRESS, contents: "Hello, EthTools!" },
})

function keyField(): HTMLInputElement {
  return screen.getByLabelText("Private key") as HTMLInputElement
}

describe("MessageSignCard pasted-key lifecycle (RA-05)", () => {
  it("clears the pasted key immediately after a successful sign", async () => {
    render(<MessageSignCard />)

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello, EthTools!" } })
    fireEvent.change(keyField(), { target: { value: TEST_PRIVATE_KEY } })
    expect(keyField().value).toBe(TEST_PRIVATE_KEY)

    fireEvent.click(screen.getByRole("button", { name: "Sign message" }))

    // The signature is produced (so the sign really ran) …
    await waitFor(() => expect(screen.getByText("Signer")).toBeInTheDocument())
    expect(screen.getByText(TEST_ADDRESS)).toBeInTheDocument()
    // … and the key is gone from the field the moment signing finished.
    expect(keyField().value).toBe("")
  })

  it("clears the pasted key when the vault locks (VAULT_LOCKED event)", () => {
    render(<MessageSignCard />)
    fireEvent.change(keyField(), { target: { value: TEST_PRIVATE_KEY } })
    expect(keyField().value).toBe(TEST_PRIVATE_KEY)

    act(() => {
      emitAppEvent(APP_EVENTS.VAULT_LOCKED)
    })

    expect(keyField().value).toBe("")
  })

  it("clears the pasted key after five idle minutes", () => {
    vi.useFakeTimers()
    try {
      render(<MessageSignCard />)
      fireEvent.change(keyField(), { target: { value: TEST_PRIVATE_KEY } })
      expect(keyField().value).toBe(TEST_PRIVATE_KEY)

      act(() => {
        vi.advanceTimersByTime(PASTED_KEY_INACTIVITY_MS - 1_000)
      })
      expect(keyField().value).toBe(TEST_PRIVATE_KEY)

      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(keyField().value).toBe("")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("TypedDataSignCard pasted-key lifecycle (RA-05)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("clears the pasted key immediately after a successful sign", async () => {
    render(<TypedDataSignCard />)

    fireEvent.change(screen.getByLabelText("EIP-712 payload"), {
      target: { value: TYPED_DATA_JSON },
    })
    fireEvent.change(keyField(), { target: { value: TEST_PRIVATE_KEY } })
    expect(keyField().value).toBe(TEST_PRIVATE_KEY)

    fireEvent.click(screen.getByRole("button", { name: "Sign typed data" }))

    await waitFor(() => expect(screen.getByText("Signer")).toBeInTheDocument())
    expect(screen.getByText(TEST_ADDRESS)).toBeInTheDocument()
    expect(keyField().value).toBe("")
  })

  it("clears the pasted key when the vault locks (VAULT_LOCKED event)", () => {
    render(<TypedDataSignCard />)
    fireEvent.change(keyField(), { target: { value: TEST_PRIVATE_KEY } })

    act(() => {
      emitAppEvent(APP_EVENTS.VAULT_LOCKED)
    })

    expect(keyField().value).toBe("")
  })
})
