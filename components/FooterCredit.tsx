import { Github, Send } from "lucide-react"

/**
 * Footer credit and project links.
 *
 * Deliberately low-contrast and small: it is attribution, not a call to
 * action. The year is computed rather than hardcoded so it cannot go stale.
 * Both link glyphs are generic lucide icons (ISC-licensed) rather than
 * third-party brand assets.
 */
export default function FooterCredit() {
  return (
    <footer className="mt-10 border-t border-border/60 px-4 pb-24 pt-6 text-center text-muted-foreground lg:pb-6">
      <p className="text-xs">
        © {new Date().getFullYear()} built by{" "}
        <span className="font-medium text-gradient">endcore.base.eth</span>
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
          className="flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-lg px-3 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Send className="h-5 w-5 opacity-80" aria-hidden="true" />
          <span className="text-xs">Contact</span>
        </a>
      </div>
    </footer>
  )
}
