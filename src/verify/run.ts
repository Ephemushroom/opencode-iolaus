import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import type { Checker, VerifyConfig } from "./config"

/** Paths named by the host's edit/write/patch inputs, resolved against the session directory. */
export function mutatedPaths(input: unknown, directory: string): string[] {
  if (typeof input !== "object" || input === null) return []
  const record = input as Record<string, unknown>
  const found = new Set<string>()
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) found.add(resolve(directory, value.trim())) }
  for (const key of ["filePath", "path", "file"]) add(record[key])
  for (const key of ["paths", "filePaths", "files"]) if (Array.isArray(record[key])) for (const item of record[key] as unknown[]) add(typeof item === "object" && item ? (item as Record<string, unknown>).path : item)
  for (const key of ["patchText", "patch", "input", "text"]) {
    const text = record[key]
    if (typeof text !== "string" || !text.includes("*** ")) continue
    for (const line of text.split(/\r?\n/)) {
      for (const prefix of ["*** Add File: ", "*** Update File: ", "*** Move to: "]) if (line.startsWith(prefix)) add(line.slice(prefix.length))
    }
  }
  return [...found]
}

export interface Diagnostic {
  readonly path: string
  readonly line?: number
  readonly message: string
}

export interface CheckerResult {
  readonly name: string
  readonly ok: boolean
  readonly diagnostics: readonly Diagnostic[]
  readonly durationMs: number
  readonly error?: string
}

export interface VerifyReport {
  readonly paths: readonly string[]
  readonly checkers: readonly CheckerResult[]
  readonly comments: readonly Diagnostic[]
}

function inside(directory: string, target: string): boolean {
  const rel = relative(directory, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

// tsc:  src/a.ts(3,7): error TS2322: ...      biome/eslint/gcc: src/a.ts:3:7 - error ...
const LOCATION = /^(?<path>[^\s:(]+(?:\/[^\s:(]+)*)(?:\((?<l1>\d+),\d+\)|:(?<l2>\d+)(?::\d+)?)[\s:-]+(?<msg>.*)$/

/** Keep lines that locate a diagnostic in one of the changed files. */
export function filterDiagnostics(output: string, directory: string, changed: readonly string[]): Diagnostic[] {
  const wanted = new Set(changed.map((path) => resolve(directory, path)))
  const result: Diagnostic[] = []
  for (const raw of output.split(/\r?\n/)) {
    const match = LOCATION.exec(raw.trim())
    if (!match?.groups) continue
    const path = resolve(directory, match.groups.path)
    if (!wanted.has(path)) continue
    const line = Number(match.groups.l1 ?? match.groups.l2)
    result.push({ path: relative(directory, path), ...(Number.isFinite(line) ? { line } : {}), message: match.groups.msg.trim() })
  }
  return result
}

function runChecker(checker: Checker, directory: string, changed: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<CheckerResult> {
  const started = Date.now()
  return new Promise((done) => {
    const [command, ...args] = checker.argv
    execFile(command, args, { cwd: directory, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", signal, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started
      const output = `${stdout ?? ""}\n${stderr ?? ""}`
      const diagnostics = filterDiagnostics(output, directory, changed)
      const failedToRun = error && !("code" in error && typeof error.code === "number")
      if (failedToRun) return done({ name: checker.name, ok: false, diagnostics, durationMs, error: String((error as Error).message).split("\n")[0] })
      done({ name: checker.name, ok: diagnostics.length === 0, diagnostics, durationMs })
    })
  })
}

export function scanComments(paths: readonly string[], directory: string, pattern: string | null): Diagnostic[] {
  if (!pattern) return []
  const regex = new RegExp(pattern, "i")
  const result: Diagnostic[] = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    let text: string
    try { text = readFileSync(path, "utf8") } catch { continue }
    if (text.includes("\0")) continue
    text.split(/\r?\n/).forEach((line, index) => {
      if (regex.test(line)) result.push({ path: relative(directory, path), line: index + 1, message: `comment explains a request, not the code: ${line.trim().slice(0, 120)}` })
    })
  }
  return result
}

export async function verify(config: VerifyConfig, directory: string, paths: readonly string[], signal?: AbortSignal): Promise<VerifyReport> {
  const changed = paths.filter((path) => inside(directory, path) && existsSync(path))
  const applicable = config.checkers.filter((checker) => !checker.extensions || changed.some((path) => checker.extensions!.some((ext) => path.endsWith(ext))))
  const checkers = changed.length ? await Promise.all(applicable.map((checker) => runChecker(checker, directory, changed, config.timeoutMs, signal))) : []
  return { paths: changed.map((path) => relative(directory, path)), checkers, comments: scanComments(changed, directory, config.commentPattern) }
}

/** Text appended to the mutating tool's result. Empty when everything passed. */
export function renderReport(report: VerifyReport): string {
  const lines: string[] = []
  for (const checker of report.checkers) {
    if (checker.error) lines.push(`${checker.name}: could not run (${checker.error})`)
    for (const d of checker.diagnostics) lines.push(`${checker.name}: ${d.path}${d.line ? `:${d.line}` : ""} ${d.message}`)
  }
  for (const d of report.comments) lines.push(`comment-check: ${d.path}:${d.line} ${d.message}`)
  if (!lines.length) return ""
  return `\n\n[iolaus verify] ${lines.length} issue${lines.length === 1 ? "" : "s"} in changed files. Fix before moving on.\n${lines.join("\n")}`
}
