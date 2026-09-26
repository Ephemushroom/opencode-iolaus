import { execFileSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"

const PROBE_TIMEOUT_MS = 5_000

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function probe(path: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(path, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: PROBE_TIMEOUT_MS })
  } catch (error) {
    // `gh auth status` exits 1 when logged out but still prints the state.
    const failed = error as { stdout?: string; stderr?: string }
    return `${failed.stdout ?? ""}${failed.stderr ?? ""}` || undefined
  }
}

export interface GhBinary {
  readonly path: string
  readonly version: string
  readonly authenticated: boolean
}

export interface GhBinaryOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly directories?: readonly string[]
}

/** `IOLAUS_GH_BIN`, then PATH, then common prefixes. Reports whether `gh auth status` shows a login. */
export function resolveGhBinary(options: GhBinaryOptions = {}): GhBinary | undefined {
  const env = options.env ?? process.env
  const candidates = env.IOLAUS_GH_BIN
    ? [env.IOLAUS_GH_BIN]
    : (options.directories ?? [...(env.PATH ?? "").split(delimiter).filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"]).map((dir) => join(dir, "gh"))
  for (const candidate of candidates) {
    if (!executable(candidate)) continue
    const version = probe(candidate, ["--version"])?.match(/gh version (\S+)/)?.[1]
    if (!version) continue
    const status = probe(candidate, ["auth", "status"]) ?? ""
    return { path: candidate, version, authenticated: /Logged in to/.test(status) }
  }
  return undefined
}
