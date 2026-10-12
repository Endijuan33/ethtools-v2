/**
 * WalletVault lifecycle (RA-01; AG-01).
 *
 * RA-01 was the re-audit's worst finding: erase-all wiped storage but
 * left an unlocked vault's decrypted payload alive in this component's
 * state, one vault-writing action away from resurrecting everything.
 * The create → lock → unlock cycle is pinned too, since every other
 * vault behavior hangs off those stage transitions.
 *
 * The WalletConnect panel is lazily loaded by the unlocked stage and is
 * not under test here; `next/dynamic` is stubbed to a no-op so the suite
 * stays about the vault itself.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import WalletVault from "@/components/WalletVault"
import { Toaster } from "@/components/ui/Toast"
import { STORAGE_KEYS } from "@/lib/storage"
import { hasVault } from "@/lib/vaultStore"

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}))

const VAULT_PASSWORD = "Correct-Horse-9!Battery"

function renderVault(): void {
  render(
    <>
      <Toaster />
      <WalletVault />
    </>
  )
}

/** Drive the real setup form: generate a phrase, acknowledge, set a password, create. */
async function createVaultThroughUi(): Promise<void> {
  await screen.findByText("Create your wallet")
  fireEvent.click(screen.getByRole("button", { name: "Generate recovery phrase" }))
  fireEvent.click(screen.getByLabelText(/I have written down my recovery phrase/))
  fireEvent.change(screen.getByLabelText(/Vault password/), { target: { value: VAULT_PASSWORD } })
  fireEvent.change(screen.getByLabelText(/Confirm password/), { target: { value: VAULT_PASSWORD } })
  fireEvent.click(screen.getByRole("button", { name: "Create encrypted wallet" }))
  await screen.findByText("Your accounts", undefined, { timeout: 20_000 })
}

describe("WalletVault", () => {
  it(
    "creates a vault, then locks and unlocks it with the same password",
    async () => {
      renderVault()
      await createVaultThroughUi()

      expect(hasVault()).toBe(true)
      expect(screen.getAllByText("Account 1").length).toBeGreaterThan(0)

      fireEvent.click(screen.getByRole("button", { name: "Lock" }))
      await screen.findByRole("button", { name: "Unlock" })
      expect(screen.queryByText("Your accounts")).not.toBeInTheDocument()

      fireEvent.change(screen.getByLabelText(/Vault password/), {
        target: { value: VAULT_PASSWORD },
      })
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }))

      await screen.findByText("Your accounts", undefined, { timeout: 20_000 })
      expect(screen.getAllByText("Account 1").length).toBeGreaterThan(0)
    },
    60_000
  )

  it(
    "erase-while-unlocked drops the in-memory session and returns to setup (RA-01)",
    async () => {
      renderVault()
      await createVaultThroughUi()
      expect(screen.getAllByText("Account 1").length).toBeGreaterThan(0)

      fireEvent.click(screen.getByRole("button", { name: "Backup and restore" }))
      fireEvent.click(await screen.findByRole("button", { name: /Erase all data/ }))
      fireEvent.click(screen.getByRole("button", { name: "Erase everything" }))

      await waitFor(() => expect(document.querySelector("[data-sonner-toast]")).not.toBeNull())
      const toastEl = document.querySelector("[data-sonner-toast]") as HTMLElement
      fireEvent.click(within(toastEl).getByRole("button", { name: "Erase everything" }))

      // The host resets: setup stage, no accounts, no vault on disk. A
      // surviving in-memory payload (the RA-01 bug) would keep
      // "Your accounts" on screen and could re-seal the vault later.
      await screen.findByText("Create your wallet", undefined, { timeout: 20_000 })
      expect(screen.queryByText("Your accounts")).not.toBeInTheDocument()
      expect(hasVault()).toBe(false)
      expect(localStorage.getItem(STORAGE_KEYS.VAULT)).toBeNull()
    },
    60_000
  )
})
