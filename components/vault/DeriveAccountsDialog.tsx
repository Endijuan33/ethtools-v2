"use client"

/**
 * "Add accounts" dialog: derive more accounts from the recovery phrase
 * already in the vault. Presentational — the open state, the vault
 * payload, and the import handler live in `WalletVault`.
 */

import type { Dispatch, SetStateAction } from "react"
import ResponsiveDialog from "../ui/ResponsiveDialog"
import Alert from "../ui/Alert"
import AccountDiscovery from "../AccountDiscovery"
import type { VaultAccount, VaultPayload } from "@/lib/schema"

export interface DeriveAccountsDialogProps {
  showDerive: boolean
  setShowDerive: Dispatch<SetStateAction<boolean>>
  payload: VaultPayload | null
  handleImportDerived: (derived: VaultAccount[]) => Promise<void>
}

export default function DeriveAccountsDialog({
  showDerive,
  setShowDerive,
  payload,
  handleImportDerived,
}: DeriveAccountsDialogProps) {
  return (
      <ResponsiveDialog
        isOpen={showDerive}
        onClose={() => setShowDerive(false)}
        title="Add accounts"
        description="Derive more accounts from the recovery phrase already in this vault."
        size="lg"
      >
        {payload?.mnemonic ? (
          <AccountDiscovery
            mnemonic={payload.mnemonic}
            passphrase={payload.mnemonicPassphrase}
            existingAddresses={payload.accounts.map((a) => a.address)}
            onCancel={() => setShowDerive(false)}
            onImport={(derived) =>
              void handleImportDerived(
                derived.map((account) => ({
                  id: crypto.randomUUID?.() ?? `account-${account.index}-${Date.now()}`,
                  label: `Account ${account.index + 1}`,
                  address: account.address,
                  privateKey: account.privateKey,
                  derivationIndex: account.index,
                  derivationPath: account.path,
                }))
              )
            }
          />
        ) : (
          <Alert tone="warning">
            This vault has no recovery phrase, so accounts cannot be derived. It was created from
            an imported private key.
          </Alert>
        )}
      </ResponsiveDialog>
  )
}
