"use client"

/**
 * Vault locked stage: password (or passkey) unlock, plus the entry point
 * to restore-from-backup.
 *
 * Presentational half of the stage — all state and handlers live in
 * `WalletVault` and arrive here as props under their original names. The
 * backup dialog itself is passed in as `backupManager`, rendered by the
 * parent in the same tree position it occupied before the split.
 */

import type { Dispatch, ReactNode, SetStateAction } from "react"
import { FileJson, Fingerprint, Lock, LockOpen } from "lucide-react"
import Button from "../ui/Button"
import { CardDescription, CardHeader, CardTitle } from "../ui/Card"
import Badge from "../ui/Badge"
import Field, { inputClassName, secretInputProps } from "../ui/Field"

export interface VaultLockedProps {
  banners: ReactNode
  passkeyEnrolled: boolean
  handleUnlockWithPasskey: () => Promise<void>
  passkeyBusy: boolean
  password: string
  setPassword: Dispatch<SetStateAction<string>>
  handleUnlock: () => Promise<void>
  busy: boolean
  setShowBackup: Dispatch<SetStateAction<boolean>>
  backupManager: ReactNode
}

export default function VaultLocked({
  banners,
  passkeyEnrolled,
  handleUnlockWithPasskey,
  passkeyBusy,
  password,
  setPassword,
  handleUnlock,
  busy,
  setShowBackup,
  backupManager,
}: VaultLockedProps) {
  return (
    <>
        <CardHeader className="flex-col items-center text-center">
          <span
            className="mb-1 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/25 bg-gradient-to-b from-primary/15 to-transparent text-primary shadow-glow-sm"
            aria-hidden="true"
          >
            <Lock className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <CardTitle>Wallet locked</CardTitle>
            <CardDescription>
              Enter your vault password to decrypt your accounts on this device.
            </CardDescription>
          </div>
          <Badge tone="success" dot>
            Encrypted
          </Badge>
        </CardHeader>
        {banners}

        <div className="space-y-4">
          {/*
            Offered only when an envelope exists — enrollment implies this
            browser created it. A ceremony that fails (wrong browser state,
            cancelled prompt) falls back to the password field right below.
          */}
          {passkeyEnrolled && (
            <>
              <Button
                variant="outline"
                onClick={() => void handleUnlockWithPasskey()}
                isLoading={passkeyBusy}
                loadingLabel="Waiting for passkey…"
                fullWidth
                icon={<Fingerprint className="h-4 w-4" aria-hidden="true" />}
              >
                Unlock with passkey
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                or unlock with your password
              </p>
            </>
          )}

          <Field label="Vault password" required>
            {(props) => (
              <input
                {...props}
                {...secretInputProps}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleUnlock()
                }}
                className={inputClassName}
              />
            )}
          </Field>

          <Button
            onClick={handleUnlock}
            isLoading={busy}
            loadingLabel="Unlocking…"
            fullWidth
            disabled={password === ""}
            icon={<LockOpen className="h-4 w-4" aria-hidden="true" />}
          >
            Unlock
          </Button>

          <Button
            variant="ghost"
            onClick={() => setShowBackup(true)}
            fullWidth
            icon={<FileJson className="h-4 w-4" aria-hidden="true" />}
          >
            Restore from backup
          </Button>
        </div>

        {backupManager}
    </>
  )
}
