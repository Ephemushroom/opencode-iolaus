import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const VERIFY_CONFIG_FILE = "verify.json"
export const MUTATION_TOOLS = new Set(["edit", "write", "patch", "apply_patch"])

/** A checker: `argv` runs without a shell; stdout+stderr are scanned for `file:line` diagnostics. */
export interface Checker {
  readonly name: string
  readonly argv: readonly string[]
  /** Only run when at least one changed file matches (glob-free suffix list, e.g. [".ts", ".tsx"]). */
  readonly extensions?: readonly string[]
  /** `json`: stdout is a JSON array of {file|path|filename, line, message} or an object with such an array under `diagnostics`/`results`. */
  readonly format?: DiagnosticFormat
}

export interface VerifyConfig {
  readonly checkers: readonly Checker[]
  readonly timeoutMs: number
  /** Regex source flagging AI-style comments; null disables the comment check. */
  readonly commentPattern: string | null
  readonly source: "config" | "detected" | "disabled"
}

export const DEFAULT_TIMEOUT_MS = 120_000
/** Comments that narrate the request ("as requested", "added by AI") rather than the code. Trailing comments count. */
export const DEFAULT_COMMENT_PATTERN =
  String.raw`(?:^|\s)(?://|#|/\*|\*)\s*(?:[\w']+\s+){0,4}?(?:(?:(?:as\s+)?requested\s+by|as\s+requested|per)\s+(?:the\s+)?(?:ai|claude|gpt|copilot|assistant|user|request)|by\s+(?:the\s+)?(?:ai|claude|gpt|copilot|assistant))\b`

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function parseChecker(value: unknown, index: number): Checker {
  if (typeof value !== "object" || value === null) throw new TypeError(`verify.json checkers[${index}] must be an object`)
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.argv) || !record.argv.length || record.argv.some((item) => typeof item !== "string")) {
    throw new TypeError(`verify.json checkers[${index}].argv must be a non-empty string array`)
  }
  if (record.extensions !== undefined && (!Array.isArray(record.extensions) || record.extensions.some((item) => typeof item !== "string"))) {
    throw new TypeError(`verify.json checkers[${index}].extensions must be a string array`)
  }
  if (record.format !== undefined && record.format !== "location" && record.format !== "json") {
    throw new TypeError(`verify.json checkers[${index}].format must be "location" or "json"`)
  }
  return {
    name: typeof record.name === "string" && record.name ? record.name : String(record.argv[0]),
    argv: [...(record.argv as string[])],
    ...(record.extensions ? { extensions: [...(record.extensions as string[])] } : {}),
    ...(record.format ? { format: record.format as DiagnosticFormat } : {}),
  }
}

export function parseVerifyConfig(value: Record<string, unknown>): Omit<VerifyConfig, "source"> {
  const unknown = Object.keys(value).filter((key) => !["checkers", "timeoutMs", "commentPattern"].includes(key))
  if (unknown.length) throw new TypeError(`Unknown verify.json keys: ${unknown.join(", ")}`)
  if (value.checkers !== undefined && !Array.isArray(value.checkers)) throw new TypeError("verify.json checkers must be an array")
  if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== "number" || value.timeoutMs < 1000)) {
    throw new TypeError("verify.json timeoutMs must be a number >= 1000")
  }
  if (value.commentPattern !== undefined && value.commentPattern !== null && typeof value.commentPattern !== "string") {
    throw new TypeError("verify.json commentPattern must be a string or null")
  }
  if (typeof value.commentPattern === "string") new RegExp(value.commentPattern)
  return {
    checkers: ((value.checkers as unknown[] | undefined) ?? []).map(parseChecker),
    timeoutMs: (value.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS,
    commentPattern: value.commentPattern === undefined ? DEFAULT_COMMENT_PATTERN : (value.commentPattern as string | null),
  }
}

/** A checker may declare how to parse its output; `location` (default) is `file(line,col)` / `file:line:col`. */
export type DiagnosticFormat = "location" | "json"

function bin(directory: string, name: string): string {
  const local = join(directory, "node_modules", ".bin", name)
  return existsSync(local) ? local : name
}

/**
 * With no config, checkers are detected from marker files. Every detected
 * command is read-only (no `--fix`, no `--write`) and prints file locations.
 */
export function detectCheckers(directory: string): Checker[] {
  const has = (...names: string[]) => names.some((name) => existsSync(join(directory, name)))
  const checkers: Checker[] = []
  if (has("tsconfig.json")) checkers.push({ name: "tsc", argv: [bin(directory, "tsc"), "--noEmit", "--pretty", "false"], extensions: [".ts", ".tsx", ".mts", ".cts"] })
  if (has("biome.json", "biome.jsonc")) checkers.push({ name: "biome", argv: [bin(directory, "biome"), "lint", "--reporter=github", "."], extensions: [".ts", ".tsx", ".js", ".jsx", ".json", ".css"] })
  else if (has("eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc.json", ".eslintrc.cjs", ".eslintrc.js", ".eslintrc")) checkers.push({ name: "eslint", argv: [bin(directory, "eslint"), "--format", "unix", "."], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] })
  if (has("pyproject.toml", "ruff.toml", ".ruff.toml", "setup.py", "requirements.txt")) checkers.push({ name: "ruff", argv: ["ruff", "check", "--output-format", "concise", "--no-fix", "."], extensions: [".py", ".pyi"] })
  if (has("Cargo.toml")) checkers.push({ name: "cargo", argv: ["cargo", "check", "--quiet", "--message-format=short"], extensions: [".rs"] })
  if (has("go.mod")) checkers.push({ name: "go vet", argv: ["go", "vet", "./..."], extensions: [".go"] })
  return checkers
}

/**
 * `.iolaus/verify.json` in the session directory wins, then the user layer's
 * `verify.json`; `{ "checkers": [] }` turns
 * the checkers off while keeping the comment check, `false`-like disabling is
 * `{ "checkers": [], "commentPattern": null }`.
 */
export function loadVerifyConfig(directory: string, inline?: unknown, userLayer?: string): VerifyConfig {
  const file = readJson(join(directory, ".iolaus", VERIFY_CONFIG_FILE)) ?? (userLayer ? readJson(join(userLayer, VERIFY_CONFIG_FILE)) : undefined)
  const record = inline !== undefined
    ? (typeof inline === "object" && inline !== null ? (inline as Record<string, unknown>) : undefined)
    : file
  if (record) {
    const parsed = parseVerifyConfig(record)
    const disabled = parsed.checkers.length === 0 && parsed.commentPattern === null
    return { ...parsed, source: disabled ? "disabled" : "config" }
  }
  return { checkers: detectCheckers(directory), timeoutMs: DEFAULT_TIMEOUT_MS, commentPattern: DEFAULT_COMMENT_PATTERN, source: "detected" }
}
