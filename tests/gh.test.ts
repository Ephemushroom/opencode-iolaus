import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { resolveGhBinary } from "../src/gh/binary"
import { createGhTools, GH_NAMESPACE, GH_PERMISSION } from "../src/gh/tools"
import { parseOptions } from "../src/options"
import { registerAgents } from "../src/registration"
import { evaluate, type PermissionRule } from "../src/ast-grep/permissions"

const gh = resolveGhBinary()
const live = gh?.authenticated ? test : test.skip
const ctx = (agent = "iolaus-librarian") => ({ sessionID: "ses_test", agent, signal: new AbortController().signal } as never)
const byName = (name: string) => createGhTools({ path: gh?.path ?? "/nonexistent/gh", version: "0", authenticated: true }).find((t) => t.name === name)!

test("gh binary probe requires a gh that answers --version; a missing override yields nothing", () => {
  expect(resolveGhBinary({ env: { IOLAUS_GH_BIN: "/definitely/not/gh" } })).toBeUndefined()
  expect(resolveGhBinary({ env: {}, directories: ["/definitely/not"] })).toBeUndefined()
  if (gh) expect(gh.version).toMatch(/^\d+\.\d+/)
})

test("gh tools carry the gh permission, and only librarian is allowed it", async () => {
  const tools = createGhTools({ path: "/x/gh", version: "0", authenticated: true })
  expect(tools.map((t) => t.name).sort()).toEqual(["blame", "clone", "issue", "issues", "log", "pr", "prDiff", "prs", "repo", "searchCode", "searchRepos", "show"])
  expect(tools.every((t) => t.options?.namespace === GH_NAMESPACE && t.options?.permission === GH_PERMISSION)).toBe(true)
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: (id) => agents.get(id), default: () => {}, remove: (id) => { agents.delete(id) },
    update: (id, update) => { const value = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id)); update(value); agents.set(id, value) },
  }
  await registerAgents({ agent: { transform: async (run) => { run(editor); return { dispose: async () => {} } } } }, parseOptions({}))
  const rules = (id: string) => agents.get(id)!.permissions as readonly PermissionRule[]
  expect(evaluate("gh", "*", rules("iolaus-librarian"))).toBe("allow")
  expect(evaluate("external_directory", `${tmpdir()}/iolaus-gh-abc/react`, rules("iolaus-librarian"))).toBe("allow")
  expect(evaluate("external_directory", `${tmpdir()}/other`, rules("iolaus-librarian"))).toBe("deny")
  expect(evaluate("shell", "*", rules("iolaus-librarian"))).toBe("deny")
  expect(evaluate("gh", "*", rules("iolaus-explore"))).toBe("deny")
  expect(evaluate("gh", "*", rules("iolaus-oracle"))).toBe("deny")
  expect(parseOptions({ gh: false }).gh).toBe(false)
  expect(() => parseOptions({ gh: "yes" })).toThrow(/gh must be/)
})

test("inputs are validated before any process runs", async () => {
  const out = async (name: string, input: unknown) => (await byName(name).execute(input, ctx())).output as { ok: boolean; error?: { code: string; message: string } }
  expect((await out("repo", { repo: "not a repo" })).error?.code).toBe("INVALID_ARGUMENT")
  expect((await out("repo", { repo: "a/b; rm -rf /" })).error?.code).toBe("INVALID_ARGUMENT")
  expect((await out("clone", { repo: "facebook/react", ref: "main; echo" })).error?.message).toMatch(/ref/)
  expect((await out("log", { clone: "/etc" })).error?.message).toMatch(/gh\.clone/)
  expect((await out("log", { clone: tmpdir() })).error?.message).toMatch(/gh\.clone/)
  expect((await out("show", { clone: "/tmp/iolaus-gh-x", sha: "HEAD~1" })).error?.code).toBe("INVALID_ARGUMENT")
  expect((await out("blame", { clone: "/tmp/iolaus-gh-x", path: "../etc/passwd" })).error?.code).toBe("INVALID_ARGUMENT")
  expect((await out("issue", { repo: "a/b" })).error?.message).toMatch(/number/)
})

live("live: repo view, clone, log and show against a real public repository", async () => {
  const repo = (await byName("repo").execute({ repo: "cli/cli" }, ctx())).output as { ok: boolean; data?: { name: string; defaultBranchRef?: { name: string } } }
  expect(repo.ok).toBe(true)
  expect(repo.data?.name).toBe("cli")
  const clone = (await byName("clone").execute({ repo: "cli/cli", depth: 3 }, ctx())).output as { ok: boolean; path: string }
  expect(clone.ok).toBe(true)
  expect(clone.path.startsWith(join(tmpdir(), "iolaus-gh-")) || clone.path.includes("/iolaus-gh-")).toBe(true)
  expect(existsSync(join(clone.path, "README.md"))).toBe(true)
  const log = (await byName("log").execute({ clone: clone.path, count: 2 }, ctx())).output as { ok: boolean; commits: { sha: string; subject: string }[] }
  expect(log.ok).toBe(true)
  expect(log.commits.length).toBeGreaterThan(0)
  expect(log.commits[0].sha).toMatch(/^[0-9a-f]{40}$/)
  const show = (await byName("show").execute({ clone: clone.path, sha: log.commits[0].sha.slice(0, 8), stat: true }, ctx())).output as { ok: boolean; text: string }
  expect(show.ok).toBe(true)
  expect(show.text).toContain(log.commits[0].sha.slice(0, 8))
  const blame = (await byName("blame").execute({ clone: clone.path, path: "README.md", start: 1, end: 3 }, ctx())).output as { ok: boolean; text: string }
  expect(blame.ok).toBe(true)
  expect(blame.text.split("\n").filter(Boolean).length).toBe(3)
  rmSync(join(clone.path, ".."), { recursive: true, force: true })
}, 120_000)

live("live: gh error surfaces as a structured GH_ERROR without throwing", async () => {
  const out = (await byName("repo").execute({ repo: "iolaus-qa-nonexistent-owner-xyz/nope" }, ctx())).output as { ok: boolean; error?: { code: string } }
  expect(out.ok).toBe(false)
  expect(out.error?.code).toMatch(/GH_ERROR|GH_AUTH/)
})

test("fixture dir cleanup guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "iolaus-gh-test-"))
  rmSync(dir, { recursive: true, force: true })
  expect(existsSync(dir)).toBe(false)
})

test("librarian prompt references gh only through tools.gh.* (no shell commands)", async () => {
  const { buildLibrarianPrompt } = await import("../src/omo/agents/specialists/librarian-prompt")
  const prompt = buildLibrarianPrompt()
  expect(prompt).not.toMatch(/\bgh (repo clone|search|api|issue view|pr view)\b/)
  expect(prompt).not.toMatch(/\bgit (log|blame|rev-parse|show)\b/)
  for (const name of ["clone", "log", "blame", "show", "issues", "issue", "prs", "pr", "prDiff", "repo", "searchCode"]) expect(prompt).toContain(`tools.gh.${name}`)
})
