"use client"

/**
 * Privacy disclosure dialog (RA-07).
 *
 * EthTools has no account and no backend of its own, but it is not an
 * offline app: features talk to blockchain RPC endpoints, explorers, a
 * price API, a chain registry, the WalletConnect relay, and — on the
 * hosted deployment — Vercel Analytics. Users deciding whether to paste an
 * address here deserve the full list in the app, not just in the README.
 * Every statement below mirrors the code: explorer lookups happen only on
 * an explicit tap, prices are fetched by coin id (never by address), and
 * keys are never transmitted anywhere.
 */

import ResponsiveDialog from "./ui/ResponsiveDialog"

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="space-y-1.5 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  )
}

export default function PrivacyDisclosure({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) {
  return (
    <ResponsiveDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Privacy: what leaves this device"
      description="EthTools has no accounts and no server of its own. Your keys never leave the browser — but some features do talk to third parties."
      size="lg"
    >
      <div className="space-y-5">
        <Section title="What stays on this device">
          <p>
            Your vault — accounts, private keys, and recovery phrase — is stored only in this
            browser&apos;s local storage, encrypted with your vault password. Signing happens
            locally. No key, phrase, or vault password is ever sent to any server, and there is
            no EthTools account to sign into.
          </p>
          <p>
            Erasing all data (in Backup and restore) removes the vault and settings from this
            browser, disconnects WalletConnect, and deletes WalletConnect&apos;s own storage.
            It cannot delete logs that third parties already kept on their servers.
          </p>
        </Section>

        <Section title="Blockchain RPC endpoints">
          <p>
            Balances, gas prices, ENS lookups, token detection, and broadcasting use public RPC
            endpoints — including Infura, PublicNode, Ankr, BlastAPI, and the chains&apos; own
            public RPCs — plus any custom RPC you add yourself. The endpoint you query receives
            the addresses and transactions involved in that request.
          </p>
          <p>
            Like every website and API, those endpoints also see your IP address and the time of
            the request, so they can correlate an address with an IP address and a time. Using
            a VPN or Tor reduces that correlation; the app itself cannot.
          </p>
        </Section>

        <Section title="Explorers, prices, and the chain list">
          <p>
            Block explorer pages (Etherscan, Blockscout, and the other explorers linked from the
            app) are opened only when you tap an explorer link or start an address scan — never
            in the background. The explorer then sees the address or transaction you opened,
            plus your IP address.
          </p>
          <p>
            Prices come from the CoinGecko API and are requested by coin identifier only — never
            by wallet address. The network list comes from the public chain registry at
            chainid.network. Both see your IP address and request time, like any web request.
          </p>
        </Section>

        <Section title="WalletConnect">
          <p>
            If you pair with a dApp, session messages pass through the WalletConnect (Reown)
            relay. The relay sees connection metadata and your IP address; the dApp you approve
            sees your addresses and the signature or transaction requests it sends. Approving a
            session is always your explicit action.
          </p>
        </Section>

        <Section title="Hosting analytics">
          <p>
            The hosted deployment uses Vercel Analytics, which records anonymous page-view
            metrics (page, referrer, browser, country). It never receives addresses, keys, or
            anything from your vault.
          </p>
        </Section>

        <Section title="What this app does not offer (yet)">
          <p>
            There is currently no mode that routes every request exclusively through an RPC you
            control: the built-in public endpoints above are used by default, though you can add
            your own custom networks. If third-party RPC exposure matters to you, treat address
            lookups here as public — because to the endpoint serving them, they are.
          </p>
        </Section>
      </div>
    </ResponsiveDialog>
  )
}
