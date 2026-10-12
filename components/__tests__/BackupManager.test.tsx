/**
 * BackupManager erase + restore (RA-04, RA-03, RA-01 contract).
 *
 * RA-04: erase-all used to wipe only the app storage registry and leave
 * WalletConnect's own storage behind. RA-03: restoring an encrypted
 * backup used to report success without ever sealing the accounts/phrase
 * into the vault. These tests drive the real dialog: erase must call the
 * WalletConnect cleanup and fire the explicit `onErased` host signal, and
 * a restore into a device with no vault must create a vault that actually
 * opens with the restored account and phrase inside.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import BackupManager from "@/components/BackupManager"
import { Toaster } from "@/components/ui/Toast"
import { createEncryptedBackup, serializeBackup } from "@/lib/backup"
import { STORAGE_KEYS } from "@/lib/storage"
import { hasVault, unlockVault } from "@/lib/vaultStore"
import { eraseWalletConnectData } from "@/lib/walletConnect"

/** Public Hardhat test material — account #0 and its phrase. */
const PHRASE =
  "test test test test test test test test test test test junk"
const ACCOUNT = {
  id: "restored-1",
  label: "Restored account",
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  derivationIndex: 0,
}
const BACKUP_PASSWORD = "Backup-Password-9!"
const NEW_VAULT_PASSWORD = "New-Vault-Password-9!"

vi.mock("@/lib/walletConnect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/walletConnect")>()
  return {
    ...actual,
    eraseWalletConnectData: vi.fn(async () => ({ ok: true as const })),
  }
})

const wcErase = vi.mocked(eraseWalletConnectData)

function renderManager(props: Partial<React.ComponentProps<typeof BackupManager>> = {}): void {
  render(
    <>
      <Toaster />
      <BackupManager isOpen onClose={() => {}} {...props} />
    </>
  )
}

/** Confirm a sonner destructive-action prompt via the button inside the toast. */
async function confirmToast(label: string): Promise<void> {
  await waitFor(() => expect(document.querySelector("[data-sonner-toast]")).not.toBeNull())
  const toastEl = document.querySelector("[data-sonner-toast]") as HTMLElement
  fireEvent.click(within(toastEl).getByRole("button", { name: label }))
}

describe("BackupManager erase (RA-04)", () => {
  it("cleans WalletConnect storage, wipes the app registry, and signals onErased", async () => {
    localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify([{ id: "b1" }]))
    localStorage.setItem(STORAGE_KEYS.TOKENS, JSON.stringify([{ id: "t1" }]))
    const onErased = vi.fn()
    renderManager({ onErased })

    fireEvent.click(screen.getByRole("button", { name: /Erase all data/ }))
    fireEvent.click(screen.getByRole("button", { name: "Erase everything" }))
    await confirmToast("Erase everything")

    await waitFor(() => expect(onErased).toHaveBeenCalledTimes(1))
    expect(wcErase).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(STORAGE_KEYS.BOOKMARKS)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEYS.TOKENS)).toBeNull()
    expect(await screen.findByText("All data erased")).toBeInTheDocument()
  })
})

describe("BackupManager restore (RA-03)", () => {
  it(
    "seals a restored backup into a brand-new vault and verifies it by re-decryption",
    async () => {
      const backup = await createEncryptedBackup(
        { mnemonic: PHRASE, accounts: [ACCOUNT] },
        BACKUP_PASSWORD
      )
      if (!backup.ok) throw new Error(backup.error)
      const file = new File([serializeBackup(backup.value)], "ethtools-backup.json", {
        type: "application/json",
      })

      const onRestored = vi.fn()
      const onSecretsRestored = vi.fn()
      renderManager({ onRestored, onSecretsRestored })
      expect(hasVault()).toBe(false)

      fireEvent.click(screen.getByRole("button", { name: /Restore backup/ }))
      const fileInput = screen.getByLabelText(/Backup file/) as HTMLInputElement
      fireEvent.change(fileInput, { target: { files: [file] } })
      fireEvent.change(screen.getByLabelText(/Backup password/), {
        target: { value: BACKUP_PASSWORD },
      })
      fireEvent.click(screen.getByRole("button", { name: "Review backup" }))

      // Review shows what will be restored before anything is written.
      await waitFor(() => expect(screen.getByText("Recovery phrase included")).toBeInTheDocument())
      expect(screen.getByText("Yes")).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText(/New vault password/), {
        target: { value: NEW_VAULT_PASSWORD },
      })
      fireEvent.change(screen.getByLabelText(/Confirm vault password/), {
        target: { value: NEW_VAULT_PASSWORD },
      })
      fireEvent.click(screen.getByRole("button", { name: "Restore" }))

      await waitFor(() => expect(onSecretsRestored).toHaveBeenCalledTimes(1), { timeout: 20_000 })
      expect(onRestored).toHaveBeenCalledTimes(1)
      const sealedPayload = onSecretsRestored.mock.calls[0][0]
      expect(sealedPayload.accounts.map((a: { address: string }) => a.address)).toContain(
        ACCOUNT.address
      )

      // The vault on disk genuinely opens with the new password and holds
      // the restored phrase + account — the RA-03 failure mode was a
      // success report with nothing inside.
      expect(hasVault()).toBe(true)
      const opened = await unlockVault(NEW_VAULT_PASSWORD)
      if (!opened.ok) throw new Error(opened.error)
      expect(opened.value.mnemonic).toBe(PHRASE)
      expect(opened.value.accounts.map((a) => a.address)).toEqual([ACCOUNT.address])

      expect(
        await screen.findByText(/sealed into your encrypted vault and verified/)
      ).toBeInTheDocument()
    },
    30_000
  )
})
