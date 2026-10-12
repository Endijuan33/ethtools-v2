# Security Policy

## Supported versions

EthTools is a client-side application deployed from the `main` branch.
Security fixes are applied to `main` only; there are no maintained release
branches. If you self-host, track `main` and rebuild after security fixes.

| Version | Supported |
|---|---|
| `main` (2.0.x line) | Yes |
| Anything older | No |

## Reporting a vulnerability

**Do not open a public issue for a vulnerability in wallet handling,
encryption, signing, or storage.**

Preferred channel: GitHub's private vulnerability reporting for this
repository (the **Report a vulnerability** button under the repository's
Security tab), which keeps the report private until a fix is available.
Private vulnerability reporting **is enabled** on this repository (owner
Settings → Security → Private vulnerability reporting), and that button
is the verified private channel — do not send wallet-related
vulnerability details through public issues.

A useful report includes:

- A description of the issue and the exact component or file involved.
- The commit SHA or deployed version where you observed it.
- Steps to reproduce, using test wallets and test networks only.
- The impact as you understand it (for example: key exposure, incorrect
  signing, loss of funds), and any suggested fix.

**Never include a real private key, recovery phrase, vault password, or a
decrypted backup in a report.** Test vectors and synthetic keys are enough
to reproduce every class of issue in this codebase.

## Scope notes

- Key derivation, decryption, and signing are client-side by design; there
  is no server that stores wallet material. Reports about a "server-side
  key leak" should first check whether a third-party RPC, explorer, or
  price API is the actual data recipient (see the Security model section
  of the README for what leaves the device).
- Findings in the deployed site that do not reproduce on current `main`
  may already be fixed; please check the commit history before reporting.

## Dependency integrity

CI pins every GitHub Action to a full commit SHA and runs a dependency
audit gate (`pnpm audit:osv`, implemented in `scripts/osv-audit.mjs`)
that scans every package in the pnpm lockfile against the OSV database.
The gate fails on any advisory that is not covered by a justified,
unexpired entry in `.osv-ignore.json`; each ignore names the advisory,
why it is not reachable in this app, and when the exception lapses.
