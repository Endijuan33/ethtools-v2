"use client"

/**
 * Backup and restore dialog.
 *
 * Design intent, contrasting with the original:
 * - Exporting secrets requires a password. There is no cleartext path for keys.
 * - The risk is stated plainly *before* the action, not after. The original dialog
 *   framed deletion as the dangerous operation while presenting key export as a
 *   neutral blue button.
 * - Restoring shows exactly what will be written and requires confirmation,
 *   because it overwrites existing accounts.
 * - Restore is atomic; a partial write is rolled back.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import {
  ChevronLeft,
  Download,
  FileJson,
  FileKey,
  KeyRound,
  QrCode,
  ShieldAlert,
  Trash2,
  Upload,
} from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import ResponsiveDialog from "./ui/ResponsiveDialog"
import Button from "./ui/Button"
import Card from "./ui/Card"
import Field, { inputClassName, secretInputProps } from "./ui/Field"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import { Spinner } from "./ui/Feedback"
import { confirmAction, notify } from "./ui/Toast"
import CopyButton from "./ui/CopyButton"
import { cn } from "@/lib/utils"
import {
  applyNonSecretRestore,
  backupFilename,
  createEncryptedBackup,
  createSecretsQrPayload,
  createSettingsBackup,
  decryptBackup,
  inspectBackup,
  MAX_BACKUP_BYTES,
  sanitizeBackupContents,
  serializeBackup,
  summarizeRestore,
  type BackupContents,
  type RestoreMode,
  type RestoreSummary,
  type SecretPayload,
} from "@/lib/backup"
import { assessPassword, isVaultSupported } from "@/lib/vault"
import { clearAllAppData } from "@/lib/storage"
import { truncateHex } from "@/lib/format"
import {
  decryptKeystore,
  encryptKeystore,
  isV3Keystore,
  keystoreFilename,
  MAX_KEYSTORE_BYTES,
  type RecoveredKeystoreAccount,
} from "@/lib/keystore"
import type { VaultAccount } from "@/lib/schema"

export interface BackupManagerProps {
  isOpen: boolean
  onClose: () => void
  /**
   * Supplies decrypted secrets for an encrypted export. Omit when the vault is
   * locked or empty; the dialog then offers settings-only export.
   */
  getSecrets?: () => SecretPayload | null
  /**
   * The account a keystore (V3) export should target — normally the vault's
   * active account. The returned object carries that account's private key, so
   * it must only be supplied while the vault is unlocked. Omit it entirely and
   * keystore export is not offered.
   */
  getExportAccount?: () => VaultAccount | null
  /**
   * Imports a private key recovered from a keystore into the unlocked vault.
   * Supplied by the host, which alone holds the vault password needed to
   * re-seal the payload; omitted while locked, and keystore import is then
   * not offered.
   */
  onImportPrivateKey?: (
    recovered: RecoveredKeystoreAccount
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Network keys a restored custom network may not shadow. */
  reservedNetworkKeys?: readonly string[]
  /** Called after a successful restore so the host can reload its state. */
  onRestored?: (contents: BackupContents) => void
}

type Panel = "menu" | "export" | "qr" | "keystore-export" | "import" | "keystore-import" | "danger"

/** Trigger a file download without navigating away. */
function downloadTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoking synchronously can cancel the download in some browsers, so defer.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** One row in the dialog's root menu. */
function MenuRow({
  icon: Icon,
  title,
  description,
  onClick,
  tone = "default",
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  onClick: () => void
  tone?: "default" | "danger"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "danger"
          ? "border-destructive/30 bg-destructive/10 hover:bg-destructive/15"
          : "border-border bg-muted/30 hover:bg-muted/50"
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          tone === "danger" ? "text-destructive" : "text-primary"
        )}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}

export default function BackupManager({
  isOpen,
  onClose,
  getSecrets,
  getExportAccount,
  onImportPrivateKey,
  reservedNetworkKeys = [],
  onRestored,
}: BackupManagerProps) {
  const [panel, setPanel] = useState<Panel>("menu")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [qrPayload, setQrPayload] = useState<string | null>(null)

  const [importPassword, setImportPassword] = useState("")
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [pendingRestore, setPendingRestore] = useState<{
    contents: BackupContents
    summary: RestoreSummary
  } | null>(null)
  const [restoreMode, setRestoreMode] = useState<RestoreMode>("merge")
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Keystore (V3) exchange. `recovered` holds a decrypted private key between
  // the unlock step and the "add to vault" step; it lives in memory only, is
  // never rendered, and is cleared on add, on re-pick, and on close.
  const [keystoreFile, setKeystoreFile] = useState<File | null>(null)
  const [keystoreText, setKeystoreText] = useState("")
  const [keystorePassword, setKeystorePassword] = useState("")
  const [recovered, setRecovered] = useState<RecoveredKeystoreAccount | null>(null)
  const keystoreFileInputRef = useRef<HTMLInputElement | null>(null)

  const secrets = getSecrets?.() ?? null
  const hasSecrets =
    secrets !== null && (secrets.mnemonic !== undefined || (secrets.accounts?.length ?? 0) > 0)
  const strength = assessPassword(password)
  const passwordsReady = strength.acceptable && password === confirmPassword

  const exportAccount = getExportAccount?.() ?? null
  /**
   * The export target narrowed to an account that actually holds a key. A
   * watch-only account stores an address only, so it is excluded here and the
   * panel explains why instead of offering a button that can never work.
   * Memoized so the export callback below has a stable dependency.
   */
  const keystoreTarget = useMemo<{
    label: string
    address: string
    privateKey: string
  } | null>(() => {
    if (
      exportAccount === null ||
      exportAccount.watchOnly ||
      typeof exportAccount.privateKey !== "string"
    ) {
      return null
    }
    return {
      label: exportAccount.label,
      address: exportAccount.address,
      privateKey: exportAccount.privateKey,
    }
  }, [exportAccount])
  const canImportKeystore = onImportPrivateKey !== undefined
  const hasKeystoreInput = keystoreFile !== null || keystoreText.trim() !== ""

  const reset = useCallback(() => {
    setPanel("menu")
    setBusy(false)
    setError("")
    setPassword("")
    setConfirmPassword("")
    setQrPayload(null)
    setImportPassword("")
    setSelectedFile(null)
    setPendingRestore(null)
    setKeystoreFile(null)
    setKeystoreText("")
    setKeystorePassword("")
    setRecovered(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
    if (keystoreFileInputRef.current) keystoreFileInputRef.current.value = ""
  }, [])

  const handleClose = useCallback(() => {
    reset()
    onClose()
  }, [onClose, reset])

  // ===== Export =====

  const handleEncryptedExport = useCallback(async () => {
    setError("")
    if (!secrets) {
      setError("Unlock your wallet before exporting an encrypted backup.")
      return
    }

    setBusy(true)
    const result = await createEncryptedBackup(secrets, password)
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    downloadTextFile(backupFilename(result.value), serializeBackup(result.value))
    notify.success(
      "Encrypted backup downloaded",
      "Store it somewhere safe. Without the password it cannot be recovered."
    )
    setPassword("")
    setConfirmPassword("")
  }, [password, secrets])

  const handleSettingsExport = useCallback(() => {
    setError("")
    const file = createSettingsBackup()
    downloadTextFile(backupFilename(file), serializeBackup(file))
    notify.success("Settings backup downloaded", "Contains no keys or recovery phrase.")
  }, [])

  const handleQr = useCallback(async () => {
    setError("")
    setQrPayload(null)
    if (!secrets) {
      setError("Unlock your wallet before creating a QR backup.")
      return
    }

    setBusy(true)
    const result = await createSecretsQrPayload(secrets, password)
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    setQrPayload(result.value.payload)
  }, [password, secrets])

  /**
   * Export the active account's private key as a V3 keystore file.
   *
   * Behind an explicit confirmation because the resulting file controls funds
   * on its own, with no vault around it: the dialog states what the file
   * contains and that a lost keystore password is unrecoverable before any
   * key material is touched. The key is passed straight from the unlocked
   * vault to `encryptKeystore` and never rendered or logged.
   */
  const handleKeystoreExport = useCallback(async () => {
    setError("")
    if (!keystoreTarget) {
      setError("The active account has no private key available to export.")
      return
    }

    const confirmed = await confirmAction({
      message: "Export this private key as a keystore file?",
      description: `The file will contain the private key for ${truncateHex(
        keystoreTarget.address,
        8,
        6
      )}, encrypted with the keystore password you chose. Anyone with both the file and its password can spend funds from this account, and a lost password cannot be recovered.`,
      confirmLabel: "Export",
    })
    if (!confirmed) return

    setBusy(true)
    const sealed = await encryptKeystore(keystoreTarget.privateKey, password)
    setBusy(false)

    if (!sealed.ok) {
      setError(sealed.error)
      return
    }

    downloadTextFile(keystoreFilename(sealed.value), JSON.stringify(sealed.value, null, 2))
    notify.success(
      "Keystore downloaded",
      "It opens in geth, MetaMask, MyCrypto, and most wallet tools. Store it somewhere safe."
    )
    setPassword("")
    setConfirmPassword("")
  }, [keystoreTarget, password])

  // ===== Import =====

  const handleFileChosen = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setError("")
    setPendingRestore(null)
    const file = event.target.files?.[0] ?? null
    if (file && file.size > MAX_BACKUP_BYTES) {
      setError("That file is too large to be a valid backup.")
      setSelectedFile(null)
      return
    }
    setSelectedFile(file)
  }, [])

  const handlePrepareRestore = useCallback(async () => {
    setError("")
    if (!selectedFile) {
      setError("Choose a backup file first.")
      return
    }

    setBusy(true)
    try {
      const raw = await selectedFile.text()
      const inspected = inspectBackup(raw)
      if (!inspected.ok) {
        // A V3 keystore is the other JSON wallet file users reach for; route
        // them to the keystore import instead of a generic "not a backup".
        let parsed: unknown = null
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = null
        }
        setError(
          isV3Keystore(parsed)
            ? "This is a keystore (V3) file, not an EthTools backup. Use Import keystore from the main menu instead."
            : inspected.error
        )
        return
      }
      if (inspected.value.requiresPassword && importPassword === "") {
        setError("This backup is encrypted. Enter its password.")
        return
      }

      const opened = await decryptBackup(inspected.value.file, importPassword)
      if (!opened.ok) {
        setError(opened.error)
        return
      }

      const sanitized = sanitizeBackupContents(opened.value, reservedNetworkKeys)
      if (!sanitized.ok) {
        setError(sanitized.error)
        return
      }

      setPendingRestore({
        contents: sanitized.value.contents,
        summary: summarizeRestore(sanitized.value.contents, sanitized.value.dropped),
      })
    } catch {
      setError("Could not read that file.")
    } finally {
      setBusy(false)
    }
  }, [importPassword, reservedNetworkKeys, selectedFile])

  const handleConfirmRestore = useCallback(() => {
    if (!pendingRestore) return
    setError("")

    const result = applyNonSecretRestore(pendingRestore.contents, restoreMode)
    if (!result.ok) {
      setError(result.error)
      return
    }

    onRestored?.(pendingRestore.contents)
    notify.success("Backup restored")
    setPendingRestore(null)
    setSelectedFile(null)
    setImportPassword("")
    setPanel("menu")
  }, [onRestored, pendingRestore, restoreMode])

  /** Accept a keystore file, bounding its size before it is ever read. */
  const handleKeystoreFileChosen = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setError("")
    setRecovered(null)
    setKeystoreText("")
    const file = event.target.files?.[0] ?? null
    if (file && file.size > MAX_KEYSTORE_BYTES) {
      setError("That file is too large to be a keystore.")
      setKeystoreFile(null)
      return
    }
    setKeystoreFile(file)
  }, [])

  /**
   * Decrypt a picked or pasted keystore with its own password.
   *
   * On success only the recovered address is surfaced — the private key sits
   * in component state solely until the user adds it to the vault, and is
   * never displayed or copied from here.
   */
  const handleUnlockKeystore = useCallback(async () => {
    setError("")
    if (!onImportPrivateKey) return

    setBusy(true)
    try {
      const raw = keystoreFile !== null ? await keystoreFile.text() : keystoreText
      if (raw.length > MAX_KEYSTORE_BYTES) {
        setError("That keystore is too large to be valid.")
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        setError("This file is not valid JSON.")
        return
      }

      const opened = await decryptKeystore(parsed, keystorePassword)
      if (!opened.ok) {
        setError(opened.error)
        return
      }
      setRecovered(opened.value)
    } catch {
      setError("Could not read that file.")
    } finally {
      setBusy(false)
    }
  }, [keystoreFile, keystorePassword, keystoreText, onImportPrivateKey])

  /** Re-seal the recovered key into the vault through the host's import path. */
  const handleAddKeystoreAccount = useCallback(async () => {
    setError("")
    if (!recovered || !onImportPrivateKey) return

    setBusy(true)
    const added = await onImportPrivateKey(recovered)
    setBusy(false)

    if (!added.ok) {
      setError(added.error)
      return
    }

    notify.success("Keystore account added", "The key was re-encrypted with your vault password.")
    setRecovered(null)
    setKeystoreFile(null)
    setKeystoreText("")
    setKeystorePassword("")
    if (keystoreFileInputRef.current) keystoreFileInputRef.current.value = ""
    setPanel("menu")
  }, [onImportPrivateKey, recovered])

  const handleErase = useCallback(async () => {
    const confirmed = await confirmAction({
      message: "Erase all data from this device?",
      description:
        "This removes your encrypted vault, accounts, bookmarks, networks, tokens, and history. Without a backup, funds in these accounts cannot be recovered.",
      confirmLabel: "Erase everything",
    })
    if (!confirmed) return

    clearAllAppData()
    notify.success("All data erased")
    setPanel("menu")
    onRestored?.({
      activeAccountId: null,
      bookmarks: [],
      transactions: [],
      customNetworks: {},
      tokens: [],
    })
  }, [onRestored])

  // ===== Shared fragments =====

  /**
   * Password + confirm pair with the shared strength assessor. Parameterized so
   * the keystore export can label it distinctly from backup exports.
   */
  const passwordFields = (label: string, hint: string) => (
    <div className="space-y-3">
      <Field
        label={label}
        required
        hint={hint}
        error={password !== "" && !strength.acceptable ? strength.issues[0] : undefined}
        action={
          password !== "" ? (
            <Badge tone={strength.acceptable ? "success" : "warning"}>{strength.label}</Badge>
          ) : undefined
        }
      >
        {(props) => (
          <input
            {...props}
            {...secretInputProps}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={inputClassName}
          />
        )}
      </Field>

      <Field
        label="Confirm password"
        required
        error={
          confirmPassword !== "" && password !== confirmPassword
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
            onChange={(event) => setConfirmPassword(event.target.value)}
            className={inputClassName}
          />
        )}
      </Field>
    </div>
  )

  const backButton = (
    <Button
      variant="ghost"
      onClick={() => {
        setPanel("menu")
        setError("")
      }}
      fullWidth
      icon={<ChevronLeft className="h-4 w-4" aria-hidden="true" />}
    >
      Back
    </Button>
  )

  const TITLES: Record<Panel, string> = {
    menu: "Backup and restore",
    export: "Export backup",
    qr: "QR backup",
    "keystore-export": "Export keystore",
    import: "Restore backup",
    "keystore-import": "Import keystore",
    danger: "Erase all data",
  }

  return (
    <ResponsiveDialog
      isOpen={isOpen}
      onClose={handleClose}
      title={TITLES[panel]}
      description={
        panel === "menu" ? "Save your wallet, or restore it from a previous backup." : undefined
      }
      size="lg"
    >
      {!isVaultSupported() && (
        <Alert tone="danger" title="Encryption unavailable.">
          This browser cannot encrypt data, which usually means the page is not served over HTTPS.
          Encrypted backups are disabled.
        </Alert>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {panel === "menu" && (
        <>
          <div className="space-y-2.5">
            <MenuRow
              icon={Download}
              title="Export backup"
              description="Encrypted file with your accounts, or a settings-only file with no keys."
              onClick={() => setPanel("export")}
            />
            <MenuRow
              icon={QrCode}
              title="QR backup"
              description="Encrypted QR code you can print or photograph for offline storage."
              onClick={() => setPanel("qr")}
            />
            {getExportAccount !== undefined && (
              <MenuRow
                icon={FileKey}
                title="Export keystore (V3)"
                description="A standard keystore file for the active account, encrypted with a password you choose."
                onClick={() => setPanel("keystore-export")}
              />
            )}
            <MenuRow
              icon={Upload}
              title="Restore backup"
              description="Load a previous export. You will see what changes before it applies."
              onClick={() => setPanel("import")}
            />
            {onImportPrivateKey !== undefined && (
              <MenuRow
                icon={KeyRound}
                title="Import keystore (V3)"
                description="Recover one account from a keystore file and add it to this vault."
                onClick={() => setPanel("keystore-import")}
              />
            )}
            <MenuRow
              icon={Trash2}
              title="Erase all data"
              description="Remove everything from this device, including the encrypted vault."
              onClick={() => setPanel("danger")}
              tone="danger"
            />
          </div>

          <p className="mt-4 flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
            <FileJson className="h-3.5 w-3.5" aria-hidden="true" />
            Backups are created and read entirely in your browser.
          </p>
        </>
      )}

      {panel === "export" && (
        <div className="space-y-4">
          <Alert tone="danger" title="This file controls your funds.">
            An encrypted backup contains your recovery phrase and private keys. Anyone with both
            the file and its password can spend everything in these accounts. Use a password you do
            not use anywhere else.
          </Alert>

          {!hasSecrets && (
            <Alert tone="warning">
              No unlocked accounts found, so only a settings-only backup is available.
            </Alert>
          )}

          {hasSecrets && isVaultSupported() && (
            <>
              {passwordFields(
                "Backup password",
                "Used only to encrypt this file. It is never stored or transmitted."
              )}
              <Button
                onClick={handleEncryptedExport}
                isLoading={busy}
                loadingLabel="Encrypting…"
                fullWidth
                disabled={!passwordsReady}
                icon={<Download className="h-4 w-4" aria-hidden="true" />}
              >
                Download encrypted backup
              </Button>
            </>
          )}

          <Card variant="inset" padding="sm" className="space-y-2.5">
            <div>
              <p className="text-sm font-medium text-foreground">Settings only</p>
              <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                Bookmarks, custom networks, tracked tokens, and history. No keys or recovery
                phrase, so no password is needed.
              </p>
            </div>
            <Button variant="outline" onClick={handleSettingsExport} fullWidth>
              Download settings backup
            </Button>
          </Card>

          {backButton}
        </div>
      )}

      {panel === "qr" && (
        <div className="space-y-4">
          <Alert tone="warning" title="Keep this code offline.">
            The code is encrypted, so a photograph alone is not enough. Even so, print it or store
            it offline rather than in cloud photo storage.
          </Alert>

          {!hasSecrets ? (
            <Alert tone="warning">Unlock your wallet to create a QR backup.</Alert>
          ) : qrPayload ? (
            <div className="space-y-3">
              {/* A QR code needs a light quiet zone to scan reliably, so this
                  block stays white in both themes by design. */}
              <div className="mx-auto w-fit rounded-xl bg-white p-4">
                <QRCodeSVG value={qrPayload} size={232} level="M" />
              </div>
              <p className="text-center text-xs text-muted-foreground">
                {qrPayload.length} characters · scan with this app to restore
              </p>
              <Button variant="outline" onClick={() => setQrPayload(null)} fullWidth>
                Hide code
              </Button>
            </div>
          ) : (
            <>
              {passwordFields(
                "Backup password",
                "Used only to encrypt this file. It is never stored or transmitted."
              )}
              <Button
                onClick={handleQr}
                isLoading={busy}
                loadingLabel="Encrypting…"
                fullWidth
                disabled={!passwordsReady}
                icon={<QrCode className="h-4 w-4" aria-hidden="true" />}
              >
                Generate QR code
              </Button>
            </>
          )}

          {backButton}
        </div>
      )}

      {panel === "keystore-export" && (
        <div className="space-y-4">
          <Alert tone="danger" title="This file contains a private key.">
            A keystore file stores the private key of one account, encrypted with the password you
            choose below. Anyone with both the file and its password can spend everything in that
            account, and a lost password cannot be recovered. The keystore password protects this
            file — it does not have to match your vault password.
          </Alert>

          {keystoreTarget ? (
            <>
              <Card variant="inset" padding="sm">
                <p className="text-sm font-medium text-foreground">{keystoreTarget.label}</p>
                <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                  {keystoreTarget.address}
                </p>
              </Card>

              {passwordFields(
                "Keystore password",
                "Encrypts this keystore file. It is never stored or transmitted, and cannot be recovered if lost."
              )}

              <Button
                onClick={handleKeystoreExport}
                isLoading={busy}
                loadingLabel="Encrypting…"
                fullWidth
                disabled={!passwordsReady}
                icon={<FileKey className="h-4 w-4" aria-hidden="true" />}
              >
                Create keystore file
              </Button>
            </>
          ) : exportAccount ? (
            /* Only the active account is exported, so the one exclusion users
               will actually hit — a watch-only account — gets its own reason. */
            <Alert tone="warning" title="This account has no private key to export.">
              {exportAccount.watchOnly
                ? "The active account is watch-only: it stores only an address, so there is no key to export. Select a key-holding account in your wallet, then try again."
                : "The active account does not expose a private key, so it cannot be exported as a keystore."}
            </Alert>
          ) : (
            <Alert tone="warning">
              No account is available to export. Unlock your wallet and select an account first.
            </Alert>
          )}

          {backButton}
        </div>
      )}

      {panel === "import" && (
        <div className="space-y-4">
          {pendingRestore ? (
            <>
              <Alert
                tone={restoreMode === "replace" ? "danger" : "warning"}
                title="Review before restoring."
              >
                {restoreMode === "replace"
                  ? "Replace mode permanently overwrites your current bookmarks, networks, tokens, and history."
                  : "Merge mode keeps your existing data and adds anything new. Existing entries win on conflict."}
              </Alert>

              <Card variant="inset" padding="sm">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {(
                    [
                      ["Accounts", pendingRestore.summary.accounts],
                      ["Bookmarks", pendingRestore.summary.bookmarks],
                      ["Transactions", pendingRestore.summary.transactions],
                      ["Networks", pendingRestore.summary.customNetworks],
                      ["Tokens", pendingRestore.summary.tokens],
                    ] as const
                  ).map(([label, count]) => (
                    <div key={label} className="flex items-baseline justify-between gap-2">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-mono font-semibold text-foreground">{count}</dd>
                    </div>
                  ))}
                  <div className="col-span-2 flex items-baseline justify-between gap-2 border-t border-border pt-2">
                    <dt className="text-muted-foreground">Recovery phrase included</dt>
                    <dd className="font-medium text-foreground">
                      {pendingRestore.summary.includedMnemonic ? "Yes" : "No"}
                    </dd>
                  </div>
                </dl>
              </Card>

              {pendingRestore.summary.droppedRecords > 0 && (
                <Alert tone="warning" title="Some records were skipped.">
                  {pendingRestore.summary.droppedRecords} record(s) failed validation. That usually
                  means the file was edited or partly corrupted.
                </Alert>
              )}

              <fieldset className="space-y-2">
                <legend className="mb-1.5 text-sm font-medium text-foreground">Restore mode</legend>
                {(
                  [
                    ["merge", "Merge", "Keep existing data, add what is new"],
                    ["replace", "Replace", "Overwrite existing data"],
                  ] as const
                ).map(([value, label, description]) => (
                  <label
                    key={value}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                      restoreMode === value
                        ? "border-primary/40 bg-primary/10"
                        : "border-border bg-muted/30 hover:bg-muted/50"
                    )}
                  >
                    <input
                      type="radio"
                      name="restore-mode"
                      value={value}
                      checked={restoreMode === value}
                      onChange={() => setRestoreMode(value)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    />
                    <span>
                      <span className="block text-sm font-medium text-foreground">{label}</span>
                      <span className="block text-xs text-muted-foreground">{description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <div className="flex gap-3">
                <Button variant="secondary" onClick={() => setPendingRestore(null)} fullWidth>
                  Cancel
                </Button>
                <Button
                  variant={restoreMode === "replace" ? "danger" : "primary"}
                  onClick={handleConfirmRestore}
                  fullWidth
                >
                  {restoreMode === "replace" ? "Overwrite" : "Restore"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Field label="Backup file" required>
                {(props) => (
                  <input
                    {...props}
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    onChange={handleFileChosen}
                    className={cn(
                      inputClassName,
                      "cursor-pointer py-2 text-sm",
                      "file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
                    )}
                  />
                )}
              </Field>

              <Field
                label="Backup password"
                hint="Leave blank for a settings-only backup, which is not encrypted."
              >
                {(props) => (
                  <input
                    {...props}
                    {...secretInputProps}
                    type="password"
                    value={importPassword}
                    onChange={(event) => setImportPassword(event.target.value)}
                    className={inputClassName}
                  />
                )}
              </Field>

              {busy ? (
                <Spinner label="Reading backup…" />
              ) : (
                <Button onClick={handlePrepareRestore} fullWidth disabled={!selectedFile}>
                  Review backup
                </Button>
              )}
            </>
          )}

          {backButton}
        </div>
      )}

      {panel === "keystore-import" && (
        <div className="space-y-4">
          <Alert tone="info" title="One account per file.">
            A keystore (V3) file holds a single private key, encrypted with the password that was
            set when the file was created. It is decrypted here in your browser and re-encrypted
            into your vault; the key itself is never shown or sent anywhere.
          </Alert>

          {!canImportKeystore ? (
            <Alert tone="warning" title="Unlock your wallet first.">
              Keystore import adds the recovered key to your unlocked vault. Close this dialog,
              unlock the wallet, and reopen backup and restore.
            </Alert>
          ) : recovered ? (
            <>
              <Card variant="inset" padding="sm" className="space-y-2">
                <p className="text-sm font-medium text-foreground">Recovered account</p>
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 break-all font-mono text-sm text-success">
                    {recovered.address}
                  </p>
                  <CopyButton value={recovered.address} label="address" />
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Only the address is shown. The private key stays in memory until it is
                  re-encrypted into your vault.
                </p>
              </Card>

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setRecovered(null)
                    setKeystoreFile(null)
                    setKeystoreText("")
                    // Clear the picker too, or re-choosing the same file would
                    // not fire another change event.
                    if (keystoreFileInputRef.current) keystoreFileInputRef.current.value = ""
                  }}
                  fullWidth
                >
                  Use a different file
                </Button>
                <Button
                  onClick={handleAddKeystoreAccount}
                  isLoading={busy}
                  loadingLabel="Encrypting…"
                  fullWidth
                  icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
                >
                  Add to vault
                </Button>
              </div>
            </>
          ) : (
            <>
              <Field
                label="Keystore file"
                hint="A V3 JSON file, e.g. from geth or MetaMask. You can paste its contents below instead."
              >
                {(props) => (
                  <input
                    {...props}
                    ref={keystoreFileInputRef}
                    type="file"
                    accept="application/json,.json"
                    onChange={handleKeystoreFileChosen}
                    className={cn(
                      inputClassName,
                      "cursor-pointer py-2 text-sm",
                      "file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
                    )}
                  />
                )}
              </Field>

              <Field label="Or paste the keystore JSON">
                {(props) => (
                  <textarea
                    {...props}
                    {...secretInputProps}
                    value={keystoreText}
                    onChange={(event) => {
                      setKeystoreText(event.target.value)
                      setKeystoreFile(null)
                    }}
                    rows={3}
                    placeholder={'{"version":3,"id":"…","crypto":{…}}'}
                    className={`${inputClassName} resize-none font-mono text-sm`}
                  />
                )}
              </Field>

              <Field
                label="Keystore password"
                required
                hint="The password set when this file was created — not necessarily your vault password."
              >
                {(props) => (
                  <input
                    {...props}
                    {...secretInputProps}
                    type="password"
                    value={keystorePassword}
                    onChange={(event) => setKeystorePassword(event.target.value)}
                    className={inputClassName}
                  />
                )}
              </Field>

              {busy ? (
                <Spinner label="Decrypting…" />
              ) : (
                <Button
                  onClick={handleUnlockKeystore}
                  fullWidth
                  disabled={!hasKeystoreInput || keystorePassword === ""}
                  icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
                >
                  Unlock keystore
                </Button>
              )}
            </>
          )}

          {backButton}
        </div>
      )}

      {panel === "danger" && (
        <div className="space-y-4">
          <Alert tone="danger" title="This cannot be undone.">
            Erasing removes your encrypted vault, accounts, bookmarks, custom networks, tracked
            tokens, and transaction history from this device. If you have no backup, any funds in
            these accounts become permanently inaccessible.
          </Alert>

          <Button
            variant="danger"
            fullWidth
            onClick={handleErase}
            icon={<ShieldAlert className="h-4 w-4" aria-hidden="true" />}
          >
            Erase everything
          </Button>

          {backButton}
        </div>
      )}
    </ResponsiveDialog>
  )
}
