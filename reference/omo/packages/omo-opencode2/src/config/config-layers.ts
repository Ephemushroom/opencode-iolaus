import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"
import { isPlainObject, parseJsoncSafe } from "@oh-my-opencode/utils"
import { resolveHomeDir, resolveOmoProfileName, type OmoConfigDiagnostic, type OmoConfigEnv } from "@oh-my-opencode/omo-config-core"

type Layer = {
  readonly config: Record<string, unknown>
  readonly source: { readonly path: string; readonly scope: "user" | "project" }
}

function canonical(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path)
}

function configPath(directory: string, scope: "user" | "project"): string | undefined {
  const base = join(directory, ".omo")
  if (!existsSync(base) || (scope === "project" && lstatSync(base).isSymbolicLink())) return
  for (const name of ["opencode2.json", "opencode2.jsonc"]) {
    const path = join(base, name)
    if (!existsSync(path)) continue
    if (scope === "project" && lstatSync(path).isSymbolicLink()) continue
    return path
  }
}

export function loadOpenCode2Layers(directory: string, environment: OmoConfigEnv = process.env) {
  const home = resolveHomeDir(environment)
  const boundaries = new Set([canonical(home), canonical(userInfo().homedir)])
  const directories: string[] = []
  let current = resolve(directory)
  for (let depth = 0; depth < 256 && !boundaries.has(canonical(current)); depth++) {
    directories.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const candidates = [{ directory: home, scope: "user" as const },
    ...directories.reverse().map((directory) => ({ directory, scope: "project" as const }))]
  const layers: Layer[] = []
  const diagnostics: OmoConfigDiagnostic[] = []
  for (const candidate of candidates) {
    let path = join(candidate.directory, ".omo", "opencode2.json")
    try {
      const detected = configPath(candidate.directory, candidate.scope)
      if (!detected) continue
      path = detected
      const parsed = parseJsoncSafe<unknown>(readFileSync(path, "utf8"))
      if (parsed.errors.length > 0) {
        diagnostics.push({ kind: "parse", path, message: `Invalid OpenCode2 JSONC: ${parsed.errors.map((error) => error.message).join(", ")}` })
      } else if (!isPlainObject(parsed.data)) {
        diagnostics.push({ kind: "validation", path, message: "OpenCode2 configuration must be an object" })
      } else {
        layers.push({ config: parsed.data, source: { path, scope: candidate.scope } })
      }
    } catch (error) {
      diagnostics.push({ kind: "read", path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { layers, diagnostics, profile: resolveOmoProfileName({ env: environment }) }
}
