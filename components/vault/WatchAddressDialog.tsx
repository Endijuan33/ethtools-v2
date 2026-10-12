"use client"

/**
 * "Add watch address" dialog: track an address without storing any keys.
 * Presentational — the form state, validation values, and the submit
 * handler live in `WalletVault`.
 */

import type { Dispatch, SetStateAction } from "react"
import { Eye } from "lucide-react"
import ResponsiveDialog from "../ui/ResponsiveDialog"
import Button from "../ui/Button"
import Field, { inputClassName, monoInputClassName } from "../ui/Field"
import Alert from "../ui/Alert"
import Badge from "../ui/Badge"
import { isChecksummedAddress } from "@/lib/schema"

export interface WatchAddressDialogProps {
  showWatch: boolean
  setShowWatch: Dispatch<SetStateAction<boolean>>
  handleAddWatchAddress: () => Promise<void>
  busy: boolean
  watchError: string
  watchLabel: string
  setWatchLabel: Dispatch<SetStateAction<string>>
  watchAddressError: string | undefined
  watchAddressHint: string | undefined
  watchAddressValid: boolean
  watchAddress: string
  setWatchAddress: Dispatch<SetStateAction<string>>
  setWatchError: Dispatch<SetStateAction<string>>
  watchAddressTrimmed: string
}

export default function WatchAddressDialog({
  showWatch,
  setShowWatch,
  handleAddWatchAddress,
  busy,
  watchError,
  watchLabel,
  setWatchLabel,
  watchAddressError,
  watchAddressHint,
  watchAddressValid,
  watchAddress,
  setWatchAddress,
  setWatchError,
  watchAddressTrimmed,
}: WatchAddressDialogProps) {
  return (
      <ResponsiveDialog
        isOpen={showWatch}
        onClose={() => setShowWatch(false)}
        title="Add watch address"
        description="Track an address without storing any keys."
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowWatch(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleAddWatchAddress()}
              isLoading={busy}
              loadingLabel="Encrypting…"
              disabled={!watchAddressValid}
              icon={<Eye className="h-4 w-4" aria-hidden="true" />}
            >
              Add watch address
            </Button>
          </>
        }
      >
        {/* Dialog-local errors: a card-level banner would sit behind the
            overlay and never be seen. */}
        {watchError && <Alert tone="danger">{watchError}</Alert>}

        <Field label="Label" hint="Optional. Used only to recognize the address.">
          {(props) => (
            <input
              {...props}
              type="text"
              value={watchLabel}
              onChange={(e) => setWatchLabel(e.target.value)}
              placeholder="e.g., Hardware wallet"
              className={inputClassName}
            />
          )}
        </Field>

        {/* An address is public data, so this input gets no secret handling —
            but autocomplete is disabled because browser suggestion dropdowns
            have no business learning typed addresses. */}
        <Field
          label="Address"
          required
          error={watchAddressError}
          hint={watchAddressHint}
          action={
            watchAddressValid ? (
              <Badge tone="success">
                {isChecksummedAddress(watchAddressTrimmed) ? "Checksummed" : "Valid"}
              </Badge>
            ) : undefined
          }
        >
          {(props) => (
            <input
              {...props}
              type="text"
              value={watchAddress}
              onChange={(e) => {
                setWatchAddress(e.target.value)
                setWatchError("")
              }}
              placeholder="0x..."
              autoComplete="off"
              spellCheck={false}
              className={monoInputClassName}
            />
          )}
        </Field>

        <Alert tone="info" title="Observability only.">
          Only the address and label are stored — never a private key or recovery phrase — so
          nothing can be sent from a watch address here. Remove it at any time; there is nothing
          to back up for it.
        </Alert>
      </ResponsiveDialog>
  )
}
