"use client"

/**
 * "Set up passkey unlock" dialog. Presentational — the ceremony state and
 * handlers live in `WalletVault`; the dialog asks for the vault password
 * as proof of possession before enrollment.
 */

import type { Dispatch, SetStateAction } from "react"
import { Fingerprint } from "lucide-react"
import ResponsiveDialog from "../ui/ResponsiveDialog"
import Button from "../ui/Button"
import Field, { inputClassName, secretInputProps } from "../ui/Field"
import Alert from "../ui/Alert"

export interface PasskeyEnrollDialogProps {
  showPasskeyEnroll: boolean
  closePasskeyEnroll: () => void
  handlePasskeyEnroll: () => Promise<void>
  passkeyBusy: boolean
  passkeyPassword: string
  setPasskeyPassword: Dispatch<SetStateAction<string>>
  passkeyError: string
  setPasskeyError: Dispatch<SetStateAction<string>>
}

export default function PasskeyEnrollDialog({
  showPasskeyEnroll,
  closePasskeyEnroll,
  handlePasskeyEnroll,
  passkeyBusy,
  passkeyPassword,
  setPasskeyPassword,
  passkeyError,
  setPasskeyError,
}: PasskeyEnrollDialogProps) {
  return (
      <ResponsiveDialog
        isOpen={showPasskeyEnroll}
        onClose={closePasskeyEnroll}
        title="Set up passkey unlock"
        description="Optional, and experimental — your vault password always works."
        footer={
          <>
            <Button variant="secondary" onClick={closePasskeyEnroll}>
              Cancel
            </Button>
            <Button
              onClick={() => void handlePasskeyEnroll()}
              isLoading={passkeyBusy}
              loadingLabel="Waiting for passkey…"
              disabled={passkeyPassword === ""}
              icon={<Fingerprint className="h-4 w-4" aria-hidden="true" />}
            >
              Continue
            </Button>
          </>
        }
      >
        {/* Dialog-local errors: a card-level banner would sit behind the
            overlay and never be seen. */}
        {passkeyError && <Alert tone="danger">{passkeyError}</Alert>}

        <Alert tone="info" title="How this works.">
          Your vault password is encrypted with a key derived from this device&apos;s passkey
          and stored here. Unlocking with the passkey simply retrieves that password — the
          vault and its password stay exactly as they are today. Losing the passkey loses
          nothing: the password always unlocks the vault.
        </Alert>

        <Field
          label="Vault password"
          required
          hint="Typed once to confirm before the passkey is set up. It is never stored in the clear."
        >
          {(props) => (
            <input
              {...props}
              {...secretInputProps}
              type="password"
              value={passkeyPassword}
              onChange={(e) => {
                setPasskeyPassword(e.target.value)
                setPasskeyError("")
              }}
              className={inputClassName}
            />
          )}
        </Field>
      </ResponsiveDialog>
  )
}
