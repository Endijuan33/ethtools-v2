/**
 * ESLint flat configuration.
 *
 * Replaces the legacy `.eslintrc.json` + `next lint` setup (RA-15): Next.js
 * 15.5 deprecated `next lint` in favor of the ESLint CLI, and ESLint 8 is
 * end-of-life. The rule set is unchanged — `next/core-web-vitals`, the same
 * preset the eslintrc extended — bridged through FlatCompat, which is the
 * migration path the Next.js docs prescribe for eslint-config-next 15.x.
 */
import { dirname } from "path"
import { fileURLToPath } from "url"
import { FlatCompat } from "@eslint/eslintrc"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({ baseDirectory: __dirname })

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      ".test-build/**",
      "node_modules/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals"),
]

export default eslintConfig
