import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import type { GhBinary } from "./binary"

export const GH_NAMESPACE = "gh"
export const GH_PERMISSION = "gh"
export const GH_NAMESPACE_DESCRIPTION =
  "Read-only GitHub access through the user's authenticated gh CLI: search code and repositories, view repositories, issues and pull requests, read PR diffs, shallow-clone a repository into a temporary directory and read its git log/blame/show. Nothing here writes to GitHub. For wide regex code search across public repos prefer grep_app; use gh for a known repository, issues, PRs, and history."

export interface GhHost {
  readonly trace?: (event: string, data: Record<string, unknown>) => void
  readonly timeoutMs?: number
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/
const PATH_IN_REPO = /^(?!\/)(?!.*\.\.)[^\0]{1,1024}$/
const CLONE_ROOT = "iolaus-gh-"
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 512 * 1024

type Payload = { readonly ok: boolean; readonly kind: string } & Record<string, unknown>

function invalid(kind: string, message: string): Payload {
  return { ok: false, kind, error: { code: "INVALID_ARGUMENT", message } }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function int(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback
}

function run(command: string, args: readonly string[], cwd: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; failedToRun?: string }> {
  return new Promise((done) => {
    execFile(command, [...args], { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES * 4, encoding: "utf8", signal, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", CLICOLOR: "0", GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? -1 : 0
      const failedToRun = error && typeof (error as { code?: unknown }).code !== "number" ? String((error as Error).message).split("\n")[0] : undefined
      done({ code, stdout: String(stdout ?? "").slice(0, MAX_OUTPUT_BYTES), stderr: String(stderr ?? "").slice(0, 8192), failedToRun })
    })
  })
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** Cloned repositories live only under the session's temp root; a clone path must resolve inside it. */
function insideCloneRoot(path: string): boolean {
  const root = realpathSync(tmpdir())
  let target: string
  try { target = realpathSync(path) } catch { return false }
  const rel = relative(root, target)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && rel.split(/[\\/]/)[0].startsWith(CLONE_ROOT)
}

const repoProp = { type: "string", description: "OWNER/REPO" } as const
const limitProp = { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 30)." } as const
const numberProp = { type: "integer", minimum: 1 } as const
const cloneProp = { type: "string", description: "Absolute path returned by gh.clone." } as const
const output = { type: "object", properties: { ok: { type: "boolean" }, kind: { type: "string" } }, required: ["ok", "kind"] } as const

export function createGhTools(binary: GhBinary, host: GhHost = {}): Info[] {
  const timeoutMs = host.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const gh = (args: readonly string[], signal?: AbortSignal) => run(binary.path, args, undefined, timeoutMs, signal)

  const tool = (name: string, description: string, properties: Record<string, unknown>, required: readonly string[], execute: (input: Record<string, unknown>, context: ToolContext) => Promise<Payload>): Info => ({
    name,
    description,
    input: { type: "object", properties, required: [...required], additionalProperties: false },
    output,
    options: { namespace: GH_NAMESPACE, permission: GH_PERMISSION },
    async execute(raw: unknown, context: ToolContext) {
      const input = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
      const started = Date.now()
      const payload = await execute(input, context)
      host.trace?.("iolaus.gh.call", { tool: name, agent: String(context.agent), ok: payload.ok, code: (payload.error as { code?: string } | undefined)?.code ?? null, durationMs: Date.now() - started })
      return { output: payload }
    },
  })

  const ghJson = async (kind: string, args: readonly string[], signal?: AbortSignal): Promise<Payload> => {
    const result = await gh(args, signal)
    if (result.failedToRun) return { ok: false, kind, error: { code: "GH_UNAVAILABLE", message: result.failedToRun } }
    if (result.code !== 0) return { ok: false, kind, error: { code: /auth|login|401|HTTP 403/i.test(result.stderr) ? "GH_AUTH" : /rate limit/i.test(result.stderr) ? "GH_RATE_LIMIT" : "GH_ERROR", message: result.stderr.trim() || `gh exited ${result.code}` } }
    const data = parseJson(result.stdout)
    return data === undefined ? { ok: true, kind, text: result.stdout } : { ok: true, kind, data }
  }

  return [
    tool("searchCode", "Search code on GitHub (GitHub code search: literal terms, no regex, ~10 requests/min). Filters: repo, owner, language, filename, extension.",
      { query: { type: "string", minLength: 1 }, repo: repoProp, owner: { type: "string" }, language: { type: "string" }, filename: { type: "string" }, extension: { type: "string" }, limit: limitProp }, ["query"],
      async (input, context) => {
        const query = str(input.query); if (!query) return invalid("searchCode", "query is required")
        if (input.repo !== undefined && !REPO.test(String(input.repo))) return invalid("searchCode", "repo must be OWNER/REPO")
        const args = ["search", "code", query, "--limit", String(int(input.limit, 30, 100)), "--json", "repository,path,textMatches,url"]
        for (const [flag, key] of [["--repo", "repo"], ["--owner", "owner"], ["--language", "language"], ["--filename", "filename"], ["--extension", "extension"]] as const) { const v = str(input[key]); if (v) args.push(flag, v) }
        return ghJson("searchCode", args, context.signal)
      }),
    tool("searchRepos", "Search repositories by keywords; filters: owner, language, topic.",
      { query: { type: "string", minLength: 1 }, owner: { type: "string" }, language: { type: "string" }, topic: { type: "string" }, limit: limitProp }, ["query"],
      async (input, context) => {
        const query = str(input.query); if (!query) return invalid("searchRepos", "query is required")
        const args = ["search", "repos", query, "--limit", String(int(input.limit, 30, 100)), "--json", "fullName,description,stargazersCount,language,url,updatedAt"]
        for (const [flag, key] of [["--owner", "owner"], ["--language", "language"], ["--topic", "topic"]] as const) { const v = str(input[key]); if (v) args.push(flag, v) }
        return ghJson("searchRepos", args, context.signal)
      }),
    tool("repo", "View repository metadata (description, default branch, languages, license, stars, topics, latest release, README excerpt).",
      { repo: repoProp }, ["repo"],
      async (input, context) => {
        const repo = str(input.repo); if (!repo || !REPO.test(repo)) return invalid("repo", "repo must be OWNER/REPO")
        return ghJson("repo", ["repo", "view", repo, "--json", "name,owner,description,defaultBranchRef,languages,licenseInfo,stargazerCount,repositoryTopics,latestRelease,url,isArchived,pushedAt"], context.signal)
      }),
    tool("issues", "List issues in a repository. state: open|closed|all; search uses GitHub issue search syntax.",
      { repo: repoProp, state: { type: "string", enum: ["open", "closed", "all"] }, search: { type: "string" }, label: { type: "string" }, limit: limitProp }, ["repo"],
      async (input, context) => {
        const repo = str(input.repo); if (!repo || !REPO.test(repo)) return invalid("issues", "repo must be OWNER/REPO")
        const args = ["issue", "list", "--repo", repo, "--state", str(input.state) ?? "open", "--limit", String(int(input.limit, 30, 100)), "--json", "number,title,state,author,labels,createdAt,updatedAt,url"]
        const search = str(input.search); if (search) args.push("--search", search)
        const label = str(input.label); if (label) args.push("--label", label)
        return ghJson("issues", args, context.signal)
      }),
    tool("issue", "View one issue with its body and comments.",
      { repo: repoProp, number: numberProp }, ["repo", "number"],
      async (input, context) => {
        const repo = str(input.repo); if (!repo || !REPO.test(repo)) return invalid("issue", "repo must be OWNER/REPO")
        const number = int(input.number, 0, 1e9); if (!number) return invalid("issue", "number is required")
        return ghJson("issue", ["issue", "view", String(number), "--repo", repo, "--json", "number,title,state,author,body,labels,comments,createdAt,closedAt,url"], context.signal)
      }),
    tool("prs", "List pull requests. state: open|closed|merged|all.",
      { repo: repoProp, state: { type: "string", enum: ["open", "closed", "merged", "all"] }, search: { type: "string" }, limit: limitProp }, ["repo"],
      async (input, context) => {
        const repo = str(input.repo); if (!repo || !REPO.test(repo)) return invalid("prs", "repo must be OWNER/REPO")
        const args = ["pr", "list", "--repo", repo, "--state", str(input.state) ?? "open", "--limit", String(int(input.limit, 30, 100)), "--json", "number,title,state,author,headRefName,baseRefName,createdAt,mergedAt,url"]
        const search = str(input.search); if (search) args.push("--search", search)
        return ghJson("prs", args, context.signal)
      }),
    tool("pr", "View one pull request: body, files changed, review decision, commits, comments.",
      { repo: repoProp, number: numberProp }, ["repo", "number"],
      async (input, context) => {
        const repo = str(input.repo); if (!repo || !REPO.test(repo)) return invalid("pr", "repo must be OWNER/REPO")
        const number = int(input.number, 0, 1e9); if (!number) return invalid("pr", "number is required")
        return ghJson("pr", ["pr", "view", String(number), "--repo", repo, "--json", "number,title,state,author,body,headRefName,baseRefName,files,commits,reviewDecision,comments,mergedAt,url"], context.signal)
      }),
    tool("prDiff", "Read a pull request's diff (patch format), or only the changed file names.",
      { repo: repoProp, number: numberProp, nameOnly: { type: "boolean" } }, ["repo", "number"],
      async (input, context) => {
        const repo = str(input.repo); if (!repo || !REPO.test(repo)) return invalid("prDiff", "repo must be OWNER/REPO")
        const number = int(input.number, 0, 1e9); if (!number) return invalid("prDiff", "number is required")
        const args = ["pr", "diff", String(number), "--repo", repo, "--color", "never", ...(input.nameOnly === true ? ["--name-only"] : ["--patch"])]
        const result = await gh(args, context.signal)
        if (result.failedToRun) return { ok: false, kind: "prDiff", error: { code: "GH_UNAVAILABLE", message: result.failedToRun } }
        if (result.code !== 0) return { ok: false, kind: "prDiff", error: { code: "GH_ERROR", message: result.stderr.trim() } }
        return { ok: true, kind: "prDiff", text: result.stdout, truncated: result.stdout.length >= MAX_OUTPUT_BYTES }
      }),
    tool("clone", "Shallow-clone a repository (depth 1, optional ref) into a fresh temporary directory and return its absolute path. Read files there with native read/grep or ast_grep (the path is outside the project, so external_directory permission applies) and use gh.log/blame/show for history.",
      { repo: repoProp, ref: { type: "string", description: "Branch or tag (default: default branch)." }, depth: { type: "integer", minimum: 1, maximum: 1000, description: "History depth (default 1). Increase for gh.log/blame." } }, ["repo"],
      async (input, context) => {
        const repo = str(input.repo); if (!repo || !REPO.test(repo)) return invalid("clone", "repo must be OWNER/REPO")
        const ref = str(input.ref); if (ref && !REF.test(ref)) return invalid("clone", "ref contains unsupported characters")
        const dir = mkdtempSync(join(realpathSync(tmpdir()), CLONE_ROOT))
        const target = join(dir, repo.split("/")[1])
        const args = ["repo", "clone", repo, target, "--", "--depth", String(int(input.depth, 1, 1000)), "--quiet", ...(ref ? ["--branch", ref] : [])]
        const result = await gh(args, context.signal)
        if (result.failedToRun) return { ok: false, kind: "clone", error: { code: "GH_UNAVAILABLE", message: result.failedToRun } }
        if (result.code !== 0) return { ok: false, kind: "clone", error: { code: "GH_ERROR", message: result.stderr.trim() } }
        return { ok: true, kind: "clone", path: target, repo, ref: ref ?? null }
      }),
    tool("log", "git log of a cloned repository (from gh.clone). Optional path filter and max count.",
      { clone: cloneProp, path: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 500 } }, ["clone"],
      async (input, context) => {
        const clone = str(input.clone); if (!clone || !insideCloneRoot(clone)) return invalid("log", "clone must be a path returned by gh.clone")
        const path = str(input.path); if (path && !PATH_IN_REPO.test(path)) return invalid("log", "path must be relative and inside the repository")
        const args = ["log", `--max-count=${int(input.count, 50, 500)}`, "--date=iso-strict", "--pretty=format:%H%x09%an%x09%ad%x09%s", "--no-color", ...(path ? ["--", path] : [])]
        const result = await run("git", args, clone, timeoutMs, context.signal)
        if (result.failedToRun || result.code !== 0) return { ok: false, kind: "log", error: { code: "GIT_ERROR", message: result.failedToRun ?? result.stderr.trim() } }
        return { ok: true, kind: "log", commits: result.stdout.split("\n").filter(Boolean).map((line) => { const [sha, author, date, ...subject] = line.split("\t"); return { sha, author, date, subject: subject.join("\t") } }) }
      }),
    tool("blame", "git blame for a file in a cloned repository; optional line range.",
      { clone: cloneProp, path: { type: "string" }, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } }, ["clone", "path"],
      async (input, context) => {
        const clone = str(input.clone); if (!clone || !insideCloneRoot(clone)) return invalid("blame", "clone must be a path returned by gh.clone")
        const path = str(input.path); if (!path || !PATH_IN_REPO.test(path) || !existsSync(resolve(clone, path))) return invalid("blame", "path must name a file inside the clone")
        const range = typeof input.start === "number" ? ["-L", `${int(input.start, 1, 1e7)},${int(input.end, int(input.start, 1, 1e7), 1e7)}`] : []
        const result = await run("git", ["blame", "--date=short", ...range, "--", path], clone, timeoutMs, context.signal)
        if (result.failedToRun || result.code !== 0) return { ok: false, kind: "blame", error: { code: "GIT_ERROR", message: result.failedToRun ?? result.stderr.trim() } }
        return { ok: true, kind: "blame", text: result.stdout, truncated: result.stdout.length >= MAX_OUTPUT_BYTES }
      }),
    tool("show", "git show for a commit in a cloned repository (message and patch, or --stat only).",
      { clone: cloneProp, sha: { type: "string" }, stat: { type: "boolean" } }, ["clone", "sha"],
      async (input, context) => {
        const clone = str(input.clone); if (!clone || !insideCloneRoot(clone)) return invalid("show", "clone must be a path returned by gh.clone")
        const sha = str(input.sha); if (!sha || !/^[0-9a-fA-F]{4,40}$/.test(sha)) return invalid("show", "sha must be a hex commit id")
        const result = await run("git", ["show", "--no-color", ...(input.stat === true ? ["--stat"] : []), sha], clone, timeoutMs, context.signal)
        if (result.failedToRun || result.code !== 0) return { ok: false, kind: "show", error: { code: "GIT_ERROR", message: result.failedToRun ?? result.stderr.trim() } }
        return { ok: true, kind: "show", text: result.stdout, truncated: result.stdout.length >= MAX_OUTPUT_BYTES }
      }),
  ]
}
