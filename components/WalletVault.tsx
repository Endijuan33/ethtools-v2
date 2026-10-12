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
import Card from "./ui/Card"
import Alert from "./ui/Alert"
import { Spinner } from "./ui/Feedback"
import { confirmAction, notify } from "./ui/Toast"
import BackupManager from "./BackupManager"
import VaultSetup from "./vault/VaultSetup"
import VaultLocked from "./vault/VaultLocked"
import VaultUnlocked from "./vault/VaultUnlocked"
import DeriveAccountsDialog from "./vault/DeriveAccountsDialog"
import WatchAddressDialog from "./vault/WatchAddressDialog"
import PasskeyEnrollDialog from "./vault/PasskeyEnrollDialog"
import ChangePasswordDialog from "./vault/ChangePasswordDialog"
import type { SetupMode, Stage } from "./vault/types"
import { assessPassword, isVaultSupported } from "@/lib/vault"
import { decryptKeystore, MAX_KEYSTORE_BYTES, type RecoveredKeystoreAccount } from "@/lib/keystore"
import {
  DEFAULT_PRESET_ID,
  classifySecret,
  deriveAccounts,
  deriveFromPrivateKey,
  generateMnemonic,
  getPreset,
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
  DEFAULT_AUTOLOCK_MINUTES,
  isChecksummedAddress,
  isEthAddress,
  type AutoLockMinutes,
  type VaultAccount,
  type VaultPayload,
} from "@/lib/schema"


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
        setLegacyCount(migrated.value.skipped)
        if (migrated.value.migrated > 0) {
          setNotice(
            `Secured ${migrated.value.migrated} wallet(s) that were previously stored unencrypted.`
          )
        }
        if (migrated.value.skipped > 0) {
          setError(
            `${migrated.value.skipped} older wallet record(s) could not be migrated because their key data is not usable. They were left untouched so nothing is lost; remove or repair them from the Balances panel.`
          )
        }
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
        if (migrated.ok) {
          setLegacyCount(migrated.value.skipped)
          if (migrated.value.skipped > 0) {
            setError(
              `${migrated.value.skipped} older wallet record(s) could not be migrated because their key data is not usable. They were left untouched so nothing is lost.`
            )
          }
          if (migrated.value.migrated > 0) {
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
      <VaultSetup
        banners={banners}
        setupMode={setupMode}
        setSetupMode={setSetupMode}
        setError={setError}
        wordCount={wordCount}
        setWordCount={setWordCount}
        draftPhrase={draftPhrase}
        setDraftPhrase={setDraftPhrase}
        handleGenerate={handleGenerate}
        acknowledged={acknowledged}
        setAcknowledged={setAcknowledged}
        importInput={importInput}
        setImportInput={setImportInput}
        setupKeystore={setupKeystore}
        setSetupKeystore={setSetupKeystore}
        setSetupKeystoreFile={setSetupKeystoreFile}
        setupKeystoreFile={setupKeystoreFile}
        setupKeystorePassword={setupKeystorePassword}
        setSetupKeystorePassword={setSetupKeystorePassword}
        setupKeystoreFileRef={setupKeystoreFileRef}
        handleUnlockSetupKeystore={handleUnlockSetupKeystore}
        busy={busy}
        bip39Passphrase={bip39Passphrase}
        setBip39Passphrase={setBip39Passphrase}
        newPassword={newPassword}
        setNewPassword={setNewPassword}
        confirmPassword={confirmPassword}
        setConfirmPassword={setConfirmPassword}
        strength={strength}
        handleCreate={handleCreate}
      />
    )
  }

  if (stage === "locked") {
    return shell(
      <VaultLocked
        banners={banners}
        passkeyEnrolled={passkeyEnrolled}
        handleUnlockWithPasskey={handleUnlockWithPasskey}
        passkeyBusy={passkeyBusy}
        password={password}
        setPassword={setPassword}
        handleUnlock={handleUnlock}
        busy={busy}
        setShowBackup={setShowBackup}
        backupManager={
          <BackupManager
            isOpen={showBackup}
            onClose={() => setShowBackup(false)}
            reservedNetworkKeys={RESERVED_NETWORK_KEYS}
          />
        }
      />
    )
  }

  // stage === "unlocked"
  return shell(
    <>
      <VaultUnlocked
        banners={banners}
        payload={payload}
        activeAccount={activeAccount}
        setActiveId={setActiveId}
        setActiveAccountId={setActiveAccountId}
        handleRemove={handleRemove}
        lock={lock}
        setShowBackup={setShowBackup}
        setShowDerive={setShowDerive}
        setShowWatch={setShowWatch}
        autolockMinutes={autolockMinutes}
        handleAutolockChange={handleAutolockChange}
        passkeyEnrolled={passkeyEnrolled}
        passkeySupported={passkeySupported}
        handlePasskeyRemove={handlePasskeyRemove}
        setShowPasskeyEnroll={setShowPasskeyEnroll}
        setShowChangePassword={setShowChangePassword}
      />
      <DeriveAccountsDialog
        showDerive={showDerive}
        setShowDerive={setShowDerive}
        payload={payload}
        handleImportDerived={handleImportDerived}
      />
      <WatchAddressDialog
        showWatch={showWatch}
        setShowWatch={setShowWatch}
        handleAddWatchAddress={handleAddWatchAddress}
        busy={busy}
        watchError={watchError}
        watchLabel={watchLabel}
        setWatchLabel={setWatchLabel}
        watchAddressError={watchAddressError}
        watchAddressHint={watchAddressHint}
        watchAddressValid={watchAddressValid}
        watchAddress={watchAddress}
        setWatchAddress={setWatchAddress}
        setWatchError={setWatchError}
        watchAddressTrimmed={watchAddressTrimmed}
      />
      <PasskeyEnrollDialog
        showPasskeyEnroll={showPasskeyEnroll}
        closePasskeyEnroll={closePasskeyEnroll}
        handlePasskeyEnroll={handlePasskeyEnroll}
        passkeyBusy={passkeyBusy}
        passkeyPassword={passkeyPassword}
        setPasskeyPassword={setPasskeyPassword}
        passkeyError={passkeyError}
        setPasskeyError={setPasskeyError}
      />
      <ChangePasswordDialog
        showChangePassword={showChangePassword}
        closeChangePassword={closeChangePassword}
        handleChangePassword={handleChangePassword}
        changePwBusy={changePwBusy}
        changePwError={changePwError}
        changePwCurrent={changePwCurrent}
        setChangePwCurrent={setChangePwCurrent}
        changePwNext={changePwNext}
        setChangePwNext={setChangePwNext}
        changePwConfirm={changePwConfirm}
        setChangePwConfirm={setChangePwConfirm}
        setChangePwError={setChangePwError}
        nextStrength={nextStrength}
        passkeyEnrolled={passkeyEnrolled}
      />
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
