import { isAbsolute, relative, resolve } from "node:path"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import {
  executeRewrite, executeScan, executeSearch, searchInputSchema,
  REWRITE_TOOL_DESCRIPTION, SCAN_TOOL_DESCRIPTION, SEARCH_TOOL_DESCRIPTION,
  type NormalizedMatch,
} from "@iolaus/ast-grep-core"
import { blockedResources, type PermissionRule } from "./permissions"

export const AST_GREP_NAMESPACE = "ast_grep"
export const AST_GREP_NAMESPACE_DESCRIPTION =
  "Structural code search and codemods with ast-grep. Prefer ast_grep.search over grep whenever the question is about code shape (calls, declarations, imports, JSX, class members) rather than text; use ast_grep.rewrite for codemods (dry-run by default) and ast_grep.scan for YAML rules. Paths are relative to the session directory."

/** What the tools need from the host, per call. */
export interface AstGrepHost {
  readonly directory: (sessionID: string) => Promise<string>
  readonly rules: (sessionID: string, agent: string) => Promise<readonly PermissionRule[]>
  readonly trace?: (event: string, data: Record<string, unknown>) => void
}

const LANGUAGES = [
  "bash", "c", "cpp", "csharp", "css", "elixir", "go", "haskell", "html",
  "java", "javascript", "json", "kotlin", "lua", "nix", "php", "python",
  "ruby", "rust", "scala", "solidity", "swift", "typescript", "tsx", "yaml",
] as const
const STRICTNESS = ["cst", "smart", "ast", "relaxed", "signature"] as const
const PATTERN_BYTES_NOTE = "Max 16 KiB (16384 BYTES, UTF-8) — the limit counts bytes, not characters."
const REWRITE_BYTES_NOTE = "Max 64 KiB (65536 BYTES, UTF-8) — the limit counts bytes, not characters."

const paths = { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: 4096 }, description: "Files or directories, relative to the session directory. Required — there is no implicit '.' default." } as const
const globs = { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 1024 }, description: "Optional include/exclude globs passed through to ast-grep." } as const
const maxMatches = { type: "integer", minimum: 1, maximum: 500, description: "Maximum matches to return (default 50)." } as const
const timeoutMs = { type: "integer", minimum: 1000, maximum: 300000, description: "Whole-call timeout budget in milliseconds (default 300000)." } as const
const includeHidden = { type: "boolean", description: "Include hidden files (--no-ignore hidden)." } as const
const followSymlinks = { type: "boolean", description: "Follow symlinks (--follow)." } as const
const pattern = { type: "string", minLength: 1, description: `ast-grep pattern — code, not regex. ${PATTERN_BYTES_NOTE}` } as const
const language = { type: "string", enum: [...LANGUAGES], description: "Language the pattern must parse in." } as const
const selector = { type: "string", minLength: 1, maxLength: 128, description: "Optional sub-node selector." } as const
const strictness = { type: "string", enum: [...STRICTNESS], description: "Match strictness (default smart)." } as const
const force = { type: "boolean", description: "Bypass non-fatal pattern hint rejections." } as const

const match = {
  type: "object",
  properties: {
    path: { type: "string" },
    language: { type: "string" },
    text: { type: "string" },
    replacement: { type: "string" },
    range: { type: "object", description: "{start, end}, each {line (1-based), column, byteOffset}." },
    metavariables: { type: "object", description: "{single: {NAME: text}, multi: {NAME: text}}." },
    rule: { type: "object", description: "scan only: {ruleId, severity, message, note}." },
  },
} as const

const output = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    kind: { type: "string" },
    workdir: { type: "string" },
    applied: { type: "boolean" },
    matches: { type: "array", items: match },
    counts: { type: "object", description: "search: returnedMatches, returnedFiles, totalMatches (null when truncated); rewrite/scan: plannedMatches, plannedFiles." },
    truncation: { type: "object", description: "{truncated, reason, maxMatches, maxPayloadBytes, salvagedRecords}." },
    warnings: { type: "array", items: { type: "string" } },
    error: { type: "object", description: "{code, message, retryable, phase, details} when ok is false." },
    durationMs: { type: "number" },
  },
  required: ["ok"],
} as const

type Payload = { readonly ok: boolean; readonly error?: { readonly code?: string } & Record<string, unknown>; readonly matches?: readonly unknown[]; readonly truncation?: { readonly truncated?: boolean }; readonly applied?: boolean }

function invalid(kind: string, message: string): Payload & Record<string, unknown> {
  return { schemaVersion: 1, ok: false, kind, error: { code: "INVALID_ARGUMENT", message, retryable: false, phase: "preflight", details: {} } }
}

function inside(directory: string, target: string): boolean {
  const rel = relative(directory, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Plugin tools run in-process, so the host's per-resource checks do not apply to them.
 * Paths outside the session directory need an explicit `external_directory` allow,
 * the same rule the native read and grep tools consult.
 */
function scopeError(directory: string, targets: readonly string[], rules: readonly PermissionRule[]): string | undefined {
  const outside = targets.map((target) => resolve(directory, target)).filter((target) => !inside(directory, target))
  const blocked = blockedResources("external_directory", outside, rules)
  return blocked.length ? `Outside the session directory and not allowed by external_directory permission: ${blocked.join(", ")}. Use native read or grep, which can ask for approval.` : undefined
}

function editVeto(directory: string, rules: readonly PermissionRule[]) {
  return (matches: readonly NormalizedMatch[]): string | undefined => {
    const files = [...new Set(matches.map((m) => relative(directory, resolve(directory, m.path))))]
    const blocked = blockedResources("edit", files, rules)
    return blocked.length ? `edit permission does not allow writing: ${blocked.join(", ")}. Nothing was modified; apply these changes with the native edit tool, which can ask for approval.` : undefined
  }
}

export function createAstGrepTools(sgPath: string, host: AstGrepHost): Info[] {
  const run = (kind: "search" | "rewrite" | "scan", execute: (raw: Record<string, unknown>, directory: string, rules: readonly PermissionRule[], context: ToolContext) => Promise<Payload>) =>
    async (raw: unknown, context: ToolContext) => {
      const sessionID = String(context.sessionID)
      const input = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
      let payload: Payload
      if (input.workdir !== undefined) payload = invalid(kind, "workdir is fixed to the session directory; pass paths relative to it instead.")
      else {
        const [directory, rules] = await Promise.all([host.directory(sessionID), host.rules(sessionID, String(context.agent))])
        const targets = [...(Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string") : []), ...(typeof input.ruleFile === "string" ? [input.ruleFile] : [])]
        const scoped = scopeError(directory, targets, rules)
        payload = scoped ? invalid(kind, scoped) : await execute(input, directory, rules, context)
      }
      host.trace?.("iolaus.ast_grep.call", {
        tool: kind, sessionID, agent: String(context.agent), ok: payload.ok, code: payload.error?.code ?? null,
        matches: payload.matches?.length ?? 0, truncated: payload.truncation?.truncated ?? false, applied: payload.applied ?? false,
      })
      return { output: payload }
    }

  return [
    {
      name: "search",
      description: `${SEARCH_TOOL_DESCRIPTION} Paths are relative to the session directory.`,
      input: { type: "object", properties: { pattern, language, paths, globs, selector, strictness, maxMatches, timeoutMs, includeHidden, followSymlinks, force }, required: ["pattern", "language", "paths"], additionalProperties: false },
      output,
      options: { namespace: AST_GREP_NAMESPACE, pinned: true, permission: "grep" },
      execute: run("search", async (raw, directory, _rules, context) => {
        let parsed
        try { parsed = searchInputSchema.parse(raw) } catch (error) { return invalid("search", error instanceof Error ? error.message : String(error)) }
        return executeSearch({ ...parsed, workdir: directory }, sgPath, context.signal)
      }),
    },
    {
      name: "rewrite",
      description: `${REWRITE_TOOL_DESCRIPTION} Applying also requires edit permission on every file in the preview. Paths are relative to the session directory.`,
      input: { type: "object", properties: { pattern, rewrite: { type: "string", description: `Replacement code; empty deletes the match. ${REWRITE_BYTES_NOTE}` }, language, paths, globs, selector, strictness, apply: { type: "boolean", description: "Write the rewrite to disk. Default false (dry run)." }, maxMatches, timeoutMs, includeHidden, followSymlinks, force }, required: ["pattern", "rewrite", "language", "paths"], additionalProperties: false },
      output,
      options: { namespace: AST_GREP_NAMESPACE, pinned: true, permission: "edit" },
      execute: run("rewrite", (raw, directory, rules, context) =>
        executeRewrite({ ...raw, workdir: directory } as never, sgPath, context.signal, { onPreviewComplete: editVeto(directory, rules) })),
    },
    {
      name: "scan",
      description: `${SCAN_TOOL_DESCRIPTION} Applying fixes also requires edit permission on every file in the preview. Paths are relative to the session directory.`,
      input: { type: "object", properties: { ruleFile: { type: "string", minLength: 1, maxLength: 4096, description: "Path to a YAML rule file. Mutually exclusive with inlineRules." }, inlineRules: { type: "string", minLength: 1, description: `Inline YAML rule text. Mutually exclusive with ruleFile. ${REWRITE_BYTES_NOTE}` }, paths, globs, maxMatches, timeoutMs, includeHidden, followSymlinks, includeMetadata: { type: "boolean", description: "Include rule metadata in each match." }, apply: { type: "boolean", description: "Write rule fixes to disk. Default false (dry run)." } }, required: ["paths"], additionalProperties: false },
      output,
      options: { namespace: AST_GREP_NAMESPACE, permission: "grep" },
      execute: run("scan", (raw, directory, rules, context) =>
        executeScan({ ...raw, workdir: directory }, sgPath, context.signal, { onPreviewComplete: editVeto(directory, rules) })),
    },
  ] as unknown as Info[]
}
