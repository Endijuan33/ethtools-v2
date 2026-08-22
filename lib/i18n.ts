/**
 * Internationalization scaffolding.
 *
 * The app ships English only. The purpose of this module is to make adding a
 * locale a contained change rather than a hunt through JSX: strings shared
 * across components live here, keys are typed so a missing or misspelled key is
 * a compile error, and interpolation is explicit.
 *
 * To add a locale:
 *   1. Add its code to {@link SUPPORTED_LOCALES}.
 *   2. Add a `Messages` object for it to {@link catalogs}. TypeScript will list
 *      every key you have not translated.
 *   3. Call {@link setLocale} from the UI.
 *
 * Number, currency, and date formatting is handled by `Intl` in `lib/format.ts`
 * and already follows the user's locale, so it is intentionally not duplicated
 * here.
 */

/** Locales with a complete catalog. */
export const SUPPORTED_LOCALES = ["en"] as const

/** A locale with a complete catalog. */
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** Fallback used when a locale is unset or unrecognized. */
export const DEFAULT_LOCALE: Locale = "en"

/**
 * English message catalog. This is the reference catalog: its keys define the
 * `MessageKey` union, so every other locale must supply the same set.
 *
 * `{name}` placeholders are substituted by {@link t}.
 */
const en = {
  // Generic actions
  "action.cancel": "Cancel",
  "action.close": "Close",
  "action.confirm": "Confirm",
  "action.continue": "Continue",
  "action.copy": "Copy",
  "action.copied": "Copied",
  "action.delete": "Delete",
  "action.retry": "Retry",
  "action.save": "Save",
  "action.back": "Back",

  // Generic states
  "state.loading": "Loading…",
  "state.empty": "Nothing here yet",
  "state.error": "Something went wrong",
  "state.unavailable": "Unavailable",

  // Secret handling
  "secret.reveal": "Reveal",
  "secret.hide": "Hide",
  "secret.hidden": "Hidden for your security",
  "secret.copyWarning":
    "Copying places this secret on your system clipboard, where other apps can read it.",
  "secret.screenWarning": "Make sure nobody can see your screen before revealing this.",

  // Vault
  "vault.password": "Password",
  "vault.confirmPassword": "Confirm password",
  "vault.unlock": "Unlock",
  "vault.lock": "Lock",
  "vault.locked": "Wallet locked",
  "vault.create": "Create a password",
  "vault.passwordMismatch": "Passwords do not match.",
  "vault.wrongPassword": "Incorrect password.",
  "vault.noRecovery":
    "This password cannot be recovered. If you lose it, you lose access to the accounts stored here.",
  "vault.autoLocked": "Locked automatically after inactivity.",

  // Recovery phrases and accounts
  "hd.recoveryPhrase": "Recovery phrase",
  "hd.passphrase": "BIP-39 passphrase (optional)",
  "hd.passphraseHint":
    "Sometimes called the 25th word. A different passphrase produces entirely different accounts.",
  "hd.derivationPath": "Derivation path",
  "hd.accountIndex": "Account index",
  "hd.deriveMore": "Derive more accounts",
  "hd.selectAccounts": "Select the accounts to import",
  "hd.noAccountsSelected": "Select at least one account.",

  // Backup
  "backup.export": "Export backup",
  "backup.import": "Restore backup",
  "backup.encrypted": "Encrypted backup",
  "backup.settingsOnly": "Settings only",
  "backup.containsKeys":
    "This file contains your accounts and recovery phrase. Anyone who obtains both the file and its password controls your funds.",
  "backup.settingsOnlyNote":
    "Contains bookmarks, networks, tokens, and history. No keys or recovery phrase.",
  "backup.replaceWarning": "Restoring in replace mode permanently overwrites existing data.",
  "backup.droppedRecords": "{count} record(s) were unreadable and were skipped.",

  // Validation
  "validation.required": "This field is required.",
  "validation.invalidAddress": "Enter a valid Ethereum address.",
  "validation.invalidAmount": "Enter a valid amount.",
  "validation.httpsRequired": "Only https:// URLs are accepted.",

  // Dev tools
  "devtools.title": "Developer tools",
  "devtools.unitConverter": "Unit converter",
  "devtools.ensLookup": "ENS lookup",
  "devtools.calldataDecoder": "Calldata decoder",
  "devtools.ensMainnetNote": "ENS always resolves on Ethereum mainnet.",
} as const

/** Every key present in the reference catalog. */
export type MessageKey = keyof typeof en

/** A complete catalog for one locale. */
export type Messages = Record<MessageKey, string>

/**
 * All catalogs. Adding a locale here without translating every key is a
 * compile error, which is the point.
 */
const catalogs: Record<Locale, Messages> = { en }

let activeLocale: Locale = DEFAULT_LOCALE

/**
 * Set the active locale.
 * @param locale - Locale code; ignored if it has no catalog.
 */
export function setLocale(locale: string): void {
  if ((SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    activeLocale = locale as Locale
  }
}

/** The active locale. */
export function getLocale(): Locale {
  return activeLocale
}

/**
 * Pick the best supported locale for a browser's preference list.
 *
 * Matches on the language subtag, so `en-GB` resolves to `en`.
 *
 * @param preferred - Values from `navigator.languages`.
 */
export function resolveLocale(preferred: readonly string[]): Locale {
  for (const candidate of preferred) {
    const base = candidate.toLowerCase().split("-")[0]
    if ((SUPPORTED_LOCALES as readonly string[]).includes(base)) {
      return base as Locale
    }
  }
  return DEFAULT_LOCALE
}

/**
 * Look up a message and substitute `{placeholder}` values.
 *
 * Falls back to the English string when a locale is missing a key, and to the
 * key itself if even that is absent, so the UI degrades to something
 * diagnosable rather than blank.
 *
 * @param key - Message key.
 * @param params - Values substituted into `{name}` placeholders.
 */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const template = catalogs[activeLocale][key] ?? en[key] ?? key
  if (!params) return template

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Choose a singular or plural form.
 *
 * Deliberately minimal: English has two forms. A locale with more categories
 * needs `Intl.PluralRules`, which is the natural place to extend this.
 *
 * @param count - Quantity deciding the form.
 * @param singular - Form used when `count` is exactly 1.
 * @param plural - Form used otherwise.
 */
export function plural(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
}
