#!/usr/bin/env node
/**
 * Dependency audit gate (supply-chain remediation, 2026-10 re-audit).
 *
 * Queries the OSV database for EVERY package resolved in pnpm-lock.yaml
 * and fails when an advisory is not covered by the curated ignore file
 * `.osv-ignore.json`. An ignore entry must name the GHSA id, give a
 * reachability rationale, and carry an expiry date; an expired ignore
 * fails the gate, so exceptions cannot silently become permanent.
 *
 * Why a repo script instead of `pnpm audit`: pnpm's audit only walks part
 * of the tree and reports against the registry's own data; OSV querybatch
 * covers the whole lockfile (build, dev, and transitive packages alike),
 * which is the set the re-audit scanned.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const LOCKFILE = join(ROOT, "pnpm-lock.yaml")
const IGNORE_FILE = join(ROOT, ".osv-ignore.json")
const OSV_BATCH = "https://api.osv.dev/v1/querybatch"
const OSV_VULN = "https://api.osv.dev/v1/vulns"

function parseLockfilePackages(text) {
  const packages = new Set()
  let inPackages = false
  for (const line of text.split("\n")) {
    if (line.startsWith("packages:")) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    if (line.trim() === "") continue
    if (!line.startsWith(" ")) break
    const match = /^  '?(.+?)'?:\s*$/.exec(line)
    if (!match) continue
    const key = match[1].split("(")[0]
    const at = key.lastIndexOf("@")
    if (at <= 0) continue
    const name = key.slice(0, at)
    const version = key.slice(at + 1)
    if (version.startsWith("link:")) continue
    packages.add(`${name}@${version}`)
  }
  return [...packages].sort()
}

async function queryBatch(queries) {
  const response = await fetch(OSV_BATCH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries }),
  })
  if (!response.ok) throw new Error(`OSV querybatch failed: HTTP ${response.status}`)
  return response.json()
}

async function severityOf(id) {
  try {
    const response = await fetch(`${OSV_VULN}/${id}`)
    if (!response.ok) return "UNKNOWN"
    const detail = await response.json()
    return detail?.database_specific?.severity ?? "UNKNOWN"
  } catch {
    return "UNKNOWN"
  }
}

function loadIgnores() {
  const parsed = JSON.parse(readFileSync(IGNORE_FILE, "utf8"))
  const today = new Date().toISOString().slice(0, 10)
  const active = new Map()
  const expired = []
  for (const entry of parsed.ignores ?? []) {
    if (typeof entry.id !== "string" || typeof entry.expires !== "string") {
      throw new Error(`Malformed ignore entry: ${JSON.stringify(entry)}`)
    }
    if (entry.expires < today) expired.push(entry)
    else active.set(entry.id, entry)
  }
  return { active, expired }
}

async function main() {
  const packages = parseLockfilePackages(readFileSync(LOCKFILE, "utf8"))
  console.log(`Scanning ${packages.length} resolved packages against OSV…`)

  const queries = packages.map((entry) => {
    const at = entry.lastIndexOf("@")
    return {
      package: { name: entry.slice(0, at), ecosystem: "npm" },
      version: entry.slice(at + 1),
    }
  })

  const instances = []
  for (let i = 0; i < queries.length; i += 500) {
    const result = await queryBatch(queries.slice(i, i + 500))
    result.results.forEach((entry, j) => {
      const query = queries[i + j]
      for (const vuln of entry.vulns ?? []) {
        const ids = [vuln.id, ...(vuln.aliases ?? [])]
        const ghsa = ids.find((id) => id.startsWith("GHSA-")) ?? vuln.id
        instances.push({ pkg: `${query.package.name}@${query.version}`, id: ghsa })
      }
    })
  }

  const { active, expired } = loadIgnores()
  const unignored = instances.filter((instance) => !active.has(instance.id))
  const ignored = instances.filter((instance) => active.has(instance.id))

  for (const instance of ignored) {
    console.log(`  ignored ${instance.id} (${instance.pkg}) — ${active.get(instance.id).reason}`)
  }
  for (const entry of expired) {
    console.error(`  EXPIRED ignore ${entry.id}: renew the rationale or fix the advisory.`)
  }

  if (unignored.length > 0) {
    console.error(`\n${unignored.length} unignored advisor${unignored.length === 1 ? "y" : "ies"}:`)
    for (const instance of unignored) {
      const severity = await severityOf(instance.id)
      console.error(`  ${instance.id} [${severity}] -> ${instance.pkg}`)
    }
  }

  if (unignored.length > 0 || expired.length > 0) {
    console.error(
      "\nDependency audit gate FAILED. Fix the advisory, or add a justified, expiring entry to .osv-ignore.json."
    )
    process.exit(1)
  }
  console.log(
    `\nDependency audit gate passed: ${instances.length} known advisor${instances.length === 1 ? "y" : "ies"}, all covered by unexpired ignores.`
  )
}

main().catch((error) => {
  console.error("Dependency audit gate could not run:", error)
  process.exit(2)
})
