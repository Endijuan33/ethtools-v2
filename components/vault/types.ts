/**
 * Shared types for the vault component family (`WalletVault` and the
 * presentational stage/dialog components under `components/vault/`).
 */

export type Stage = "checking" | "setup" | "locked" | "unlocked"
export type SetupMode = "generate" | "import"

/** Password assessment, as produced by `assessPassword` in `lib/vault`. */
export type PasswordStrength = ReturnType<typeof import("@/lib/vault").assessPassword>
