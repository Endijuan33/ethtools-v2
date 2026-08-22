"use client"

/**
 * ERC-20 token tracking for one account on one network.
 *
 * Two structural defects are fixed here.
 *
 * **An infinite fetch loop.** `fetchTokenBalances` depended on `tokens` and then
 * called `setTokens` with a freshly built array, which changed `tokens`, which
 * recreated the callback, which re-ran the effect that called it. Balances now
 * live in separate state keyed by contract address, so refreshing them never
 * mutates the token list that drives the effect.
 *
 * **Raw `localStorage`.** Reads were unvalidated and writes were untried, so a
 * corrupt entry reached the UI and a full quota threw. Persistence now goes
 * through `lib/storage`, like everything else in the app.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Coins, Plus, Trash2 } from "lucide-react"
import { isAddress } from "ethers"
import Card, { CardHeader, CardTitle } from "./ui/Card"
import Button from "./ui/Button"
import Field, { monoInputClassName } from "./ui/Field"
import Alert from "./ui/Alert"
import Badge from "./ui/Badge"
import Skeleton from "./ui/Skeleton"
import { EmptyState } from "./ui/Feedback"
import { notify } from "./ui/Toast"
import {
  RpcError,
  getTokenBalanceRaw,
  getTokenDetails,
  type Network,
} from "@/lib/ethers"
import { formatBalanceForDisplay } from "@/lib/format"
import { describeError, logger } from "@/lib/logger"
import { readJson, writeJson, STORAGE_KEYS } from "@/lib/storage"
import { filterValid, isStoredToken, type StoredToken } from "@/lib/schema"

/** Refresh interval while the tab is visible. */
const REFRESH_INTERVAL_MS = 60_000

/** Upper bound on tracked tokens, so storage and request fan-out stay bounded. */
const MAX_TOKENS = 50

/** Balance state for one token: loading, a value, or a reason it failed. */
type BalanceState =
  | { status: "loading" }
  | { status: "ok"; display: string }
  | { status: "error"; message: string }

export interface TokenManagerProps {
  userAddress: string
  network: Network
  /** Notified whenever the tracked token list changes. */
  onTokensUpdate?: (tokens: StoredToken[]) => void
}

/** Read the persisted token list, dropping anything that fails validation. */
function readTokens(network: Network): StoredToken[] {
  const all = filterValid(
    readJson<unknown>(STORAGE_KEYS.TOKENS, (value): value is unknown => true, []),
    isStoredToken,
    MAX_TOKENS
  )
  return all.filter((token) => token.network === network)
}

export default function TokenManager({
  userAddress,
  network,
  onTokensUpdate,
}: TokenManagerProps) {
  const [tokens, setTokens] = useState<StoredToken[]>([])
  const [balances, setBalances] = useState<Record<string, BalanceState>>({})
  const [newTokenAddress, setNewTokenAddress] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  const [error, setError] = useState("")

  // Monotonic id so a response from a superseded request cannot land on state.
  const requestId = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  /** Persist and publish a new token list. */
  const commitTokens = useCallback(
    (next: StoredToken[]): boolean => {
      // Other networks' tokens share the key, so merge rather than overwrite.
      const others = filterValid(
        readJson<unknown>(STORAGE_KEYS.TOKENS, (value): value is unknown => true, []),
        isStoredToken,
        MAX_TOKENS * 4
      ).filter((token) => token.network !== network)

      const result = writeJson(STORAGE_KEYS.TOKENS, [...others, ...next])
      if (!result.ok) {
        notify.error("Could not save token list", result.error)
        return false
      }

      setTokens(next)
      onTokensUpdate?.(next)
      return true
    },
    [network, onTokensUpdate]
  )

  // Load on mount and whenever the network changes.
  useEffect(() => {
    const stored = readTokens(network)
    setTokens(stored)
    setBalances({})
    onTokensUpdate?.(stored)
  }, [network, onTokensUpdate])

  /**
   * Refresh every tracked balance.
   *
   * Reads the token list from storage rather than closing over `tokens`, so this
   * callback stays stable and cannot participate in the update cycle that the
   * previous implementation suffered from.
   */
  const refreshBalances = useCallback(async () => {
    const list = readTokens(network)
    if (list.length === 0 || !isAddress(userAddress)) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const id = requestId.current + 1
    requestId.current = id

    setBalances((prev) => {
      const next: Record<string, BalanceState> = { ...prev }
      for (const token of list) {
        if (next[token.address] === undefined) next[token.address] = { status: "loading" }
      }
      return next
    })

    await Promise.all(
      list.map(async (token) => {
        try {
          const { value, decimals } = await getTokenBalanceRaw(
            token.address,
            userAddress,
            network,
            controller.signal
          )
          if (requestId.current !== id) return
          setBalances((prev) => ({
            ...prev,
            [token.address]: { status: "ok", display: formatBalanceForDisplay(value, decimals) },
          }))
        } catch (cause) {
          if (requestId.current !== id) return
          if (cause instanceof RpcError && cause.kind === "aborted") return

          logger.warn("Token balance fetch failed", { network, error: cause })
          setBalances((prev) => ({
            ...prev,
            [token.address]: {
              status: "error",
              message:
                cause instanceof RpcError
                  ? cause.userMessage
                  : describeError(cause, "Could not read balance."),
            },
          }))
        }
      })
    )
  }, [network, userAddress])

  /**
   * Refresh on mount and on an interval, but only while the tab is visible.
   *
   * A hidden tab must issue no requests at all; polling a backgrounded wallet
   * burns the user's RPC quota for output nobody can see.
   */
  useEffect(() => {
    if (tokens.length === 0) return

    let timer: ReturnType<typeof setInterval> | null = null

    const start = (): void => {
      if (timer !== null) return
      void refreshBalances()
      timer = setInterval(() => void refreshBalances(), REFRESH_INTERVAL_MS)
    }

    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      abortRef.current?.abort()
    }

    const handleVisibility = (): void => {
      if (document.hidden) stop()
      else start()
    }

    if (!document.hidden) start()
    document.addEventListener("visibilitychange", handleVisibility)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility)
      stop()
    }
  }, [tokens.length, refreshBalances])

  const handleAddToken = async (): Promise<void> => {
    setError("")

    const candidate = newTokenAddress.trim()
    if (!isAddress(candidate)) {
      setError("Enter a valid contract address.")
      return
    }
    if (tokens.length >= MAX_TOKENS) {
      setError(`You can track at most ${MAX_TOKENS} tokens per network.`)
      return
    }
    if (tokens.some((token) => token.address.toLowerCase() === candidate.toLowerCase())) {
      setError("That token is already tracked.")
      return
    }

    setIsAdding(true)
    try {
      const details = await getTokenDetails(candidate, network)
      const added: StoredToken = {
        address: candidate,
        symbol: details.symbol,
        name: details.name,
        decimals: details.decimals,
        network,
      }

      if (commitTokens([...tokens, added])) {
        setNewTokenAddress("")
        void refreshBalances()
      }
    } catch (cause) {
      logger.warn("Add token failed", { network, error: cause })
      setError(
        cause instanceof RpcError
          ? cause.userMessage
          : describeError(cause, "Could not read that contract. Check it is an ERC-20 token.")
      )
    } finally {
      setIsAdding(false)
    }
  }

  const handleRemoveToken = (address: string): void => {
    commitTokens(tokens.filter((token) => token.address !== address))
    setBalances((prev) => {
      const next = { ...prev }
      delete next[address]
      return next
    })
  }

  const isRefreshing = Object.values(balances).some((entry) => entry.status === "loading")

  return (
    <Card variant="inset" padding="sm">
      <CardHeader className="mb-3">
        <CardTitle as="h3" className="text-base">
          Tracked tokens
        </CardTitle>
        {isRefreshing && (
          <Badge tone="info" dot pulse>
            Refreshing
          </Badge>
        )}
      </CardHeader>

      <div className="mb-3 flex items-end gap-2">
        <Field label="Token contract" hideLabel className="flex-1">
          {(props) => (
            <input
              {...props}
              type="text"
              value={newTokenAddress}
              onChange={(event) => setNewTokenAddress(event.target.value)}
              className={monoInputClassName}
              placeholder="ERC-20 contract address…"
            />
          )}
        </Field>
        <Button
          size="icon"
          onClick={handleAddToken}
          disabled={isAdding || newTokenAddress.trim() === ""}
          isLoading={isAdding}
          aria-label="Add token"
          className="mb-0.5 shrink-0"
        >
          {!isAdding && <Plus className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </div>

      {error !== "" && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}

      {tokens.length === 0 ? (
        <EmptyState
          icon={<Coins className="h-5 w-5" />}
          title="No tokens tracked"
          description="Add an ERC-20 contract address to watch its balance on this network."
        />
      ) : (
        <ul className="space-y-2">
          {tokens.map((token) => {
            const balance = balances[token.address]
            return (
              <li
                key={token.address}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 p-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {token.name} <span className="text-muted-foreground">({token.symbol})</span>
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {token.address}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {balance === undefined || balance.status === "loading" ? (
                    <Skeleton className="h-4 w-16" />
                  ) : balance.status === "ok" ? (
                    <span className="font-mono text-sm text-foreground">{balance.display}</span>
                  ) : (
                    <span className="text-xs text-destructive" title={balance.message}>
                      Unavailable
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemoveToken(token.address)}
                    aria-label={`Stop tracking ${token.symbol}`}
                    className="rounded-lg p-2 text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
