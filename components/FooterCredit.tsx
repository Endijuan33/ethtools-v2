import Image from "next/image"
import { Github } from "lucide-react"

/**
 * Footer credit and project links.
 *
 * Deliberately low-contrast and small: it is attribution, not a call to action.
 * The year is computed rather than hardcoded so it cannot go stale.
 */
export default function FooterCredit() {
  return (
    <footer className="mt-10 border-t border-border/60 px-4 py-6 text-center text-muted-foreground">
      <p className="text-xs">
        © {new Date().getFullYear()} built by{" "}
        <span className="font-medium text-foreground">endcore.base.eth</span>
      </p>

      <div className="mt-2 flex items-center justify-center gap-4">
        <a
          href="https://github.com/Endijuan33/ethtools-v2"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View this project on GitHub (opens in a new tab)"
          className="flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-lg px-3 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Github className="h-5 w-5" aria-hidden="true" />
          <span className="text-xs">Source</span>
        </a>

        <a
          href="https://t.me/e0303"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Contact the author on Telegram (opens in a new tab)"
          className="group flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-lg px-3 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Image
            src="/icons/telegram.svg"
            alt=""
            width={20}
            height={20}
            aria-hidden="true"
            className="opacity-70 transition-opacity group-hover:opacity-100"
          />
          <span className="text-xs">Contact</span>
        </a>
      </div>
    </footer>
  )
}
