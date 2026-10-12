/**
 * SweepCard plan binding (RA-02, High).
 *
 * The sweep plan used to be built from a snapshot but executed against
 * whatever network/destination state was live when the async reads
 * resolved — a slow RPC during Prepare could detach the plan from its
 * execution context. The fix snapshots the context, freezes the inputs
 * while preparing, and executes strictly from `plan.network` /
 * `plan.destination`. These tests drive the real component with the RPC
 * seam (`lib/ethers` provider helpers) mocked, and pin all three parts.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import SweepCard from "@/components/SweepCard"
import { Toaster } from "@/components/ui/Toast"
import { getBalanceWei, withProvider, withProviderOnce } from "@/lib/ethers"

/** Public Hardhat test accounts #0 (source) and #1 (destination). */
const SOURCE = {
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
}
const DESTINATION = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const FAKE_HASH = `0x${"ab".repeat(32)}`

vi.mock("@/lib/ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ethers")>()
  return {
    ...actual,
    getBalanceWei: vi.fn(),
    getTokenBalanceRaw: vi.fn(async () => ({ value: 0n, decimals: 18 })),
    withProvider: vi.fn(),
    withProviderOnce: vi.fn(),
  }
})

const balanceOf = vi.mocked(getBalanceWei)
const pooled = vi.mocked(withProvider)
const pooledOnce = vi.mocked(withProviderOnce)

/** Minimal duck-typed provider: fee data, estimates, and a broadcast stub. */
const fakeProvider = {
  getFeeData: async () => ({
    gasPrice: null,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }),
  estimateGas: async () => 21_000n,
  getNetwork: async () => ({ chainId: 8453n, name: "base" }),
  getTransactionCount: async () => 0,
  broadcastTransaction: async () => ({
    hash: FAKE_HASH,
    wait: async () => ({ status: 1 }),
  }),
}

function useProviderMocks(): void {
  pooled.mockImplementation(async (_network, fn) => fn(fakeProvider as never))
  pooledOnce.mockImplementation(async (_network, fn) => fn(fakeProvider as never))
}

function renderCard(): void {
  render(
    <>
      <Toaster />
      <SweepCard account={SOURCE} />
    </>
  )
}

function fillForm(network = "base", destination = DESTINATION): void {
  fireEvent.change(screen.getByLabelText(/Network/), { target: { value: network } })
  fireEvent.change(screen.getByLabelText(/Destination address/), {
    target: { value: destination },
  })
}

describe("SweepCard (RA-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProviderMocks()
    balanceOf.mockResolvedValue(1_000_000_000_000_000_000n) // 1 ETH
  })

  it("freezes the network and destination inputs while prepare is in flight", async () => {
    let releaseBalance: (value: bigint) => void = () => {}
    balanceOf.mockImplementationOnce(
      () =>
        new Promise<bigint>((resolve) => {
          releaseBalance = resolve
        })
    )

    renderCard()
    fillForm()
    fireEvent.click(screen.getByRole("button", { name: /Prepare sweep/ }))

    // While the (slow) balance read is outstanding, the two inputs that
    // define the plan's context cannot be changed underneath it.
    await waitFor(() => expect(screen.getByLabelText(/Network/)).toBeDisabled())
    expect(screen.getByLabelText(/Destination address/)).toBeDisabled()

    releaseBalance(1_000_000_000_000_000_000n)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Confirm sweep/ })).toBeInTheDocument()
    )

    // The reads were made against the snapshot network, not any later one.
    expect(balanceOf).toHaveBeenCalledWith(SOURCE.address, "base")
    expect(pooled.mock.calls.every(([network]) => network === "base")).toBe(true)
  })

  it("reviews a plan bound to the prepared network and destination", async () => {
    renderCard()
    fillForm("base")
    fireEvent.click(screen.getByRole("button", { name: /Prepare sweep/ }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Confirm sweep/ })).toBeInTheDocument()
    )
    // The review names the plan's network and destination.
    expect(screen.getAllByText(/Base/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(new RegExp(DESTINATION.slice(0, 10))).length).toBeGreaterThan(0)
  })

  it("executes strictly against the plan's network, never the form state", async () => {
    renderCard()
    fillForm("base")
    fireEvent.click(screen.getByRole("button", { name: /Prepare sweep/ }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Confirm sweep/ })).toBeInTheDocument()
    )

    balanceOf.mockClear()
    pooled.mockClear()
    pooledOnce.mockClear()

    fireEvent.click(screen.getByRole("button", { name: /Confirm sweep/ }))
    // The destructive-action confirmation (sonner) names the plan context.
    const sweepButton = await screen.findByRole("button", { name: "Sweep" })
    fireEvent.click(sweepButton)

    await waitFor(() => expect(screen.getByText(/Sweep complete/)).toBeInTheDocument())

    // Every execution-time read and the single broadcast used the plan's
    // network ("base") — the only network this test ever prepared.
    expect(balanceOf.mock.calls.every(([, network]) => network === "base")).toBe(true)
    expect(pooled.mock.calls.every(([network]) => network === "base")).toBe(true)
    expect(pooledOnce).toHaveBeenCalledTimes(1)
    expect(pooledOnce.mock.calls[0][0]).toBe("base")
  })
})
