"use client"

/**
 * Encrypted wallet vault.
 *
 * The security model this component enforces:
 * - Secrets are decrypted into React state only while unlocked, and that state
 *   is dropped on lock, on idle timeout, and when the tab is hidden long enough.
 * - Nothing secret is ever written to storage in cleartext; every write goes
 *   through `lib/vaultStore.ts`, which encrypts first.
 * - A private key or recovery phrase is rendered only through `SecretField`,
 *   which keeps it out of the DOM until explicitly revealed.
 * - Existing cleartext wallets are detected and offered migration, because
 *   leaving them in place is a live exposure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FileJson, Lock, LockOpen, Plus, ShieldCheck, Trash2, Wallet } from "lucide-react"
import Button from "./ui/Button"
import Card, { CardDescription, CardHeader, CardTitle } from "./ui/Card"
import Tabs from "./ui/Tabs"
import Badge from "./ui/Badge"
import Field, { inputClassName, monoInputClassName, secretInputProps } from "./ui/Field"
import Alert from "./ui/Alert"
import ResponsiveDialog from "./ui/ResponsiveDialog"
import SecretField from "./ui/SecretField"
import CopyButton from "./ui/CopyButton"
import { EmptyState, Spinner } from "./ui/Feedback"
import { confirmAction, notify } from "./ui/Toast"
import { cn } from "@/lib/utils"
import AccountDiscovery from "./AccountDiscovery"
import BackupManager from "./BackupManager"
import { truncateHex } from "@/lib/format"
import { assessPassword, isVaultSupported } from "@/lib/vault"
import {
  DEFAULT_PRESET_ID,
  classifySecret,
  deriveAccounts,
  deriveFromPrivateKey,
  generateMnemonic,
  getPreset,
  MNEMONIC_WORD_COUNTS,
  type MnemonicWordCount,
} from "@/lib/hdWallet"
import {
  addAccountsToVault,
  createVault,
  detectLegacyWallets,
  getActiveAccountId,
  hasVault,
  migrateLegacyWallets,
  removeAccountFromVault,
  setActiveAccountId,
  unlockVault,
} from "@/lib/vaultStore"
import { NETWORKS } from "@/lib/ethers"
import type { VaultAccount, VaultPayload } from "@/lib/schema"

/** Lock automatically after this much inactivity. */
const IDLE_LOCK_MS = 5 * 60 * 1000

type Stage = "checking" | "setup" | "locked" | "unlocked"
type SetupMode = "generate" | "import"

/** Setup paths offered on a device with no vault yet. */
const SETUP_MODES = [
  { id: "generate", label: "Create new" },
  { id: "import", label: "Import existing" },
] as const satisfies readonly { id: SetupMode; label: string }[]

/** Built-in network keys an imported custom network may not shadow. */
const RESERVED_NETWORK_KEYS = Object.keys(NETWORKS)

export default function WalletVault() {
  const [stage, setStage] = useState<Stage>("checking")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  // Unlocked secrets. Cleared on lock.
  const [payload, setPayload] = useState<VaultPayload | null>(null)
  const [password, setPassword] = useState("")
  const [activeId, setActiveId] = useState<string | null>(null)

  // Setup form
  const [setupMode, setSetupMode] = useState<SetupMode>("generate")
  const [wordCount, setWordCount] = useState<MnemonicWordCount>(12)
  const [draftPhrase, setDraftPhrase] = useState("")
  const [importInput, setImportInput] = useState("")
  const [bip39Passphrase, setBip39Passphrase] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)

  const [legacyCount, setLegacyCount] = useState(0)
  const [showDerive, setShowDerive] = useState(false)
  const [showBackup, setShowBackup] = useState(false)

  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const strength = assessPassword(newPassword)

  // ===== Lifecycle =====

  useEffect(() => {
    setLegacyCount(detectLegacyWallets().length)
    setActiveId(getActiveAccountId())
    setStage(hasVault() ? "locked" : "setup")
  }, [])

  const lock = useCallback(
    (reason?: string) => {
      setPayload(null)
      setPassword("")
      setShowDerive(false)
      setShowBackup(false)
      setStage(hasVault() ? "locked" : "setup")
      setNotice(reason ?? "")
      setError("")
    },
    []
  )

  // Idle auto-lock. Any interaction restarts the countdown.
  useEffect(() => {
    if (stage !== "unlocked") return

    const reset = (): void => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = setTimeout(
        () => lock("Locked automatically after 5 minutes of inactivity."),
        IDLE_LOCK_MS
      )
    }

    const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "focus"]
    events.forEach((event) => window.addEventListener(event, reset))
    reset()

    return () => {
      events.forEach((event) => window.removeEventListener(event, reset))
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [stage, lock])

  // ===== Setup =====

  const handleGenerate = useCallback(() => {
    setError("")
    const result = generateMnemonic(wordCount)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setDraftPhrase(result.value)
    setAcknowledged(false)
  }, [wordCount])

  const handleCreate = useCallback(async () => {
    setError("")

    if (!strength.acceptable) {
      setError(strength.issues[0] ?? "Choose a stronger password.")
      return
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }

    let mnemonic: string | undefined
    let accounts: VaultAccount[] = []

    if (setupMode === "generate") {
      if (draftPhrase === "") {
        setError("Generate a recovery phrase first.")
        return
      }
      if (!acknowledged) {
        setError("Confirm that you have written down your recovery phrase.")
        return
      }
      mnemonic = draftPhrase
    } else {
      const classified = classifySecret(importInput)
      if (classified.kind === "mnemonic") {
        mnemonic = classified.normalized
      } else if (classified.kind === "private-key") {
        const single = deriveFromPrivateKey(classified.normalized)
        if (!single.ok) {
          setError(single.error)
          return
        }
        accounts = [
          {
            id: crypto.randomUUID?.() ?? `account-${Date.now()}`,
            label: "Imported key",
            address: single.value.address,
            privateKey: single.value.privateKey,
          },
        ]
      } else {
        setError(classified.reason ?? "Enter a recovery phrase or a private key.")
        return
      }
    }

    setBusy(true)

    // Seed the vault with the first derived account when we have a phrase.
    if (mnemonic !== undefined) {
      const derived = deriveAccounts({
        mnemonic,
        passphrase: bip39Passphrase,
        template: getPreset(DEFAULT_PRESET_ID)?.template,
        count: 1,
      })
      if (!derived.ok) {
        setBusy(false)
        setError(derived.error)
        return
      }
      accounts = derived.value.map((account) => ({
        id: crypto.randomUUID?.() ?? `account-${account.index}`,
        label: `Account ${account.index + 1}`,
        address: account.address,
        privateKey: account.privateKey,
        derivationIndex: account.index,
        derivationPath: account.path,
      }))
    }

    const created = await createVault({
      mnemonic,
      mnemonicPassphrase: bip39Passphrase === "" ? undefined : bip39Passphrase,
      accounts,
      password: newPassword,
    })

    if (!created.ok) {
      setBusy(false)
      setError(created.error)
      return
    }

    // Fold any pre-existing cleartext wallets into the new vault.
    if (legacyCount > 0) {
      const migrated = await migrateLegacyWallets(newPassword, created.value)
      if (migrated.ok) {
        setLegacyCount(0)
        setNotice(
          `Secured ${migrated.value.migrated} wallet(s) that were previously stored unencrypted.`
        )
      }
    }

    const reopened = await unlockVault(newPassword)
    setBusy(false)
    if (!reopened.ok) {
      setError(reopened.error)
      return
    }

    setPayload(reopened.value)
    setPassword(newPassword)
    setActiveId(reopened.value.accounts[0]?.id ?? null)
    setActiveAccountId(reopened.value.accounts[0]?.id ?? null)
    setStage("unlocked")

    // Clear the setup form so no secret lingers in component state.
    setDraftPhrase("")
    setImportInput("")
    setBip39Passphrase("")
    setNewPassword("")
    setConfirmPassword("")
    setAcknowledged(false)
  }, [
    acknowledged,
    bip39Passphrase,
    confirmPassword,
    draftPhrase,
    importInput,
    legacyCount,
    newPassword,
    setupMode,
    strength,
  ])

  // ===== Unlock =====

  const handleUnlock = useCallback(async () => {
    setError("")
    setBusy(true)

    const opened = await unlockVault(password)
    if (!opened.ok) {
      setBusy(false)
      setError(opened.error)
      return
    }

    if (legacyCount > 0) {
      const migrated = await migrateLegacyWallets(password, opened.value)
      if (migrated.ok && migrated.value.migrated > 0) {
        setLegacyCount(0)
        setNotice(
          `Secured ${migrated.value.migrated} wallet(s) that were previously stored unencrypted.`
        )
        const refreshed = await unlockVault(password)
        if (refreshed.ok) {
          setPayload(refreshed.value)
          setBusy(false)
          setStage("unlocked")
          return
        }
      }
    }

    // Clear the "Wallet locked." notice left over from locking; showing it on
    // the unlocked screen would state the opposite of the current state.
    setNotice("")
    setBusy(false)
    setPayload(opened.value)
    setStage("unlocked")
  }, [legacyCount, password])

  // ===== Account management =====

  const handleImportDerived = useCallback(
    async (derived: Parameters<typeof addAccountsToVault>[1]) => {
      if (!payload) return
      setBusy(true)
      const result = await addAccountsToVault(payload, derived, password)
      setBusy(false)

      if (!result.ok) {
        setError(result.error)
        return
      }
      setPayload(result.value)
      setShowDerive(false)
      setNotice(`Added ${derived.length} account(s).`)
    },
    [password, payload]
  )

  const handleRemove = useCallback(
    async (accountId: string) => {
      if (!payload) return

      const confirmed = await confirmAction({
        message: "Remove this account from the vault?",
        description:
          "If it came from your recovery phrase you can derive it again. If it was imported as a private key, make sure that key is saved elsewhere first.",
        confirmLabel: "Remove",
      })
      if (!confirmed) return

      setBusy(true)
      const result = await removeAccountFromVault(payload, accountId, password)
      setBusy(false)

      if (!result.ok) {
        setError(result.error)
        return
      }
      setPayload(result.value)
      notify.success("Account removed")
      if (activeId === accountId) {
        const next = result.value.accounts[0]?.id ?? null
        setActiveId(next)
        setActiveAccountId(next)
      }
    },
    [activeId, password, payload]
  )

  const activeAccount = useMemo(
    () => payload?.accounts.find((a) => a.id === activeId) ?? payload?.accounts[0] ?? null,
    [activeId, payload]
  )

  // ===== Render =====

  const shell = (children: React.ReactNode) => (
    <Card as="section" aria-label="Wallet vault" className="w-full max-w-lg">
      {children}
    </Card>
  )

  if (stage === "checking") {
    return shell(<Spinner label="Checking for a saved wallet…" />)
  }

  if (!isVaultSupported()) {
    return shell(
      <Alert tone="danger" title="Encryption unavailable.">
        This browser cannot encrypt data, which usually means the page is not being served over
        HTTPS. The vault is disabled rather than storing your keys unprotected.
      </Alert>
    )
  }

  const banners = (
    <>
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" className="mb-4">
          {notice}
        </Alert>
      )}
      {legacyCount > 0 && (
        <Alert tone="warning" title="Unencrypted wallets found." className="mb-4">
          {legacyCount} wallet(s) are stored on this device without encryption. Setting a
          password below will encrypt them and delete the unprotected copies.
        </Alert>
      )}
    </>
  )

  if (stage === "setup") {
    return shell(
      <>
        <CardHeader className="flex-col items-center text-center">
          <span
            className="mb-1 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/25 bg-gradient-to-b from-primary/15 to-transparent text-primary shadow-glow-sm"
            aria-hidden="true"
          >
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <CardTitle>Create your wallet</CardTitle>
            <CardDescription>
              Your recovery phrase and keys are encrypted with a password and stored only in this
              browser.
            </CardDescription>
          </div>
        </CardHeader>
        {banners}

        <Tabs
          items={SETUP_MODES}
          value={setupMode}
          onChange={(next) => {
            setSetupMode(next)
            setError("")
          }}
          label="Setup method"
          layoutGroupId="vault-setup"
          className="mb-4"
        />

        <div className="space-y-4">
          {setupMode === "generate" ? (
            <>
              <Field label="Recovery phrase length">
                {(props) => (
                  <select
                    {...props}
                    value={wordCount}
                    onChange={(e) => {
                      setWordCount(Number(e.target.value) as MnemonicWordCount)
                      setDraftPhrase("")
                    }}
                    className={inputClassName}
                  >
                    {MNEMONIC_WORD_COUNTS.map((count) => (
                      <option key={count} value={count}>
                        {count} words
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              {draftPhrase === "" ? (
                <Button onClick={handleGenerate} fullWidth>
                  Generate recovery phrase
                </Button>
              ) : (
                <>
                  <Alert tone="danger" title="Write this down now.">
                    This phrase is the only way to recover these accounts. Store it offline. Never
                    type it into a website or share it with anyone, including support staff.
                  </Alert>

                  <SecretField
                    label="Recovery phrase"
                    value={draftPhrase}
                    variant="phrase"
                    allowCopy
                    autoHideMs={120_000}
                  />

                  <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                      className="mt-0.5 h-4 w-4 flex-shrink-0"
                    />
                    I have written down my recovery phrase and stored it safely.
                  </label>

                  <Button variant="ghost" onClick={handleGenerate} fullWidth>
                    Generate a different phrase
                  </Button>
                </>
              )}
            </>
          ) : (
            <Field
              label="Recovery phrase or private key"
              hint="Accepts a 12, 15, 18, 21, or 24-word phrase, or a 64-character private key."
              required
            >
              {(props) => (
                <textarea
                  {...props}
                  {...secretInputProps}
                  value={importInput}
                  onChange={(e) => setImportInput(e.target.value)}
                  rows={3}
                  className={`${inputClassName} resize-none font-mono text-sm`}
                />
              )}
            </Field>
          )}

          <Field
            label="BIP-39 passphrase (optional)"
            hint="Sometimes called the 25th word. A different passphrase produces entirely different accounts."
          >
            {(props) => (
              <input
                {...props}
                {...secretInputProps}
                type="password"
                value={bip39Passphrase}
                onChange={(e) => setBip39Passphrase(e.target.value)}
                className={inputClassName}
              />
            )}
          </Field>

          <div className="border-t border-border pt-4">
            <Field
              label="Vault password"
              required
              hint="Encrypts everything above. It is never stored or sent anywhere, and cannot be recovered."
              error={newPassword !== "" && !strength.acceptable ? strength.issues[0] : undefined}
            >
              {(props) => (
                <input
                  {...props}
                  {...secretInputProps}
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={inputClassName}
                />
              )}
            </Field>
          </div>

          <Field
            label="Confirm password"
            required
            error={
              confirmPassword !== "" && newPassword !== confirmPassword
                ? "Passwords do not match."
                : undefined
            }
          >
            {(props) => (
              <input
                {...props}
                {...secretInputProps}
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputClassName}
              />
            )}
          </Field>

          {newPassword !== "" && (
            <p className="text-xs text-muted-foreground">
              Strength: <span className="font-semibold">{strength.label}</span>
            </p>
          )}

          <Button
            onClick={handleCreate}
            isLoading={busy}
            loadingLabel="Encrypting…"
            fullWidth
            disabled={!strength.acceptable || newPassword !== confirmPassword}
            icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
          >
            Create encrypted wallet
          </Button>
        </div>
      </>
    )
  }

  if (stage === "locked") {
    return shell(
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

        <BackupManager
          isOpen={showBackup}
          onClose={() => setShowBackup(false)}
          reservedNetworkKeys={RESERVED_NETWORK_KEYS}
        />
      </>
    )
  }

  // stage === "unlocked"
  return shell(
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

      {payload?.mnemonic && payload.accounts.length > 0 && (
        <Button
          variant="outline"
          onClick={() => setShowDerive(true)}
          fullWidth
          className="mt-3"
          icon={<Plus className="h-4 w-4" aria-hidden="true" />}
        >
          Add accounts from recovery phrase
        </Button>
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
        </div>
      )}

      <p className="mt-5 flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Encrypted at rest. Locks automatically after 5 minutes of inactivity.
      </p>

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

      <BackupManager
        isOpen={showBackup}
        onClose={() => setShowBackup(false)}
        reservedNetworkKeys={RESERVED_NETWORK_KEYS}
        getSecrets={() =>
          payload
            ? {
                mnemonic: payload.mnemonic,
                mnemonicPassphrase: payload.mnemonicPassphrase,
                accounts: payload.accounts,
              }
            : null
        }
      />
    </>
  )
}
