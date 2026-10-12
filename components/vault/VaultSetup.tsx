"use client"

/**
 * Vault setup stage: generate or import a recovery phrase (or a private
 * key / V3 keystore file), choose the vault password, and create the vault.
 *
 * Presentational half of the stage — all state and handlers live in
 * `WalletVault` and arrive here as props under their original names, so
 * this component owns no state and no side effects.
 */

import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react"
import { KeyRound, ShieldCheck } from "lucide-react"
import Button from "../ui/Button"
import { CardDescription, CardHeader, CardTitle } from "../ui/Card"
import Tabs from "../ui/Tabs"
import Field, { inputClassName, secretInputProps } from "../ui/Field"
import Alert from "../ui/Alert"
import SecretField from "../ui/SecretField"
import CopyButton from "../ui/CopyButton"
import { cn } from "@/lib/utils"
import { MNEMONIC_WORD_COUNTS, type MnemonicWordCount } from "@/lib/hdWallet"
import type { RecoveredKeystoreAccount } from "@/lib/keystore"
import type { PasswordStrength, SetupMode } from "./types"

/** Setup paths offered on a device with no vault yet. */
const SETUP_MODES = [
  { id: "generate", label: "Create new" },
  { id: "import", label: "Import existing" },
] as const satisfies readonly { id: SetupMode; label: string }[]

export interface VaultSetupProps {
  banners: ReactNode
  setupMode: SetupMode
  setSetupMode: Dispatch<SetStateAction<SetupMode>>
  setError: Dispatch<SetStateAction<string>>
  wordCount: MnemonicWordCount
  setWordCount: Dispatch<SetStateAction<MnemonicWordCount>>
  draftPhrase: string
  setDraftPhrase: Dispatch<SetStateAction<string>>
  handleGenerate: () => void
  acknowledged: boolean
  setAcknowledged: Dispatch<SetStateAction<boolean>>
  importInput: string
  setImportInput: Dispatch<SetStateAction<string>>
  setupKeystore: RecoveredKeystoreAccount | null
  setSetupKeystore: Dispatch<SetStateAction<RecoveredKeystoreAccount | null>>
  setSetupKeystoreFile: Dispatch<SetStateAction<File | null>>
  setupKeystoreFile: File | null
  setupKeystorePassword: string
  setSetupKeystorePassword: Dispatch<SetStateAction<string>>
  setupKeystoreFileRef: RefObject<HTMLInputElement | null>
  handleUnlockSetupKeystore: () => Promise<void>
  busy: boolean
  bip39Passphrase: string
  setBip39Passphrase: Dispatch<SetStateAction<string>>
  newPassword: string
  setNewPassword: Dispatch<SetStateAction<string>>
  confirmPassword: string
  setConfirmPassword: Dispatch<SetStateAction<string>>
  strength: PasswordStrength
  handleCreate: () => Promise<void>
}

export default function VaultSetup({
  banners,
  setupMode,
  setSetupMode,
  setError,
  wordCount,
  setWordCount,
  draftPhrase,
  setDraftPhrase,
  handleGenerate,
  acknowledged,
  setAcknowledged,
  importInput,
  setImportInput,
  setupKeystore,
  setSetupKeystore,
  setSetupKeystoreFile,
  setupKeystoreFile,
  setupKeystorePassword,
  setSetupKeystorePassword,
  setupKeystoreFileRef,
  handleUnlockSetupKeystore,
  busy,
  bip39Passphrase,
  setBip39Passphrase,
  newPassword,
  setNewPassword,
  confirmPassword,
  setConfirmPassword,
  strength,
  handleCreate,
}: VaultSetupProps) {
  return (
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
