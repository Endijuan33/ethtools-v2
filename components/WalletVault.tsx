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
 * - Watch-only accounts store an address and a label and nothing else, so
 *   displaying them can never require a secret, and no send flow exists for
 *   them anywhere in the app.
 * - Existing cleartext wallets are detected and offered migration, because
 *   leaving them in place is a live exposure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import PortfolioCard from "./PortfolioCard"
import TokenDiscoveryCard from "./TokenDiscoveryCard"
import ApprovalManagerCard from "./ApprovalManagerCard"
import VaultSignCard from "./VaultSignCard"
import SweepCard from "./SweepCard"
import WatchBalanceNotifier from "./WatchBalanceNotifier"
import { truncateHex } from "@/lib/format"
import { assessPassword, isVaultSupported } from "@/lib/vault"
import { decryptKeystore, MAX_KEYSTORE_BYTES, type RecoveredKeystoreAccount } from "@/lib/keystore"
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
  addWatchOnlyAccountToVault,
  changeVaultPassword,
  createVault,
  detectLegacyWallets,
  getActiveAccountId,
  getAutolockMinutes,
  hasVault,
  migrateLegacyWallets,
  removeAccountFromVault,
  setAutolockMinutes as persistAutolockMinutes,
  setActiveAccountId,
  unlockVault,
} from "@/lib/vaultStore"
import {
  enrollPasskeyUnlock,
  hasPasskeyUnlock,
  isPasskeyUnlockAvailable,
  removePasskeyUnlock,
  rewrapPasskeyUnlock,
  unlockWithPasskey,
} from "@/lib/webauthnUnlock"
import { NETWORKS } from "@/lib/ethers"
import {
  AUTOLOCK_MINUTES_CHOICES,
  DEFAULT_AUTOLOCK_MINUTES,
  isChecksummedAddress,
  isEthAddress,
  type AutoLockMinutes,
  type VaultAccount,
  type VaultPayload,
} from "@/lib/schema"

type Stage = "checking" | "setup" | "locked" | "unlocked"
type SetupMode = "generate" | "import"

/*
 * The WalletConnect panel pulls in the Reown SDK (relay + websocket code,
 * a meaningful chunk). Code-splitting it keeps that cost off the vault bundle
 * until the panel is actually rendered.
 */
const WalletConnectPanel = dynamic(() => import("./WalletConnectPanel"), {
  ssr: false,
  loading: () => <Spinner label="Loading WalletConnect…" />,
})

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

  // Setup: a key recovered from a V3 keystore file, waiting for vault creation.
  // Held decrypted in memory only, exactly like a typed private key, and never
  // rendered — only its public address is displayed.
  const [setupKeystore, setSetupKeystore] = useState<RecoveredKeystoreAccount | null>(null)
  const [setupKeystoreFile, setSetupKeystoreFile] = useState<File | null>(null)
  const [setupKeystorePassword, setSetupKeystorePassword] = useState("")
  const setupKeystoreFileRef = useRef<HTMLInputElement | null>(null)

  const [legacyCount, setLegacyCount] = useState(0)
  const [showDerive, setShowDerive] = useState(false)
  const [showBackup, setShowBackup] = useState(false)

  // Watch-address form. An address is public information, so this form holds
  // no secret — but it is still cleared on lock like every other open form.
  const [showWatch, setShowWatch] = useState(false)
  const [watchLabel, setWatchLabel] = useState("")
  const [watchAddress, setWatchAddress] = useState("")
  const [watchError, setWatchError] = useState("")

  // Idle auto-lock timeout, in minutes. Read from storage once on mount; the
  // stored default equals the historical hardcoded 5-minute lock.
  const [autolockMinutes, setAutolockMinutes] = useState<AutoLockMinutes>(
    DEFAULT_AUTOLOCK_MINUTES
  )

  // Optional passkey unlock (experimental). `passkeySupported` is a capability
  // hint read after mount — WebAuthn cannot be probed during server rendering —
  // and only gates the ENROLL control; `passkeyEnrolled` reflects a valid
  // envelope in storage. The password path stays primary in every state.
  const [passkeySupported, setPasskeySupported] = useState(false)
  const [passkeyEnrolled, setPasskeyEnrolled] = useState(false)
  const [showPasskeyEnroll, setShowPasskeyEnroll] = useState(false)
  // The enroll dialog asks for the vault password to prove possession before
  // wrapping it (the unlocked state alone must never be enough to enroll a
  // passkey and thereby learn the password). Cleared the moment the dialog
  // closes or the ceremony ends — never kept around.
  const [passkeyPassword, setPasskeyPassword] = useState("")
  const [passkeyError, setPasskeyError] = useState("")
  const [passkeyBusy, setPasskeyBusy] = useState(false)

  // Password-change dialog. The CURRENT password is a secret typed to prove
  // possession before the vault may be re-sealed; it lives only for the
  // ceremony — cleared in `finally`, on close, and on lock, never kept around
  // in component state. The new-password drafts follow the setup screen's
  // conventions (same assessor, cleared on success and on lock).
  const [showChangePassword, setShowChangePassword] = useState(false)
  const [changePwCurrent, setChangePwCurrent] = useState("")
  const [changePwNext, setChangePwNext] = useState("")
  const [changePwConfirm, setChangePwConfirm] = useState("")
  const [changePwError, setChangePwError] = useState("")
  const [changePwBusy, setChangePwBusy] = useState(false)

  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const strength = assessPassword(newPassword)
  // The change dialog reuses the setup screen's assessor so both screens agree
  // on what "strong enough to encrypt funds" means.
  const nextStrength = assessPassword(changePwNext)

  // ===== Lifecycle =====

  useEffect(() => {
    setLegacyCount(detectLegacyWallets().length)
    setActiveId(getActiveAccountId())
    setAutolockMinutes(getAutolockMinutes())
    setPasskeySupported(isPasskeyUnlockAvailable())
    setPasskeyEnrolled(hasPasskeyUnlock())
    setStage(hasVault() ? "locked" : "setup")
  }, [])

  const lock = useCallback(
    (reason?: string) => {
      setPayload(null)
      setPassword("")
      setShowDerive(false)
      setShowBackup(false)
      setShowWatch(false)
      setWatchLabel("")
      setWatchAddress("")
      setWatchError("")
      // Passkey-enrollment dialog state: the typed password is a secret and
      // must never outlive the interaction that asked for it.
      setShowPasskeyEnroll(false)
      setPasskeyPassword("")
      setPasskeyError("")
      // Password-change dialog state, for the same reason: the current
      // password is a proof secret and the drafts must not outlive the
      // unlocked session that opened the dialog.
      setShowChangePassword(false)
      setChangePwCurrent("")
      setChangePwNext("")
      setChangePwConfirm("")
      setChangePwError("")
      // A recovered keystore key is a secret like any other; never let one
      // outlive the interaction that produced it.
      setSetupKeystore(null)
      setSetupKeystorePassword("")
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
        () =>
          lock(
            `Locked automatically after ${autolockMinutes} minute${
              autolockMinutes === 1 ? "" : "s"
            } of inactivity.`
          ),
        autolockMinutes * 60_000
      )
    }

    const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "focus"]
    events.forEach((event) => window.addEventListener(event, reset))
    reset()

    return () => {
      events.forEach((event) => window.removeEventListener(event, reset))
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [stage, lock, autolockMinutes])

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

  /**
   * Decrypt a keystore (V3) file during setup, feeding its key into the normal
   * "import existing" creation path.
   *
   * This exists because a keystore file is the one common key format a fresh
   * device has no other way to consume: the setup textarea accepts phrases and
   * raw keys, but pasting keystore JSON would only fail classification, and
   * the decrypted key must never be displayed — so it never touches the
   * textarea. Only the recovered address is shown; the key itself goes
   * straight into vault creation.
   */
  const handleUnlockSetupKeystore = useCallback(async () => {
    setError("")
    if (!setupKeystoreFile) {
      setError("Choose a keystore file first.")
      return
    }
    if (setupKeystoreFile.size > MAX_KEYSTORE_BYTES) {
      setError("That file is too large to be a keystore.")
      return
    }

    setBusy(true)
    try {
      const raw = await setupKeystoreFile.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        setError("This file is not valid JSON.")
        return
      }

      const opened = await decryptKeystore(parsed, setupKeystorePassword)
      if (!opened.ok) {
        setError(opened.error)
        return
      }

      setSetupKeystore(opened.value)
      setSetupKeystorePassword("")
    } catch {
      setError("Could not read that file.")
    } finally {
      setBusy(false)
    }
  }, [setupKeystoreFile, setupKeystorePassword])

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
    } else if (setupKeystore !== null) {
      // A keystore the user unlocked above: its key is already recovered and
      // validated, so it flows straight into the new vault without ever being
      // displayed.
      accounts = [
        {
          id: crypto.randomUUID?.() ?? `account-${Date.now()}`,
          label: "Imported keystore",
          address: setupKeystore.address,
          privateKey: setupKeystore.privateKey,
        },
      ]
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
    setSetupKeystore(null)
    setSetupKeystoreFile(null)
    setSetupKeystorePassword("")
    if (setupKeystoreFileRef.current) setupKeystoreFileRef.current.value = ""
  }, [
    acknowledged,
    bip39Passphrase,
    confirmPassword,
    draftPhrase,
    importInput,
    legacyCount,
    newPassword,
    setupKeystore,
    setupMode,
    strength,
  ])

  // ===== Unlock =====

  /**
   * Shared success path for every unlock (typed password or passkey).
   *
   * Folds any legacy cleartext wallets into the vault, then drops into the
   * unlocked stage. Busy state is the caller's concern: the password and
   * passkey flows report progress through different controls.
   */
  const completeUnlock = useCallback(
    async (candidate: string, opened: VaultPayload): Promise<void> => {
      if (legacyCount > 0) {
        const migrated = await migrateLegacyWallets(candidate, opened)
        if (migrated.ok && migrated.value.migrated > 0) {
          setLegacyCount(0)
          setNotice(
            `Secured ${migrated.value.migrated} wallet(s) that were previously stored unencrypted.`
          )
          const refreshed = await unlockVault(candidate)
          if (refreshed.ok) {
            setPayload(refreshed.value)
            setStage("unlocked")
            return
          }
        }
      }

      // Clear the "Wallet locked." notice left over from locking; showing it on
      // the unlocked screen would state the opposite of the current state.
      setNotice("")
      setPayload(opened)
      setStage("unlocked")
    },
    [legacyCount]
  )

  const handleUnlock = useCallback(async () => {
    setError("")
    setBusy(true)
    try {
      const opened = await unlockVault(password)
      if (!opened.ok) {
        setError(opened.error)
        return
      }
      await completeUnlock(password, opened.value)
    } finally {
      setBusy(false)
    }
  }, [password, completeUnlock])

  /**
   * Unlock via the passkey envelope.
   *
   * The ceremony unwraps the vault password, which then flows through the same
   * `completeUnlock` path as a typed password. A wrap that no longer opens the
   * vault (the password changed since enrollment) is reported as stale — fail
   * closed to the password path, never a bypass — with re-enrollment offered
   * from the unlocked view once the user is back in.
   */
  const handleUnlockWithPasskey = useCallback(async () => {
    setError("")
    setPasskeyBusy(true)
    try {
      const unwrapped = await unlockWithPasskey()
      if (!unwrapped.ok) {
        setError(unwrapped.error)
        return
      }

      const candidate = unwrapped.value
      const opened = await unlockVault(candidate)
      if (!opened.ok) {
        setError(
          "Passkey unlock no longer matches this vault. Unlock with your password, then remove and set up the passkey again."
        )
        return
      }

      // The password now exists in memory exactly as if typed: later re-seals
      // of the vault (add/remove account) need it, mirroring the typed path.
      setPassword(candidate)
      await completeUnlock(candidate, opened.value)
    } finally {
      setPasskeyBusy(false)
    }
  }, [completeUnlock])

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

  /**
   * Add a private key recovered from a keystore (V3) file to the unlocked vault.
   *
   * BackupManager owns the keystore format; this side receives the already
   * decrypted key and re-seals it under the vault password through the same
   * path every other imported key takes, so the key never touches storage in
   * the clear. The duplicate check runs here rather than inside
   * `addAccountsToVault`'s silent skip so the user hears "already present"
   * instead of nothing happening.
   */
  const handleImportKeystoreAccount = useCallback(
    async (
      recovered: RecoveredKeystoreAccount
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!payload) return { ok: false, error: "The vault is locked." }

      const duplicate = payload.accounts.some(
        (a) => a.address.toLowerCase() === recovered.address.toLowerCase()
      )
      if (duplicate) {
        return { ok: false, error: "An account with this address is already in the vault." }
      }

      setBusy(true)
      const result = await addAccountsToVault(
        payload,
        [
          {
            id: crypto.randomUUID?.() ?? `account-${Date.now()}`,
            label: "Imported keystore",
            address: recovered.address,
            privateKey: recovered.privateKey,
          },
        ],
        password
      )
      setBusy(false)

      if (!result.ok) return { ok: false, error: result.error }

      setPayload(result.value)
      return { ok: true }
    },
    [password, payload]
  )

  const handleRemove = useCallback(
    async (accountId: string) => {
      if (!payload) return

      const target = payload.accounts.find((a) => a.id === accountId)
      const confirmed = await confirmAction({
        message: "Remove this account from the vault?",
        description:
          target?.watchOnly
            ? // A watch-only entry holds nothing but an address and a label.
              "Only the address and its label are stored, so there is nothing to recover — you can add it back at any time."
            : "If it came from your recovery phrase you can derive it again. If it was imported as a private key, make sure that key is saved elsewhere first.",
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

  /**
   * Live validation state for the watch-address form.
   *
   * The in-form hint is convenience, not the security boundary: the address is
   * normalized and re-validated inside `vaultStore` before anything is written.
   */
  const watchAddressTrimmed = watchAddress.trim()
  const watchAddressValid = isEthAddress(watchAddressTrimmed)
  const watchAddressError =
    watchAddressTrimmed !== "" && !watchAddressValid
      ? "This is not a valid Ethereum address."
      : undefined
  const watchAddressHint =
    watchAddressValid && !isChecksummedAddress(watchAddressTrimmed)
      ? "Valid address. It will be stored in EIP-55 checksum form."
      : undefined

  const handleAddWatchAddress = useCallback(async () => {
    if (!payload) return
    setWatchError("")

    const address = watchAddress.trim()
    if (!isEthAddress(address)) {
      setWatchError("This is not a valid Ethereum address.")
      return
    }

    // Mirror the "Account N" / "Wallet N" convention when no label is given.
    const label =
      watchLabel.trim() ||
      `Watch ${payload.accounts.filter((account) => account.watchOnly).length + 1}`

    setBusy(true)
    const result = await addWatchOnlyAccountToVault(payload, { label, address }, password)
    setBusy(false)

    if (!result.ok) {
      setWatchError(result.error)
      return
    }
    setPayload(result.value)
    setShowWatch(false)
    setWatchLabel("")
    setWatchAddress("")
    setNotice("Added watch address.")
  }, [password, payload, watchAddress, watchLabel])

  /**
   * Apply a new idle auto-lock timeout.
   *
   * Persisted before the local value changes, so the visible control can never
   * claim a setting that failed to save. A refused write (full quota, blocked
   * storage) re-reads the stored value and surfaces the error.
   */
  const handleAutolockChange = useCallback((minutes: AutoLockMinutes) => {
    const written = persistAutolockMinutes(minutes)
    if (!written.ok) {
      setAutolockMinutes(getAutolockMinutes())
      setError(written.error)
      return
    }
    setAutolockMinutes(minutes)
  }, [])

  // ===== Passkey unlock (experimental) =====

  const closePasskeyEnroll = useCallback(() => {
    setShowPasskeyEnroll(false)
    setPasskeyPassword("")
    setPasskeyError("")
  }, [])

  /**
   * Enroll passkey unlock from the unlocked view.
   *
   * The dialog asks for the vault password even though the vault is unlocked:
   * wrapping the password into a passkey-opened envelope must require PROOF of
   * the password, not momentary access to an unlocked screen. The typed value
   * is verified against the stored vault, used for the ceremony, and cleared —
   * never kept longer than the interaction.
   */
  const handlePasskeyEnroll = useCallback(async () => {
    setPasskeyError("")
    if (passkeyPassword === "") {
      setPasskeyError("Enter your vault password.")
      return
    }

    setPasskeyBusy(true)
    try {
      // Verify before wrapping: a wrong password must never be baked into the
      // envelope, where it would silently break passkey unlock later.
      const verified = await unlockVault(passkeyPassword)
      if (!verified.ok) {
        setPasskeyError("Incorrect vault password.")
        return
      }

      const enrolled = await enrollPasskeyUnlock(passkeyPassword)
      if (!enrolled.ok) {
        setPasskeyError(enrolled.error)
        return
      }

      setPasskeyEnrolled(true)
      setShowPasskeyEnroll(false)
      notify.success(
        "Passkey unlock enabled",
        "You can now unlock the vault with this device's passkey. Your password always works too."
      )
    } finally {
      setPasskeyPassword("")
      setPasskeyBusy(false)
    }
  }, [passkeyPassword])

  const handlePasskeyRemove = useCallback(async () => {
    const confirmed = await confirmAction({
      message: "Remove passkey unlock?",
      description:
        "The passkey will no longer unlock this vault on this device. Your password and encrypted vault are unaffected.",
      confirmLabel: "Remove",
    })
    if (!confirmed) return

    removePasskeyUnlock()
    setPasskeyEnrolled(false)
    notify.info("Passkey unlock removed")
  }, [])

  // ===== Password change =====

  const closeChangePassword = useCallback(() => {
    setShowChangePassword(false)
    setChangePwCurrent("")
    setChangePwNext("")
    setChangePwConfirm("")
    setChangePwError("")
  }, [])

  /**
   * Change the vault password from the unlocked view.
   *
   * Ordering and failure policy:
   * - The typed CURRENT password is verified against the stored vault before
   *   anything else, mirroring the passkey enroll dialog: re-sealing the vault
   *   must require proof of the password, not momentary access to an unlocked
   *   screen. `changeVaultPassword` itself also refuses to write until the old
   *   password decrypts, so a wrong current password can never destroy the
   *   vault.
   * - A passkey envelope wraps the OLD password, so after a successful change
   *   it is stale and must be re-wrapped. A rewrap failure is a WARNING, not a
   *   failed password change — the vault already answers to the new password —
   *   and `rewrapPasskeyUnlock` removes the stale envelope itself, so the next
   *   unlock can never surface a confusing wrong-password error from the
   *   passkey path.
   * - The in-memory password (used to re-seal later account changes) is
   *   updated to the new one, or the next add/remove-account write would seal
   *   the vault with a password that no longer opens it.
   */
  const handleChangePassword = useCallback(async () => {
    setChangePwError("")

    if (changePwCurrent === "") {
      setChangePwError("Enter your current vault password.")
      return
    }
    if (!nextStrength.acceptable) {
      setChangePwError(nextStrength.issues[0] ?? "Choose a stronger password.")
      return
    }
    if (changePwNext !== changePwConfirm) {
      setChangePwError("The new passwords do not match.")
      return
    }

    setChangePwBusy(true)
    try {
      // Verify before changing: an unlocked screen must never be enough to
      // re-seal the vault under a different password.
      const verified = await unlockVault(changePwCurrent)
      if (!verified.ok) {
        setChangePwError("Incorrect vault password.")
        return
      }

      const changed = await changeVaultPassword(changePwCurrent, changePwNext)
      if (!changed.ok) {
        setChangePwError(changed.error)
        return
      }

      // Later re-seals (add/remove account) sign with the in-memory password;
      // it must follow the change or the next write would fail.
      setPassword(changePwNext)

      let passkeyNote: string | undefined
      if (hasPasskeyUnlock()) {
        const rewrapped = await rewrapPasskeyUnlock(changePwNext)
        if (rewrapped.ok) {
          passkeyNote = "Passkey unlock now wraps the new password."
        } else {
          // The rewrap removed the stale envelope itself. The password change
          // itself succeeded, so this is surfaced as a warning — never as a
          // failed change — with re-enrollment offered from the row below.
          setPasskeyEnrolled(false)
          notify.warning(
            "Passkey unlock removed",
            "Passkey unlock was removed because it could not be re-wrapped — set it up again if you want it."
          )
        }
      }

      closeChangePassword()
      notify.success("Vault password changed", passkeyNote)
    } finally {
      // The current password must never outlive the ceremony, success or not.
      setChangePwCurrent("")
      setChangePwBusy(false)
    }
  }, [changePwConfirm, changePwCurrent, changePwNext, closeChangePassword, nextStrength])

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
                  disabled={setupKeystore !== null}
                  className={`${inputClassName} resize-none font-mono text-sm`}
                />
              )}
            </Field>
          )}

          {setupMode === "import" && (
            <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Or import a keystore file (V3)
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  A keystore JSON from geth, MetaMask, or MyCrypto. Its key is decrypted here in
                  your browser and added to your new vault.
                </p>
              </div>

              {setupKeystore ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 break-all font-mono text-sm text-success">
                      {setupKeystore.address}
                    </p>
                    <CopyButton value={setupKeystore.address} label="address" />
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Keystore unlocked — only the address is shown. This account will be imported
                    into your new vault.
                  </p>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSetupKeystore(null)
                      setSetupKeystoreFile(null)
                      // Clear the picker too, or re-choosing the same file
                      // would not fire another change event.
                      if (setupKeystoreFileRef.current) setupKeystoreFileRef.current.value = ""
                    }}
                    fullWidth
                  >
                    Use a different keystore
                  </Button>
                </div>
              ) : (
                <>
                  <Field label="Keystore file" required>
                    {(props) => (
                      <input
                        {...props}
                        ref={setupKeystoreFileRef}
                        type="file"
                        accept="application/json,.json"
                        onChange={(e) => setSetupKeystoreFile(e.target.files?.[0] ?? null)}
                        className={cn(
                          inputClassName,
                          "cursor-pointer py-2 text-sm",
                          "file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
                        )}
                      />
                    )}
                  </Field>

                  <Field
                    label="Keystore password"
                    required
                    hint="The password set when this file was created — not the vault password you will choose below."
                  >
                    {(props) => (
                      <input
                        {...props}
                        {...secretInputProps}
                        type="password"
                        value={setupKeystorePassword}
                        onChange={(e) => setSetupKeystorePassword(e.target.value)}
                        className={inputClassName}
                      />
                    )}
                  </Field>

                  <Button
                    variant="outline"
                    onClick={() => void handleUnlockSetupKeystore()}
                    isLoading={busy}
                    loadingLabel="Decrypting…"
                    fullWidth
                    disabled={setupKeystoreFile === null || setupKeystorePassword === ""}
                    icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
                  >
                    Unlock keystore
                  </Button>
                </>
              )}
            </div>
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
        getExportAccount={() => activeAccount ?? null}
        onImportPrivateKey={handleImportKeystoreAccount}
      />
    </>
  )
}
