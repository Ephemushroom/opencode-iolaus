import { execFileSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

const PROBE_TIMEOUT_MS = 5_000
// `ast-grep` first: `sg` is a deprecated alias upstream and on Linux often names shadow-utils' setgroups.
const COMMANDS = ["ast-grep", "sg"] as const

function fallbackDirectories(): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", join(homedir(), ".cargo", "bin")]
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function reportsAstGrep(path: string): boolean {
  try {
    const output = execFileSync(path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: PROBE_TIMEOUT_MS })
    return output.toLowerCase().includes("ast-grep")
  } catch {
    return false
  }
}

export interface AstGrepBinaryOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly directories?: readonly string[]
}

/** `IOLAUS_AST_GREP_BIN`, then PATH, then common install prefixes. A candidate must answer `--version` as ast-grep. */
export function resolveAstGrepBinary(options: AstGrepBinaryOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const override = env.IOLAUS_AST_GREP_BIN
  if (override) return executable(override) && reportsAstGrep(override) ? override : undefined
  const directories = options.directories ?? [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...fallbackDirectories()]
  for (const command of COMMANDS) {
    for (const directory of directories) {
      const candidate = join(directory, command)
      if (executable(candidate) && reportsAstGrep(candidate)) return candidate
    }
  }
  return undefined
}
