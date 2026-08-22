"use client"

/**
 * Region-scoped error boundary.
 *
 * A wallet dashboard is a set of largely independent panels. Without a boundary
 * per panel, a single render throw — a malformed cached balance, a provider that
 * returns an unexpected shape — unmounts the entire tree and the user is left
 * with a blank page holding no obvious way back to their vault. Scoping the
 * failure keeps navigation, the header, and every other panel usable.
 *
 * Implemented as a class because `componentDidCatch` still has no hook
 * equivalent in React 18.
 */

import { Component, Fragment, type ErrorInfo, type ReactNode } from "react"
import Button from "@/components/ui/Button"
import Card from "@/components/ui/Card"
import { ErrorState } from "@/components/ui/Feedback"
import { logger } from "@/lib/logger"

export interface ErrorBoundaryProps {
  children: ReactNode
  /**
   * Human-readable region name. Used both in the log entry and in the fallback
   * copy, so it should read as a noun phrase, e.g. "Balances".
   */
  name: string
  /**
   * Custom fallback. Receives a callback that clears the boundary and remounts
   * the subtree, so a caller can render its own retry affordance.
   */
  fallback?: (reset: () => void) => ReactNode
  /**
   * Invoked after the boundary clears. Use it to drop whatever cached value
   * caused the throw; without that, an immediate retry fails identically.
   */
  onReset?: () => void
}

interface ErrorBoundaryState {
  hasError: boolean
  /**
   * Incremented on every reset and used as the subtree key.
   *
   * Clearing `hasError` alone is normally enough to remount, but keying makes
   * the fresh mount unconditional — a child that memoised bad state cannot
   * survive a retry and reproduce the same throw.
   */
  resetCount: number
}

/**
 * Catch render errors within a subtree and offer an in-place retry.
 *
 * The fallback deliberately never shows `error.message`: library messages
 * routinely embed the offending argument, which here can be a mnemonic or a
 * private key. The original error goes to {@link logger}, which redacts it.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, resetCount: 0 }

  static getDerivedStateFromError(): Pick<ErrorBoundaryState, "hasError"> {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error("Panel failed to render", {
      component: this.props.name,
      error,
      componentStack: info.componentStack,
    })
  }

  /** Bound as a field so the identity is stable across renders. */
  private readonly reset = (): void => {
    this.setState((previous) => ({ hasError: false, resetCount: previous.resetCount + 1 }))
    this.props.onReset?.()
  }

  render(): ReactNode {
    const { children, fallback, name } = this.props
    const { hasError, resetCount } = this.state

    if (!hasError) return <Fragment key={resetCount}>{children}</Fragment>

    if (fallback) return fallback(this.reset)

    return (
      <Card variant="solid" padding="none" className="w-full max-w-md overflow-hidden">
        <ErrorState
          // Keeps the destructive tint — it is the signal that this is a failure
          // rather than an empty panel — but drops the nested border and corner
          // radius, which would otherwise double up against the card's own.
          className="rounded-none border-0"
          title={`${name} could not be displayed`}
          description="Something in this section failed to render. Every other part of the app still works, and no data was lost — your saved accounts and settings are untouched."
          action={
            <Button variant="outline" size="sm" onClick={this.reset}>
              Try again
            </Button>
          }
        />
      </Card>
    )
  }
}
