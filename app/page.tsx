"use client"

/**
 * Application shell.
 *
 * Structured as a dashboard rather than a stack of forms: a sticky header, a
 * persistent sidebar rail on desktop with a fixed glass tab bar on mobile, and
 * a content region that swaps panels.
 *
 * Only the active panel mounts. That is deliberate for a wallet: an unmounted
 * panel cannot keep polling an RPC or hold a decrypted secret in state.
 *
 * Every panel is additionally wrapped in an {@link ErrorBoundary} and, where it
 * is heavy, loaded on demand — see the notes on `SECTIONS` and the dynamic
 * imports below.
 */

import { useState } from "react"
import dynamic from "next/dynamic"
import { ArrowLeftRight, KeyRound, Sparkles, Wallet, Wrench } from "lucide-react"
import AppHeader from "@/components/AppHeader"
import { MobileTabBar, SidebarNav } from "@/components/AppNav"
import InputCard from "@/components/InputCard"
import AddressCard from "@/components/AddressCard"
import ConnectionStatus from "@/components/ConnectionStatus"
import ErrorBoundary from "@/components/ErrorBoundary"
import FooterCredit from "@/components/FooterCredit"
import Alert from "@/components/ui/Alert"
import { Spinner } from "@/components/ui/Feedback"
import { classifySecret } from "@/lib/hdWallet"
import { getAddressFromMnemonic, getAddressFromPrivateKey } from "@/lib/ethers"
import { describeError, logger } from "@/lib/logger"

type Network = "mainnet" | "testnet"

/*
 * Heavy panels are code-split.
 *
 * Between them these pull in `ethers`, `qrcode.react`, and the full network
 * table. Someone who opens the app only to convert units should not pay for any
 * of that, and the converter path (`InputCard` / `AddressCard`) stays statically
 * imported so it is interactive on first paint.
 *
 * `ssr: false` because all of them are client-only anyway: they read
 * `localStorage`, `crypto.subtle`, and `navigator`. Server-rendering them would
 * only produce markup that is immediately replaced.
 */
const WalletVault = dynamic(() => import("@/components/WalletVault"), {
  ssr: false,
  loading: () => <Spinner label="Loading vault…" />,
})

const GeneratorCard = dynamic(() => import("@/components/GeneratorCard"), {
  ssr: false,
  loading: () => <Spinner label="Loading generator…" />,
})

const WalletCard = dynamic(() => import("@/components/WalletCard"), {
  ssr: false,
  loading: () => <Spinner label="Loading balances…" />,
})

const TransactionHistory = dynamic(() => import("@/components/TransactionHistory"), {
  ssr: false,
  loading: () => <Spinner label="Loading transaction history…" />,
})

const RpcHealthPanel = dynamic(() => import("@/components/RpcHealthPanel"), {
  ssr: false,
  loading: () => <Spinner label="Loading RPC health…" />,
})

const DevToolsCard = dynamic(() => import("@/components/DevToolsCard"), {
  ssr: false,
  loading: () => <Spinner label="Loading tools…" />,
})

/** Navigation entries, in display order. */
const SECTIONS = [
  {
    id: "vault",
    label: "Vault",
    description: "Encrypted accounts",
    icon: Wallet,
  },
  {
    id: "converter",
    label: "Converter",
    description: "Key to address",
    icon: ArrowLeftRight,
  },
  {
    id: "generator",
    label: "Generator",
    description: "New wallets",
    icon: Sparkles,
  },
  {
    id: "wallet",
    label: "Balances",
    description: "Multi-network",
    icon: KeyRound,
  },
  {
    id: "tools",
    label: "Tools",
    description: "Units, ENS, calldata",
    icon: Wrench,
  },
] as const

type SectionId = (typeof SECTIONS)[number]["id"]

export default function Home() {
  const [address, setAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [network, setNetwork] = useState<Network>("mainnet")
  const [section, setSection] = useState<SectionId>("vault")

  const handleConvert = (input: string, selectedNetwork: Network) => {
    setIsLoading(true)
    setError(null)
    setAddress(null)
    setNetwork(selectedNetwork)

    try {
      // Single source of truth for secret classification. The previous inline
      // `includes(' ')` check misread a newline-separated phrase as a private
      // key and rejected valid 15- and 21-word phrases.
      const classified = classifySecret(input)

      if (classified.kind === "mnemonic") {
        setAddress(getAddressFromMnemonic(classified.normalized))
      } else if (classified.kind === "private-key") {
        setAddress(getAddressFromPrivateKey(classified.normalized))
      } else {
        setError(classified.reason ?? "Enter a recovery phrase or a private key.")
      }
    } catch (e) {
      // The thrown message can echo the input, so it is logged (and redacted)
      // rather than rendered verbatim.
      logger.error("Address derivation failed", { component: "Home", error: e })
      setError(describeError(e, "That secret could not be converted to an address."))
    } finally {
      setIsLoading(false)
    }
  }

  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0]
  const ActiveIcon = active.icon

  return (
    <div className="relative flex min-h-[100dvh] flex-col">
      {/* Ambient backdrop. Fixed and inert so it never intercepts a tap. */}
      <div className="app-backdrop pointer-events-none fixed inset-0 -z-10" aria-hidden="true" />

      <AppHeader />

      {/*
        Bottom padding clears the fixed mobile tab bar (56px + safe area) so the
        footer credit is never covered. Desktop has no tab bar and keeps the
        normal rhythm.
      */}
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 pb-28 sm:px-6 lg:flex-row lg:gap-8 lg:py-8 lg:pb-8">
        {/* Navigation: fixed glass tab bar on mobile, sticky sidebar from lg. */}
        <aside className="hidden shrink-0 lg:block lg:w-60">
          <div className="lg:sticky lg:top-24">
            <SidebarNav items={SECTIONS} value={section} onChange={setSection} />
          </div>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1">
          <div className="mb-6 flex items-center gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary"
              aria-hidden="true"
            >
              <ActiveIcon className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{active.label}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">{active.description}</p>
            </div>
          </div>

          {/*
            Panel swap via remount + CSS animation, not AnimatePresence.

            AnimatePresence's exit machinery (framer-motion 11.18) never fires
            its exit-complete callback for the vault panel's subtree, which —
            with `mode="wait"` — permanently blocked the next panel from
            mounting after leaving the vault. A key-driven remount has no
            callback to miss: the old DOM is gone in the same commit, and the
            `panel-in` keyframe (globals.css) still plays the entrance
            transition. The global prefers-reduced-motion rule disables it.
          */}
          <section
            key={section}
            aria-label={active.label}
            className="animate-panel-in flex flex-col items-center gap-6"
          >
              {/*
                One boundary per panel. A panel that throws is contained: the
                header, the nav rail, and every other section stay interactive,
                and the user can retry in place instead of reloading.
              */}
              {section === "vault" && (
                <ErrorBoundary name="Vault">
                  <WalletVault />
                </ErrorBoundary>
              )}

              {section === "converter" && (
                <ErrorBoundary
                  name="Converter"
                  // Clear the derived address on retry: if rendering it threw,
                  // remounting with the same value would throw again.
                  onReset={() => {
                    setAddress(null)
                    setError(null)
                  }}
                >
                  {address ? (
                    <AddressCard
                      address={address}
                      network={network}
                      onReset={() => {
                        setAddress(null)
                        setError(null)
                      }}
                    />
                  ) : (
                    <>
                      <InputCard onConvert={handleConvert} isLoading={isLoading} />
                      {error && (
                        <Alert tone="danger" title="Conversion failed" className="w-full max-w-md">
                          {error}
                        </Alert>
                      )}
                    </>
                  )}
                </ErrorBoundary>
              )}

              {section === "generator" && (
                <ErrorBoundary name="Generator">
                  <GeneratorCard />
                </ErrorBoundary>
              )}

              {section === "wallet" && (
                <>
                  <ErrorBoundary name="Balances">
                    <WalletCard />
                  </ErrorBoundary>
                  {/* History belongs with the surface that creates it. */}
                  <div className="w-full max-w-2xl">
                    {/* Its own boundary: a corrupt history entry must not take
                        the balance panel down with it. */}
                    <ErrorBoundary name="Transaction history">
                      <TransactionHistory />
                    </ErrorBoundary>
                  </div>
                  {/* RPC health reports on the pools the panels above drive, so
                      it lives beneath them in the same section. */}
                  <div className="w-full max-w-2xl">
                    {/* Its own boundary: a failure reading pool state must not
                        take the balance or history panels down with it. */}
                    <ErrorBoundary name="RPC health">
                      <RpcHealthPanel />
                    </ErrorBoundary>
                  </div>
                </>
              )}

              {section === "tools" && (
                <ErrorBoundary name="Tools">
                  <DevToolsCard />
                </ErrorBoundary>
              )}
          </section>
        </main>
      </div>

      <FooterCredit />

      <MobileTabBar items={SECTIONS} value={section} onChange={setSection} />

      {/* Mounted once, outside the swapped content, so the banner survives a
          section change and a panel-level failure. */}
      <ConnectionStatus />
    </div>
  )
}
