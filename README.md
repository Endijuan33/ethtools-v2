# EthTools

A client-side Ethereum wallet utility. Derive addresses, generate wallets, manage encrypted accounts across 30 networks, sweep funds, and decode calldata — entirely in the browser.

**All cryptography runs locally.** No key, recovery phrase, or password is transmitted to any server. Read [Security model](#security-model) before using this with real funds — it states plainly what is and is not protected.

---

## Features

### Encrypted vault
- Accounts are encrypted at rest with **AES-256-GCM**, keyed by **PBKDF2-HMAC-SHA256 at 600,000 iterations** via WebCrypto.
- A password is required to unlock. It is never stored or transmitted and **cannot be recovered**.
- The vault locks automatically after 5 minutes of inactivity (configurable), after the tab has been hidden for over a minute, and in every open tab when any tab locks or erases.
- Wallets left over from an earlier, unencrypted version are detected and migrated on first unlock; the plaintext copies are deleted only after the encrypted copy is written and verified.

### Hierarchical deterministic wallets
- All five BIP-39 phrase lengths: **12, 15, 18, 21, and 24 words**.
- **BIP-39 passphrase** support (the "25th word").
- Derive many accounts from one phrase, with three path layouts: BIP-44 (`m/44'/60'/0'/0/{index}`), Ledger Live (`m/44'/60'/{index}'/0/0`), and legacy MEW/Ledger (`m/44'/60'/0'/{index}`). Custom templates are also accepted.
- Derivation is verified against the published Hardhat test vectors.

### Multi-network balances
- 30 built-in networks (20 mainnet, 10 testnet), plus custom networks.
- Add custom networks. RPC and explorer URLs must be `https:`; anything else is rejected.
- Per-network RPC pools with **real per-request retry and failover**, plus a health indicator derived from actual request outcomes.
- Balance polling pauses entirely while the tab is hidden.

### Transactions
- Native transfers with gas estimation and a "Max" calculation that reserves headroom for base-fee movement and L2 data fees.
- Gas estimation failure **blocks the send** rather than broadcasting a transaction expected to revert.
- A transaction is recorded as `success` only when a receipt confirms it. An unobtainable receipt is recorded as `unknown`, never as success.
- Broadcasting deliberately does **not** fail over, because retrying an ambiguous timeout could submit twice.

### Backup and recovery
- **Encrypted file backup** containing accounts and recovery phrase, protected by a password.
- **Settings-only backup** that is structurally incapable of holding secrets — useful for moving bookmarks and networks between devices.
- **Encrypted QR backup** for offline or printed storage.
- Restore validates every record, shows exactly what will be written, and offers merge or replace. Writes are atomic and roll back on partial failure.
- Restoring an encrypted backup **seals its accounts and recovery phrase into the encrypted vault** — creating a vault if none exists, or verifying the existing vault password first — and the sealed write is decrypt-verified before the restore reports success. Erase-all also disconnects WalletConnect and deletes its browser storage.

### Developer tools
- **Unit converter** — bigint-exact wei/gwei/ether conversion; no floating point anywhere.
- **ENS lookup** — forward and reverse, always resolved on Ethereum mainnet. Reverse records are forward-confirmed, and an unverified name is labelled as such.
- **Calldata decoder** — decodes with a supplied ABI, or names the function from a built-in selector table. Also decodes `Error(string)`, `Panic(uint256)`, and custom errors.

### Interface
- Light, dark, and system themes. Every colour resolves through design tokens; all 14 semantic token pairs meet WCAG AA contrast (≥4.5:1) in both themes.
- Mobile-first. Dialogs render as bottom sheets on touch viewports and centred dialogs on desktop.
- Full keyboard support: focus traps, roving-tabindex tab strips, Escape handling, and visible focus rings.
- Error boundaries around each panel, so one failure cannot blank the dashboard.
- Offline detection that distinguishes "you are offline" from "this RPC is down".

---

## Getting started

### Prerequisites
- **Node.js** 18.17 or newer
- **pnpm** (recommended), npm, or Yarn

### Setup

```bash
git clone https://github.com/Endijuan33/ethtools-v2.git
cd ethtools-v2
pnpm install
cp .env.example .env.local   # optional; sensible defaults apply
pnpm dev
```

The app runs at `http://localhost:3000`.

> **WebCrypto requires a secure context.** `localhost` counts as secure, so local development works. A non-HTTPS deployment on any other host disables the vault rather than falling back to storing keys unprotected.

### Environment variables

All variables are optional and all are `NEXT_PUBLIC_*`, meaning they are **inlined into the client bundle and are not secret**. Never place an API key or any key material in them.

| Variable | Purpose | Default |
|---|---|---|
| `NEXT_PUBLIC_ROUTESCAN_MAINNET_URL` | Explorer for the Converter/Generator panels | `https://routescan.io` |
| `NEXT_PUBLIC_ROUTESCAN_TESTNET_URL` | Testnet explorer | `https://testnet.routescan.io` |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for metadata | Vercel host, else production URL |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Reown (WalletConnect) project id — a public identifier, not a secret | Project owner's id |
| `NEXT_PUBLIC_INFURA_PROJECT_ID` | Infura project id for built-in RPC lists — a public identifier, not a secret | Project owner's id |
| `PNPM_APPROVE_BUILD` | Lets pnpm run dependency build scripts on Vercel | — |

The `_URL` suffix matters. An earlier version of this file documented the names without it, so the values silently never applied.

---

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Development server |
| `pnpm build` | Production build |
| `pnpm start` | Serve a production build |
| `pnpm lint` | ESLint (flat config, ESLint CLI) |
| `pnpm audit:osv` | Scan every lockfile package against OSV; fails on unignored advisories |
| `pnpm typecheck` | `tsc --noEmit` across the app |
| `pnpm test` | Compile `lib/` to CommonJS and run the unit suite |
| `pnpm verify` | typecheck + lint + test |

### Tests

716 unit tests across 43 files cover the logic layer — the pure `lib/` modules directly, plus source-structure regression guards for critical component wiring (erase/restore/sweep/session sync), which is the layer the current harness can reach; there is no DOM component-test layer yet. They compile `lib/` to CommonJS in `.test-build/` and run on the Node built-in test runner, so no test framework is installed. Largest suites:

| Module | Tests | Focus |
|---|---:|---|
| `walletConnect` | 56 | Session requests, signing methods, broadcast-once signing |
| `approvals` | 40 | Allowance discovery, revocation ceremony |
| `calldata` | 38 | Selector extraction, ABI decode, revert reasons |
| `units` | 32 | Bigint-exact conversion, truncation direction |
| `priceHistory` / `multiRpc` | 58 | Price series handling; failover, benching, timeouts, abort, no-retry broadcast |
| `addressGuard` | 24 | Address-poisoning screening |
| `hdWallet` | 23 | Published BIP-44 vectors, all five phrase lengths, passphrases |
| `vault` / `vaultStore` | 38 | AES-GCM round trip, wrong password, plaintext migration |
| `legacyMigration` | 7 | Idempotent migration, invalid-record quarantine, derived-address correction, failure rollback, undetected-entry preservation |
| `arcDecimals` | 3 | Arc native USDC pinned to 18 decimals (not the ERC-20 6) |
| `backup` | 19 | Encryption round trip, malicious-import rejection |
| `ens` | 18 | Result-union contract, forward confirmation, late rejections |
| `format` | 15 | Never rounds a balance up; dust is distinguishable from zero |
| `storage` / `schema` | 28 | Quota handling, atomic rollback, hostile-URL rejection |
| `logger` | 11 | Redaction of keys, API keys, and nested error stacks |
| `noPlaintextStorage` | 4 | Structural guard: no component may write the legacy cleartext key |
| `vaultRestore` | 9 | Backup-secret reseal: create/locked/unlocked scenarios, mnemonic-conflict refusal, verify-by-redecryption |
| `csp` / `frameEmbed` | 10 | Document + frame CSP builders, matcher guard, frame origin resolution |
| `vaultSession` / `clipboardConfirm` | 8 | Cross-tab event parsing, hidden-lock threshold, clipboard-clear decision, confirmation dedupe |
| `reauditRegression` | 10 | Structural wiring guards for the 2026-10 re-audit fixes (RA-01/02/03/04/05/06/07/11/12) |

---

## Architecture

Next.js 15.5 (App Router) and React 19. There is no backend: the only route handler serves the Farcaster embed document, generated dynamically so it follows the deployment's own origin.

```
app/
  layout.tsx          Root layout, theme provider, toast host
  page.tsx            Dashboard shell: header, nav rail, lazy-loaded panels
  client-layout.tsx   Farcaster Mini App integration
  error.tsx           Route-level error boundary
  global-error.tsx    Root-layout error boundary (self-contained)
  globals.css         Design tokens (light + dark) and base styles
  api/frame/route.ts  Dynamic Farcaster embed document (origin-aware)

components/
  ui/                 Design system: Button, Card, Field, ResponsiveDialog,
                      SecretField, Tabs, Toast, Skeleton, Badge, Alert…
  WalletVault.tsx     Encrypted vault: create, unlock, accounts, auto-lock
  vault/              Vault sub-components (setup, locked, unlocked, dialogs)
  WalletCard.tsx      Multi-network balances (address-only)
  SweepCard.tsx       Whole-account sweep to one destination
  DevToolsCard.tsx    Units, ENS, calldata
  ...

lib/
  vault.ts            AES-256-GCM + PBKDF2 envelope encryption
  vaultStore.ts       Vault persistence and legacy migration
  storage.ts          Validated, quota-safe, atomic localStorage access
  schema.ts           Runtime validators for every trust boundary
  logger.ts           Redacting logger; raw console.* is banned
  multiRpc.ts         RPC pool with per-request failover
  ethers.ts           Network registry and pooled chain access
  hdWallet.ts         BIP-32/39/44 derivation; secret classification
  format.ts           Bigint-exact value formatting
  backup.ts           Encrypted export/import
  units.ts  ens.ts  calldata.ts   Developer tools
  i18n.ts             Typed message catalogue (English only so far)
```

### Design principles

**Trust boundaries are validated.** `localStorage` is writable by anything running on the origin, and a backup file is arbitrary user input. Both pass through `lib/schema.ts`, which rejects non-`https:` URLs, malformed records, and custom networks that would shadow a built-in key.

**Money is `bigint`.** Balances and amounts are only converted to a string for display, and display always truncates toward zero. Rounding a balance up would show funds the user does not have.

**Secrets stay out of the DOM.** `SecretField` does not render a hidden secret at all — a CSS blur is a visual effect, not an access control.

**Logs cannot leak.** `lib/logger.ts` redacts key-length hex, API keys in RPC paths, query credentials, and base64 blobs, recursively and depth-bounded, including error stacks. Ethereum addresses are deliberately preserved because they are public and are the most useful diagnostic field.

---

## Security model

### What is protected

- Key derivation, signing, and encryption run **only in the browser**. No key material is sent anywhere.
- Vault contents are encrypted at rest with AES-256-GCM under a PBKDF2-derived key (600,000 iterations). A wrong password or a tampered payload fails the GCM authentication check.
- Untrusted iteration counts are bounds-checked, so a hostile backup cannot wedge the browser with an absurd work factor.
- Secret inputs set `autoComplete`, `autoCorrect`, `autoCapitalize`, and `spellCheck="false"`, preventing mobile keyboards and spell-checkers from transmitting typed phrase words to third-party prediction services.
- Copying a secret to the clipboard requires an explicit confirmation that names the risk, and the copy is cleared automatically after 45 seconds when the clipboard still holds it.
- Private keys pasted into the standalone dev-tool signers are held only in tab memory: they are cleared after signing, after 5 idle minutes, and whenever the vault locks in any tab. They are never stored.
- Revealed secrets auto-hide on a visible countdown.

### What leaves the device

Keys, phrases, and passwords never leave the browser - but **addresses and queries do**, because the app has no backend of its own:

- Public RPC providers see the addresses whose balances and allowances are read, and the transactions that are broadcast.
- Blockscout-family explorers see addresses scanned for token discovery and approval history.
- CoinGecko sees the assets whose prices are requested.
- WalletConnect relays see session metadata for dApp connections, and `chainid.network` is fetched when pre-filling custom-RPC metadata.

Those services can correlate an address with a visitor's IP address and the time of the request. That is inherent to a client-side tool with public infrastructure; use a VPN or your own RPC endpoints if that correlation matters to you. The same disclosure is available in the app itself (footer → **Privacy**), including the honest limitation that there is no mode that routes every request exclusively through an RPC you control.

The app also ships shared **public** project identifiers (an Infura project id and a Reown/WalletConnect project id). They name the app to those services and appear in request URLs; they are not credentials. The project owner should restrict the Infura id to this app's domains in the Infura dashboard — that allowlist lives in the Infura account and cannot be set from this repository. Explorer pages are only opened when you tap a link or start a scan, never in the background.

### What is not protected — read this

- **Wallets imported by pre-vault versions may still sit in `localStorage` in cleartext until they are migrated.** The Balances panel no longer creates, reads into state, or signs with those keys: it displays only their public addresses. Creating or unlocking the encrypted vault (the **Vault** panel) migrates them automatically - records are validated, the encrypted copy is written and verified first, and only then is the plaintext removed. Records whose key data is unusable are left untouched and reported, never silently discarded. Until migration happens, treat those specific wallets as exposed.
- **A Content-Security-Policy is deployed, but it is not a complete XSS defence.** The production policy (issued per request by `middleware.ts`, built in `lib/csp.ts`) is nonce-based: `script-src 'self' 'nonce-…' 'strict-dynamic'` with no `'unsafe-inline'` for scripts (styles keep it; style injection cannot execute code). The cacheable Farcaster frame route gets its own nonce-free policy. Any successful script injection that somehow bypassed the policy would still have full access to `localStorage`, including the encrypted vault ciphertext — the CSP raises the bar, it does not make a compromised origin safe.
- **A password cannot be recovered.** Lose it and the accounts in that vault are unrecoverable.
- **An encrypted backup file plus its password equals full control of the funds.** Store them separately.
- **`localStorage` is not secure storage.** It is readable by any script on the origin and by browser extensions with storage permission. Encryption at rest raises the bar; it does not make a shared or compromised device safe.

### Recommended practice

- Use a hardware wallet for significant funds. This tool is best suited to development, testing, and recovery.
- Verify the URL before entering a phrase.
- Keep offline backups, and verify a backup restores before relying on it.
- Prefer a dedicated browser profile.

---

## Deployment

### Vercel

1. Push to a Git repository.
2. [Import the project](https://vercel.com/new). Next.js is detected automatically.
3. Add environment variables from `.env.local` if you overrode any defaults.
4. Deploy.

`pnpm verify` should pass before every deployment.

### Security headers

`next.config.mjs` ships a `headers()` configuration that sends `Strict-Transport-Security` (two years, subdomains, preload), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and `X-DNS-Prefetch-Control: off` on every route, and sets `poweredByHeader: false`. The Content-Security-Policy comes from `middleware.ts` instead, because production `script-src` carries a per-request nonce a static header cannot express; the Farcaster frame route is the one exception and receives a static, nonce-free policy (its HTML is publicly cacheable and runs no scripts). The development and production CSPs differ deliberately: the dev server requires `'unsafe-eval'` and a local WebSocket, and neither relaxation is shipped to production.

Note that `frame-ancestors` is an allowlist rather than `DENY`: this app is intended to be embedded by Farcaster Mini App clients, and `DENY` would break that while leaving it open to every other embedder.

---

## Contributing

1. Fork and branch (`git checkout -b feature/thing`).
2. Make the change; add tests for anything in `lib/`.
3. Run `pnpm verify` — typecheck, lint, and tests must all pass.
4. Open a pull request.

House style: double quotes, no semicolons, 2-space indent, JSDoc on exported symbols explaining *why*. All code, comments, and UI text in English. Colours must resolve through design tokens; hardcoded Tailwind palette classes (`bg-gray-900`, `text-purple-400`) are not accepted. Use `lib/logger.ts` rather than `console.*`.

## License

MIT. See [`LICENSE`](/LICENSE).

## Disclaimer

Provided "AS IS" without warranty of any kind. The author is not responsible for any loss of funds, keys, or data arising from use of this software. Cryptographic key management is unforgiving: **use at your own risk.**
