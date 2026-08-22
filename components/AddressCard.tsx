"use client"

import { ExternalLink, RefreshCw } from "lucide-react"
import { getConverterExplorerUrl } from "@/lib/ethers"
import Card, { CardHeader, CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Badge from "./ui/Badge"
import CopyButton from "./ui/CopyButton"

interface AddressCardProps {
  address: string
  network: "mainnet" | "testnet"
  /** Returns to the input view. */
  onReset: () => void
}

/**
 * Result panel for the converter.
 *
 * The explorer link is a real anchor rather than a button with an onClick, so
 * middle-click, copy-link, and open-in-new-tab all behave as users expect.
 */
export default function AddressCard({ address, network, onReset }: AddressCardProps) {
  // The converter thinks in mainnet/testnet; the explorer helper needs a concrete
  // chain, and Sepolia is the testnet it targets.
  const explorerNetwork = network === "mainnet" ? "mainnet" : "sepolia"
  const explorerUrl = getConverterExplorerUrl(address, explorerNetwork)
  const explorerLabel = explorerNetwork === "mainnet" ? "Mainnet" : "Sepolia"

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle as="h3">Derived address</CardTitle>
        {/* States which chain the explorer link resolves against. */}
        <Badge tone={explorerNetwork === "mainnet" ? "info" : "warning"} dot>
          {explorerLabel}
        </Badge>
      </CardHeader>

      <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/40 p-3">
        <p className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">{address}</p>
        <CopyButton value={address} label="address" />
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Button asChild variant="primary" fullWidth className="sm:flex-1">
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View this address on Routescan ${explorerLabel} (opens in a new tab)`}
          >
            View on explorer
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        </Button>
        <Button
          variant="secondary"
          fullWidth
          onClick={onReset}
          icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
          className="sm:flex-1"
        >
          Convert another
        </Button>
      </div>
    </Card>
  )
}
