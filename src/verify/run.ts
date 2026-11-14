import { execFile, type ExecFileException } from "node:child_process"
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

// tsc:  src/a.ts(3,7): error TS2322: ...      eslint unix / ruff concise / cargo short / go vet: src/a.ts:3:7 - error ... or ./a.go:3:2: msg
const LOCATION = /^(?<path>[^:(]+)(?:\((?<l1>\d+),\d+\)|:(?<l2>\d+)(?::\d+)?)[\s:-]+(?<msg>.*)$/
// biome --reporter=github:  ::error title=lint/x,file=src/a.ts,line=3,endLine=3,col=1,endColumn=2::message
const GITHUB = /^::(?:error|warning|notice)\b(?<attrs>[^:]*)::(?<msg>.*)$/

/** A diagnostic with its absolute path, before it is narrowed to the changed files. */
type Located = { readonly path: string; readonly line?: number; readonly message: string }

function located(output: string, directory: string): Located[] {
  const result: Located[] = []
  for (const raw of output.split(/\r?\n/)) {
    const gh = GITHUB.exec(raw.trim())
    if (gh?.groups) {
      const attrs = Object.fromEntries(gh.groups.attrs.split(",").map((pair) => pair.split("=").map((s) => s.trim())).filter((pair) => pair.length === 2))
      if (attrs.file) result.push({ path: resolve(directory, attrs.file), ...(attrs.line ? { line: Number(attrs.line) } : {}), message: `${attrs.title ? `${attrs.title}: ` : ""}${gh.groups.msg.trim()}` })
      continue
    }
    const match = LOCATION.exec(raw.trim())
    if (!match?.groups) continue
    const line = Number(match.groups.l1 ?? match.groups.l2)
    result.push({ path: resolve(directory, match.groups.path), ...(Number.isFinite(line) ? { line } : {}), message: match.groups.msg.trim() })
  }
  return result
}

/** JSON reporters: an array (or `diagnostics`/`results` array) of objects naming a file and optionally a line and message. Undefined for malformed or unsupported reports. */
function locatedJson(output: string, directory: string): Located[] | undefined {
  if (!output.trim()) return []
  let parsed: unknown
  try { parsed = JSON.parse(output.trim()) } catch { return undefined }
  const list = Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { diagnostics?: unknown }).diagnostics) ? (parsed as { diagnostics: unknown[] }).diagnostics
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown }).results) ? (parsed as { results: unknown[] }).results
    : undefined
  if (!list) return undefined
  const result: Located[] = []
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
    const record = item as Record<string, unknown>
    // ESLint's JSON groups messages per file.
    if (Array.isArray(record.messages) && typeof record.filePath === "string" && record.filePath.trim()) {
      const path = resolve(directory, record.filePath)
      for (const entry of record.messages) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
        const message = entry.message ?? entry.ruleId ?? ""
        if (typeof message !== "string" && typeof message !== "number") return undefined
        result.push({ path, ...(typeof entry.line === "number" ? { line: entry.line } : {}), message: String(message) })
      }
      continue
    }
    if (record.messages !== undefined) return undefined
    const file = record.file ?? record.path ?? record.filename ?? record.filePath ?? (record.location as { file?: unknown } | undefined)?.file
    if (typeof file !== "string" || !file.trim()) return undefined
    const line = record.line ?? (record.location as { line?: unknown; row?: unknown } | undefined)?.line ?? (record.location as { row?: unknown } | undefined)?.row ?? (record.start as { line?: unknown } | undefined)?.line
    const message = record.message ?? record.code ?? record.rule ?? ""
    if (typeof message !== "string" && typeof message !== "number") return undefined
    result.push({ path: resolve(directory, file), ...(typeof line === "number" ? { line } : {}), message: String(message) })
  }
  return result
}

function inChanged(all: readonly Located[], directory: string, changed: readonly string[]): Diagnostic[] {
  const wanted = new Set(changed.map((path) => resolve(directory, path)))
  return all.filter((item) => wanted.has(item.path)).map((item) => ({ ...item, path: relative(directory, item.path) }))
}

/** Keep lines that locate a diagnostic in one of the changed files. */
export function filterDiagnostics(output: string, directory: string, changed: readonly string[]): Diagnostic[] {
  return inChanged(located(output, directory), directory, changed)
}

export function filterJsonDiagnostics(output: string, directory: string, changed: readonly string[]): Diagnostic[] {
  return inChanged(locatedJson(output, directory) ?? [], directory, changed)
}

function runChecker(checker: Checker, directory: string, changed: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<CheckerResult> {
  const started = Date.now()
  return new Promise((done) => {
    const [command, ...args] = checker.argv
    let settled = false
    let termination: string | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    const finish = (error: ExecFileException | null, stdout: string, stderr: string) => {
      if (settled || (termination && child.exitCode === null && child.signalCode === null && grace !== undefined)) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(grace)
      signal?.removeEventListener("abort", abort)
      const durationMs = Date.now() - started
      const output = `${stdout ?? ""}\n${stderr ?? ""}`
      const all = checker.format === "json" ? locatedJson(stdout ?? "", directory) : located(output, directory)
      const diagnostics = inChanged(all ?? [], directory, changed)
      const said = output.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 300) ?? "no output"
      const code = error && "code" in error && typeof error.code === "number" ? error.code : undefined
      // A checker that did not get as far as locating a problem checked nothing: it could not start, was killed,
      // printed something unreadable, or exited with an error and no diagnostic. None of that is a pass.
      const failure = termination ?? (child.killed || signal?.aborted || error?.killed || error?.signal || (error && code === undefined) ? String(error?.message ?? "checker terminated").split("\n")[0]
        : all === undefined ? `output is not JSON: ${said}`
        : code !== undefined && all.length === 0 ? `exit code ${code}: ${said}`
        : undefined)
      done({ name: checker.name, ok: failure === undefined && diagnostics.length === 0, diagnostics, durationMs, ...(failure === undefined ? {} : { error: failure }) })
    }
    const terminate = (reason: string) => {
      if (settled || termination) return
      termination = reason
      clearTimeout(timeout)
      grace = setTimeout(() => {
        grace = undefined
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null, "", "")
      }, 100)
      child.kill("SIGTERM")
    }
    const abort = () => terminate("checker cancelled")
    const child = execFile(command, args, { cwd: directory, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } }, finish)
    timeout = setTimeout(() => terminate(`checker timed out after ${timeoutMs}ms`), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
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
  signal?.throwIfAborted()
  const changed = paths.filter((path) => inside(directory, path) && existsSync(path))
  const applicable = config.checkers.filter((checker) => !checker.extensions || changed.some((path) => checker.extensions!.some((ext) => path.endsWith(ext))))
  const checkers = changed.length ? await Promise.all(applicable.map((checker) => runChecker(checker, directory, changed, config.timeoutMs, signal))) : []
  signal?.throwIfAborted()
  return { paths: changed.map((path) => relative(directory, path)), checkers, comments: scanComments(changed, directory, config.commentPattern) }
}

/** Text appended to the mutating tool's result. Empty when everything passed. */
export function renderReport(report: VerifyReport): string {
  const lines: string[] = []
  for (const checker of report.checkers) {
    if (checker.error) lines.push(`${checker.name}: check failed (${checker.error})`)
    for (const d of checker.diagnostics) lines.push(`${checker.name}: ${d.path}${d.line ? `:${d.line}` : ""} ${d.message}`)
  }
  for (const d of report.comments) lines.push(`comment-check: ${d.path}:${d.line} ${d.message}`)
  if (!lines.length) return ""
  return `\n\n[iolaus verify] ${lines.length} issue${lines.length === 1 ? "" : "s"} in changed files. Fix before moving on.\n${lines.join("\n")}`
}
