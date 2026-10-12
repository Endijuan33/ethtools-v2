import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * Component/route test harness (AG-01).
 *
 * The pre-existing suite (`pnpm test`) compiles `lib/` with tsc and runs it
 * under `node --test`; it is untouched by this config. This second suite
 * covers what that harness cannot: React components in jsdom, the edge
 * middleware, and the frame route handler. It runs as part of
 * `pnpm verify` via `pnpm test:components`.
 */
const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: [
      "components/__tests__/**/*.test.{ts,tsx}",
      "tests/**/*.test.{ts,tsx}",
    ],
  },
})
