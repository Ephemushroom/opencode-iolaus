import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ResolvedStorePath {
  readonly found: true
  readonly path: string
  readonly source: "override" | "xdg" | "home" | "localappdata"
}

export interface UnresolvedStorePath {
  readonly found: false
  /** Every location that was checked, so the tool can tell the user where to look. */
  readonly checked: readonly string[]
}

export type StorePathResult = ResolvedStorePath | UnresolvedStorePath

export interface StorePathEnv {
  readonly OMO_OPENCODE2_DB?: string | undefined
  readonly XDG_DATA_HOME?: string | undefined
  readonly LOCALAPPDATA?: string | undefined
}

export interface ResolveStorePathDeps {
  readonly env?: StorePathEnv
  readonly home?: string
  readonly platform?: string
  readonly exists?: (path: string) => boolean
}

const STORE_RELATIVE = join("opencode", "opencode.db")

/**
 * Canonical form for comparing a project directory against `session_v2.directory`.
 *
 * opencode2 stores forward-slash paths (`C:/Users/x/proj`) while `process.cwd()`
 * on Windows yields backslashes, so an exact comparison silently matches nothing
 * and every project-scoped query comes back empty. Case is folded too, because
 * Windows drive letters and path casing are not stable across producers.
 */
export function normalizeDirectory(directory: string): string {
  return directory.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

interface Candidate {
  readonly path: string
  readonly source: ResolvedStorePath["source"]
}

function buildCandidates(deps: Required<Pick<ResolveStorePathDeps, "env" | "home" | "platform">>): Candidate[] {
  const candidates: Candidate[] = []

  const override = deps.env.OMO_OPENCODE2_DB?.trim()
  if (override) candidates.push({ path: override, source: "override" })

  const xdg = deps.env.XDG_DATA_HOME?.trim()
  if (xdg) candidates.push({ path: join(xdg, STORE_RELATIVE), source: "xdg" })

  candidates.push({ path: join(deps.home, ".local", "share", STORE_RELATIVE), source: "home" })

  // Windows installs that never export XDG_DATA_HOME land the store under LOCALAPPDATA.
  const localAppData = deps.env.LOCALAPPDATA?.trim()
  if (deps.platform === "win32" && localAppData) {
    candidates.push({ path: join(localAppData, STORE_RELATIVE), source: "localappdata" })
  }

  return candidates
}

/**
 * Locates opencode2's SQLite store. The plugin API exposes no session list or
 * message reader, so the store is the only route to session history; see the
 * SessionDomain note in the package AGENTS.md.
 *
 * Never throws: an absent store is a normal outcome that each tool reports.
 */
export function resolveStorePath(deps: ResolveStorePathDeps = {}): StorePathResult {
  const env = deps.env ?? (process.env as StorePathEnv)
  const home = deps.home ?? homedir()
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? existsSync

  const candidates = buildCandidates({ env, home, platform })
  for (const candidate of candidates) {
    if (exists(candidate.path)) return { found: true, path: candidate.path, source: candidate.source }
  }

  return { found: false, checked: candidates.map((candidate) => candidate.path) }
}
