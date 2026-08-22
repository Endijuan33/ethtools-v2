"use client"

/**
 * Derive and select multiple accounts from one recovery phrase.
 *
 * This is the feature the encrypted vault exists to support. Persisting a
 * recovery phrase is what makes deriving account N possible later, and a phrase
 * compromises every account derivable from it, so it must never be stored in
 * cleartext.
 *
 * Derivation runs in `lib/hdWallet.ts`, which computes the seed once and reuses it
 * across indices. Deriving each account from the phrase would re-run PBKDF2 per
 * account and stall the main thread on mobile.
 */

import { useCallback, useMemo, useState } from "react"
import { KeyRound, Plus } from "lucide-react"
import Field, { inputClassName, monoInputClassName, secretInputProps } from "./ui/Field"
import Button from "./ui/Button"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import { EmptyState } from "./ui/Feedback"
import { SkeletonGroup, Skeleton } from "./ui/Skeleton"
import { truncateHex } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  DEFAULT_PRESET_ID,
  DERIVATION_PRESETS,
  deriveAccounts,
  getPreset,
  validateDerivationPath,
  validateMnemonic,
  type DerivedAccount,
} from "@/lib/hdWallet"

/** Accounts derived per page of results. */
const PAGE_SIZE = 5

export interface AccountDiscoveryProps {
  /** Recovery phrase to derive from. Held in memory only. */
  mnemonic: string
  /** BIP-39 passphrase, if the phrase has one. */
  passphrase?: string
  /** Addresses already imported, shown as unavailable. */
  existingAddresses?: readonly string[]
  /** Receives the accounts the user chose to import. */
  onImport: (accounts: DerivedAccount[]) => void
  /** Optional cancel affordance. */
  onCancel?: () => void
}

/** Placeholder rows shown while key derivation blocks the main thread. */
function DerivationSkeleton() {
  return (
    <SkeletonGroup label="Deriving accounts" className="space-y-2">
      {Array.from({ length: PAGE_SIZE }, (_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-lg bg-muted/30 p-3">
          <Skeleton className="h-4 w-4 rounded" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  )
}

export default function AccountDiscovery({
  mnemonic,
  passphrase = "",
  existingAddresses = [],
  onImport,
  onCancel,
}: AccountDiscoveryProps) {
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID)
  const [customTemplate, setCustomTemplate] = useState("")
  const [useCustom, setUseCustom] = useState(false)
  const [accounts, setAccounts] = useState<DerivedAccount[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const phraseValid = useMemo(() => validateMnemonic(mnemonic).ok, [mnemonic])

  const alreadyImported = useMemo(
    () => new Set(existingAddresses.map((address) => address.toLowerCase())),
    [existingAddresses]
  )

  const template = useCustom ? customTemplate : (getPreset(presetId)?.template ?? "")

  /**
   * Derive the next page.
   *
   * Deferred by a tick so the busy state paints before the synchronous key
   * derivation blocks the main thread.
   */
  const derivePage = useCallback(
    (reset: boolean) => {
      setError("")

      if (useCustom) {
        if (!customTemplate.includes("{index}")) {
          setError("Custom path must contain {index}, for example m/44'/60'/0'/0/{index}.")
          return
        }
        const probe = validateDerivationPath(customTemplate.replace("{index}", "0"))
        if (!probe.ok) {
          setError(probe.error)
          return
        }
      }

      setBusy(true)
      const startIndex = reset ? 0 : accounts.length

      setTimeout(() => {
        const result = deriveAccounts({
          mnemonic,
          passphrase,
          template,
          startIndex,
          count: PAGE_SIZE,
        })

        if (!result.ok) {
          setError(result.error)
        } else {
          setAccounts((current) => (reset ? result.value : [...current, ...result.value]))
          if (reset) setSelected(new Set())
        }
        setBusy(false)
      }, 0)
    },
    [accounts.length, customTemplate, mnemonic, passphrase, template, useCustom]
  )

  const toggle = (address: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(address)) next.delete(address)
      else next.add(address)
      return next
    })
  }

  const chosen = accounts.filter((account) => selected.has(account.address))

  if (!phraseValid) {
    return (
      <Alert tone="danger" title="No usable recovery phrase.">
        Unlock a wallet that was created from a recovery phrase to derive additional accounts.
      </Alert>
    )
  }

  return (
    <div className="space-y-4">
      <Alert tone="info">
        Every account below comes from the same recovery phrase. One backup of that phrase
        recovers all of them.
      </Alert>

      <Field
        label="Derivation path"
        hint="Wallets differ here. If a recovered address looks wrong, try another layout."
      >
        {(props) => (
          <select
            {...props}
            value={useCustom ? "custom" : presetId}
            onChange={(event) => {
              if (event.target.value === "custom") {
                setUseCustom(true)
                if (customTemplate === "") setCustomTemplate("m/44'/60'/0'/0/{index}")
              } else {
                setUseCustom(false)
                setPresetId(event.target.value)
              }
              setAccounts([])
              setSelected(new Set())
            }}
            className={inputClassName}
          >
            {DERIVATION_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} — {preset.template}
              </option>
            ))}
            <option value="custom">Custom path…</option>
          </select>
        )}
      </Field>

      {!useCustom && (
        <p className="text-xs text-muted-foreground">{getPreset(presetId)?.description}</p>
      )}

      {useCustom && (
        <Field
          label="Custom path template"
          hint="Use {index} where the account number belongs."
          required
        >
          {(props) => (
            <input
              {...props}
              {...secretInputProps}
              type="text"
              value={customTemplate}
              onChange={(event) => {
                setCustomTemplate(event.target.value)
                setAccounts([])
              }}
              placeholder="m/44'/60'/0'/0/{index}"
              className={monoInputClassName}
            />
          )}
        </Field>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {accounts.length === 0 ? (
        busy ? (
          <DerivationSkeleton />
        ) : (
          <EmptyState
            icon={<KeyRound className="h-5 w-5" />}
            title="No accounts derived yet"
            description="Derive addresses from this recovery phrase, then choose which to import."
            action={
              <Button onClick={() => derivePage(true)}>Derive first {PAGE_SIZE} accounts</Button>
            }
          />
        )
      ) : (
        <>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium text-foreground">
              Select accounts to import
            </legend>

            {accounts.map((account) => {
              const imported = alreadyImported.has(account.address.toLowerCase())
              const checked = selected.has(account.address)
              return (
                <label
                  key={account.address}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-3 transition-colors",
                    imported
                      ? "cursor-not-allowed border-border/50 bg-muted/20 opacity-60"
                      : checked
                        ? "cursor-pointer border-primary/40 bg-primary/10"
                        : "cursor-pointer border-border bg-muted/30 hover:bg-muted/50"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={imported}
                    onChange={() => toggle(account.address)}
                    className="h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-sm text-foreground">
                      {truncateHex(account.address, 10, 8)}
                    </span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {account.path}
                    </span>
                  </span>
                  {imported && <Badge tone="neutral">Imported</Badge>}
                </label>
              )
            })}
          </fieldset>

          {busy ? (
            <DerivationSkeleton />
          ) : (
            <Button
              variant="outline"
              onClick={() => derivePage(false)}
              fullWidth
              icon={<Plus className="h-4 w-4" aria-hidden="true" />}
            >
              Derive {PAGE_SIZE} more
            </Button>
          )}

          <div className="flex gap-3 border-t border-border pt-4">
            {onCancel && (
              <Button variant="secondary" onClick={onCancel} fullWidth>
                Cancel
              </Button>
            )}
            <Button onClick={() => onImport(chosen)} disabled={chosen.length === 0} fullWidth>
              {chosen.length > 0 ? `Import ${chosen.length}` : "Import selected"}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
