"use client"

/**
 * "Change vault password" dialog. Presentational — the ceremony state and
 * handlers live in `WalletVault`; the dialog asks for the current password
 * as proof of possession before the vault is re-encrypted.
 */

import type { Dispatch, SetStateAction } from "react"
import { KeyRound } from "lucide-react"
import ResponsiveDialog from "../ui/ResponsiveDialog"
import Button from "../ui/Button"
import Field, { inputClassName, secretInputProps } from "../ui/Field"
import Alert from "../ui/Alert"
import type { PasswordStrength } from "./types"

export interface ChangePasswordDialogProps {
  showChangePassword: boolean
  closeChangePassword: () => void
  handleChangePassword: () => Promise<void>
  changePwBusy: boolean
  changePwError: string
  changePwCurrent: string
  setChangePwCurrent: Dispatch<SetStateAction<string>>
  changePwNext: string
  setChangePwNext: Dispatch<SetStateAction<string>>
  changePwConfirm: string
  setChangePwConfirm: Dispatch<SetStateAction<string>>
  setChangePwError: Dispatch<SetStateAction<string>>
  nextStrength: PasswordStrength
  passkeyEnrolled: boolean
}

export default function ChangePasswordDialog({
  showChangePassword,
  closeChangePassword,
  handleChangePassword,
  changePwBusy,
  changePwError,
  changePwCurrent,
  setChangePwCurrent,
  changePwNext,
  setChangePwNext,
  changePwConfirm,
  setChangePwConfirm,
  setChangePwError,
  nextStrength,
  passkeyEnrolled,
}: ChangePasswordDialogProps) {
  return (
      <ResponsiveDialog
        isOpen={showChangePassword}
        onClose={closeChangePassword}
        title="Change vault password"
        description="Re-encrypts this vault with a new password. The accounts inside it do not change."
        footer={
          <>
            <Button variant="secondary" onClick={closeChangePassword}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleChangePassword()}
              isLoading={changePwBusy}
              loadingLabel="Re-encrypting…"
              disabled={
                changePwCurrent === "" ||
                changePwNext === "" ||
                !nextStrength.acceptable ||
                changePwNext !== changePwConfirm
              }
              icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
            >
              Change password
            </Button>
          </>
        }
      >
        {/* Dialog-local errors: a card-level banner would sit behind the
            overlay and never be seen. */}
        {changePwError && <Alert tone="danger">{changePwError}</Alert>}

        <Alert tone="info" title="This re-encrypts the vault.">
          The new password encrypts everything in this vault on this device. If it is lost, only a
          backup (or your written-down recovery phrase) can recover the accounts.
        </Alert>

        <Field
          label="Current password"
          required
          hint="Typed to prove possession before the vault is re-encrypted, then discarded."
        >
          {(props) => (
            <input
              {...props}
              {...secretInputProps}
              type="password"
              value={changePwCurrent}
              onChange={(e) => {
                setChangePwCurrent(e.target.value)
                setChangePwError("")
              }}
              className={inputClassName}
            />
          )}
        </Field>

        <Field
          label="New password"
          required
          error={
            changePwNext !== "" && !nextStrength.acceptable ? nextStrength.issues[0] : undefined
          }
        >
          {(props) => (
            <input
              {...props}
              {...secretInputProps}
              type="password"
              value={changePwNext}
              onChange={(e) => {
                setChangePwNext(e.target.value)
                setChangePwError("")
              }}
              className={inputClassName}
            />
          )}
        </Field>

        <Field
          label="Confirm new password"
          required
          error={
            changePwConfirm !== "" && changePwNext !== changePwConfirm
              ? "The new passwords do not match."
              : undefined
          }
        >
          {(props) => (
            <input
              {...props}
              {...secretInputProps}
              type="password"
              value={changePwConfirm}
              onChange={(e) => {
                setChangePwConfirm(e.target.value)
                setChangePwError("")
              }}
              className={inputClassName}
            />
          )}
        </Field>

        {changePwNext !== "" && (
          <p className="text-xs text-muted-foreground">
            Strength: <span className="font-semibold">{nextStrength.label}</span>
          </p>
        )}

        {/*
          The user must know before confirming that the passkey flow is
          affected: a declined re-wrap prompt removes passkey unlock entirely
          rather than leaving an envelope that wraps the old password.
        */}
        {passkeyEnrolled && (
          <Alert tone="warning" title="Passkey unlock will be updated.">
            Your passkey envelope wraps the current password, so you will be asked to use the
            passkey once to re-wrap it around the new one. If that is declined or fails, passkey
            unlock is removed — your password always works, and you can set the passkey up again.
          </Alert>
        )}
      </ResponsiveDialog>
  )
}
