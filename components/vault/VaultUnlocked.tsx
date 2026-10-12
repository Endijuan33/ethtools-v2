"use client"

/**
 * Vault unlocked stage: the account list, the active account's cards and
 * secrets, and the device-local security rows (auto-lock, passkey,
 * password change — the dialogs themselves are sibling components).
 *
 * Presentational half of the stage — all state and handlers live in
 * `WalletVault` and arrive here as props under their original names, so
 * this component owns no state and no side effects.
 */

import type { Dispatch, ReactNode, SetStateAction } from "react"
import dynamic from "next/dynamic"
import {
  Eye,
  FileJson,
  Fingerprint,
  KeyRound,
  Lock,
  LockOpen,
  Plus,
  ShieldCheck,
  Trash2,
  Wallet,
} from "lucide-react"
import Button from "../ui/Button"
import { CardHeader, CardTitle } from "../ui/Card"
import Badge from "../ui/Badge"
import Alert from "../ui/Alert"
import SecretField from "../ui/SecretField"
import CopyButton from "../ui/CopyButton"
import { EmptyState, Spinner } from "../ui/Feedback"
import { cn } from "@/lib/utils"
import PortfolioCard from "../PortfolioCard"
import TokenDiscoveryCard from "../TokenDiscoveryCard"
import ApprovalManagerCard from "../ApprovalManagerCard"
import VaultSignCard from "../VaultSignCard"
import SweepCard from "../SweepCard"
import WatchBalanceNotifier from "../WatchBalanceNotifier"
import { truncateHex } from "@/lib/format"
import {
  AUTOLOCK_MINUTES_CHOICES,
  type AutoLockMinutes,
  type VaultAccount,
  type VaultPayload,
} from "@/lib/schema"

/*
 * The WalletConnect panel pulls in the Reown SDK (relay + websocket code,
 * a meaningful chunk). Code-splitting it keeps that cost off the vault bundle
 * until the panel is actually rendered.
 */
const WalletConnectPanel = dynamic(() => import("../WalletConnectPanel"), {
  ssr: false,
  loading: () => <Spinner label="Loading WalletConnect…" />,
})

export interface VaultUnlockedProps {
  banners: ReactNode
  payload: VaultPayload | null
  activeAccount: VaultAccount | null
  setActiveId: Dispatch<SetStateAction<string | null>>
  setActiveAccountId: (id: string | null) => void
  handleRemove: (accountId: string) => Promise<void>
  lock: (reason?: string) => void
  setShowBackup: Dispatch<SetStateAction<boolean>>
  setShowDerive: Dispatch<SetStateAction<boolean>>
  setShowWatch: Dispatch<SetStateAction<boolean>>
  autolockMinutes: AutoLockMinutes
  handleAutolockChange: (minutes: AutoLockMinutes) => void
  passkeyEnrolled: boolean
  passkeySupported: boolean
  handlePasskeyRemove: () => Promise<void>
  setShowPasskeyEnroll: Dispatch<SetStateAction<boolean>>
  setShowChangePassword: Dispatch<SetStateAction<boolean>>
}

export default function VaultUnlocked({
  banners,
  payload,
  activeAccount,
  setActiveId,
  setActiveAccountId,
  handleRemove,
  lock,
  setShowBackup,
  setShowDerive,
  setShowWatch,
  autolockMinutes,
  handleAutolockChange,
  passkeyEnrolled,
  passkeySupported,
  handlePasskeyRemove,
  setShowPasskeyEnroll,
  setShowChangePassword,
}: VaultUnlockedProps) {
  return (
    <>
      <CardHeader>
        <div className="flex items-center gap-2">
          <LockOpen className="h-5 w-5 text-success" aria-hidden="true" />
          <CardTitle>Your accounts</CardTitle>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowBackup(true)}
            aria-label="Backup and restore"
            title="Backup and restore"
          >
            <FileJson className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => lock("Wallet locked.")}
            icon={<Lock className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Lock
          </Button>
        </div>
      </CardHeader>

      {banners}

      {payload && payload.accounts.length === 0 ? (
        <EmptyState
          icon={<Wallet className="h-5 w-5" />}
          title="No accounts in this vault"
          description="Derive accounts from your recovery phrase to get started."
          action={
            payload.mnemonic ? (
              <Button onClick={() => setShowDerive(true)}>Derive accounts</Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {payload?.accounts.map((account) => {
            const isActive = account.id === activeAccount?.id
            return (
              <li
                key={account.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border p-3 transition-colors",
                  isActive
                    ? "border-primary/40 bg-primary/10"
                    : "border-border bg-muted/30 hover:bg-muted/50"
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveId(account.id)
                    setActiveAccountId(account.id)
                  }}
                  aria-current={isActive}
                  className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {account.label}
                    </span>
                    {isActive && <Badge tone="primary">Active</Badge>}
                    {account.watchOnly && (
                      <Badge tone="info">
                        <Eye className="h-3 w-3" aria-hidden="true" />
                        Watch
                      </Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                    {truncateHex(account.address, 10, 8)}
                  </span>
                  {account.derivationPath && (
                    <span className="block font-mono text-xs text-muted-foreground/70">
                      {account.derivationPath}
                    </span>
                  )}
                </button>
                <CopyButton value={account.address} label="address" />
                {payload.accounts.length > 1 && (
                  <button
                    type="button"
                    onClick={() => void handleRemove(account.id)}
                    aria-label={`Remove ${account.label}`}
                    className="shrink-0 rounded-lg p-2 text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {payload && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          {payload.mnemonic && payload.accounts.length > 0 && (
            <Button
              variant="outline"
              onClick={() => setShowDerive(true)}
              className="flex-1"
              icon={<Plus className="h-4 w-4" aria-hidden="true" />}
            >
              Add accounts from recovery phrase
            </Button>
          )}
          {/* Offered even for key-only vaults: a watch address needs no secret. */}
          <Button
            variant="outline"
            onClick={() => setShowWatch(true)}
            className="flex-1"
            icon={<Eye className="h-4 w-4" aria-hidden="true" />}
          >
            Add watch address
          </Button>
        </div>
      )}

      {activeAccount && (
        <div className="mt-5 space-y-4 border-t border-border pt-4">
          <div>
            <p className="mb-1.5 text-sm font-medium text-foreground">Address</p>
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-sm text-success">
                {activeAccount.address}
              </p>
              <CopyButton value={activeAccount.address} label="address" />
            </div>
          </div>

          {/*
            Portfolio overview for the active account. Keyed by address so
            switching accounts remounts it with a clean fetch: balances belong
            to an address, and showing the previous account's figures under a
            newly selected one would be misleading. The card consumes the
            public address only — no secret crosses this boundary, which is why
            it serves watch-only accounts identically.
          */}
          <PortfolioCard
            key={`portfolio-${activeAccount.address}`}
            address={activeAccount.address}
            label={activeAccount.label}
            watchOnly={activeAccount.watchOnly}
          />

          {/*
            Token discovery for the active account. Keyed by address like the
            portfolio card so switching accounts resets its state, and mounted
            for every account: detection needs only the public address, so
            watch-only accounts get it identically. The scan runs only when the
            user asks — the address is sent to public explorer APIs, which must
            be an explicit choice, never an automatic one.
          */}
          <TokenDiscoveryCard
            key={`token-discovery-${activeAccount.address}`}
            address={activeAccount.address}
            watchOnly={activeAccount.watchOnly}
          />

          {/*
            Allowance manager for the active account. The scan needs only the
            public address (so watch-only accounts see their approvals too);
            revoking spends gas, which requires the key — the card explains
            that honestly for watch-only accounts instead of hiding the gap.
          */}
          <ApprovalManagerCard
            key={`allowances-${activeAccount.address}`}
            address={activeAccount.address}
            privateKey={activeAccount.privateKey ?? undefined}
            watchOnly={activeAccount.watchOnly}
          />

          {/*
            Sign with the vault account — message and typed data — without
            ever pasting a key. This closes the last surface in the app where
            a key had to be typed by hand: the dev-tools signers still accept
            pasted keys for arbitrary use, but the user's own account never
            needs one here. Keyed by address; a stale card wired to the
            previous key would be a signing hazard.
          */}
          {activeAccount.privateKey && !activeAccount.watchOnly && (
            <VaultSignCard
              key={`vault-sign-${activeAccount.address}`}
              account={{
                address: activeAccount.address,
                privateKey: activeAccount.privateKey,
              }}
              label={activeAccount.label}
            />
          )}

          {/*
            Balance watcher for the active account: a quiet poll that toasts
            when the balance moves. Works for watch-only accounts too — it
            only ever reads the public balance. Keyed by address so a network
            switch or account switch always starts from a fresh baseline.
          */}
          <WatchBalanceNotifier
            key={`watcher-${activeAccount.address}`}
            address={activeAccount.address}
            label={activeAccount.label}
          />

          {/*
            Account sweep — moving every asset of this account to one
            destination — is a key-holding action by definition; watch-only
            accounts get the honest absence instead of a dead button.
          */}
          {activeAccount.privateKey && !activeAccount.watchOnly && (
            <SweepCard
              key={`sweep-${activeAccount.address}`}
              account={{
                address: activeAccount.address,
                privateKey: activeAccount.privateKey,
              }}
            />
          )}

          {/*
            Wallet-side dApp connections for the active account. Keyed by
            address like the portfolio card: a session's pending requests and
            signing keys belong to one account, and a stale panel wired to the
            previous key would be a signing hazard, not just a display bug.
            The key crosses this boundary only to sign locally — everything
            sent back to the dApp is a signature, never the key.
          */}
          {activeAccount.privateKey && !activeAccount.watchOnly && (
            <WalletConnectPanel
              key={`walletconnect-${activeAccount.address}`}
              account={{
                address: activeAccount.address,
                privateKey: activeAccount.privateKey,
              }}
            />
          )}

          {activeAccount.watchOnly ? (
            /* No secret exists to show for a watch-only address, and rendering
               the vault's recovery phrase here would wrongly imply the address
               is derived from it. */
            <Alert tone="info" title="Watch-only address.">
              This account is observability-only: no private key or recovery phrase is or can be
              stored for it, so nothing can ever be sent from it here. Reading balances and
              history needs only the address.
            </Alert>
          ) : (
            <>
              {activeAccount.privateKey && (
                <SecretField label="Private key" value={activeAccount.privateKey} allowCopy />
              )}

              {payload?.mnemonic && (
                <SecretField
                  label="Recovery phrase"
                  value={payload.mnemonic}
                  variant="phrase"
                  allowCopy
                />
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-1.5 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Encrypted at rest. Locks automatically after</span>
        {/* Inline on purpose: the control belongs to the sentence it completes. */}
        <select
          value={autolockMinutes}
          onChange={(e) => handleAutolockChange(Number(e.target.value) as AutoLockMinutes)}
          aria-label="Auto-lock timeout"
          className="h-7 rounded-md border border-input bg-background/60 px-1.5 font-medium text-foreground transition-colors hover:border-input/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {AUTOLOCK_MINUTES_CHOICES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} minute{minutes === 1 ? "" : "s"}
            </option>
          ))}
        </select>
        <span>of inactivity.</span>
      </div>

      {/*
        Passkey unlock (experimental), placed beside the auto-lock control
        because both are device-local security preferences. The enroll control
        is gated on capability detection so unsupported browsers never see an
        offer they cannot complete; an enrolled passkey always leaves the
        password path fully available.
      */}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <Fingerprint className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Passkey unlock</span>
        <Badge tone="warning">Experimental</Badge>
        {/* Spacer pushing the state controls to the right on wide screens. */}
        <span className="min-w-0 flex-1" aria-hidden="true" />
        {passkeyEnrolled ? (
          <>
            <Badge tone="success" dot>
              Enabled
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => void handlePasskeyRemove()}>
              Remove
            </Button>
          </>
        ) : passkeySupported ? (
          <Button variant="ghost" size="sm" onClick={() => setShowPasskeyEnroll(true)}>
            Set up
          </Button>
        ) : (
          <span className="text-muted-foreground/70">Not available in this browser</span>
        )}
      </div>

      {/*
        Vault password change, placed beside the other device-local security
        controls. Re-sealing needs proof of the current password — being
        unlocked is not enough — which the dialog asks for and never keeps
        beyond the ceremony.
      */}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Vault password</span>
        <span className="min-w-0 flex-1" aria-hidden="true" />
        <Button variant="ghost" size="sm" onClick={() => setShowChangePassword(true)}>
          Change password
        </Button>
      </div>
    </>
  )
}
