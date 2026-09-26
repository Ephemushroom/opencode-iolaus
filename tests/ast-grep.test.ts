import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "@opencode/plugin"
import { Effect } from "effect"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { resolveAstGrepBinary } from "../src/ast-grep/binary"
import { blockedResources, evaluate, wildcardMatch, type PermissionRule } from "../src/ast-grep/permissions"
import { AST_GREP_NAMESPACE, createAstGrepTools } from "../src/ast-grep/tools"
import { parseOptions } from "../src/options"
import { registerAgents } from "../src/registration"
import { agentID } from "../src/prompts/catalog"

const sgPath = resolveAstGrepBinary()
const withSg = test.skipIf(sgPath === undefined)
let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

const ALLOW_ALL: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }]
const PLANNER: PermissionRule[] = [
  ...ALLOW_ALL,
  { action: "edit", resource: "*", effect: "deny" },
  { action: "edit", resource: ".iolaus/plans/*", effect: "allow" },
]

function project(): string {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-ast-grep-")))
  mkdirSync(join(directory, "src"))
  mkdirSync(join(directory, ".iolaus", "plans"), { recursive: true })
  writeFileSync(join(directory, "src", "a.ts"), "console.log(add(1, 2))\nconsole.log(\"héllo\")\nconst x = 1\n")
  writeFileSync(join(directory, ".iolaus", "plans", "p.ts"), "console.log(plan)\n")
  return directory
}

function tools(root: string, rules: readonly PermissionRule[]) {
  const calls: Record<string, unknown>[] = []
  const list = createAstGrepTools(sgPath ?? "ast-grep", { directory: async () => root, rules: async () => rules, trace: (_event, data) => calls.push(data) })
  const byName = Object.fromEntries(list.map((tool) => [tool.name, tool]))
  const context = { sessionID: "ses_test", agent: "iolaus-test", messageID: "msg", id: "call", signal: new AbortController().signal, progress: async () => {} }
  const call = async (name: string, input: Record<string, unknown>) => ((await byName[name]!.execute(input as never, context as never)) as { output: Record<string, any> }).output
  return { list, call, calls }
}

test("permission evaluation mirrors the host: last match wins, no match asks, trailing ' *' is optional", () => {
  expect(wildcardMatch(".iolaus/plans/p.ts", ".iolaus/plans/*")).toBe(true)
  expect(wildcardMatch("src/a.ts", ".iolaus/plans/*")).toBe(false)
  expect(wildcardMatch("git", "git *")).toBe(true)
  expect(wildcardMatch("src\\a.ts", "src/*")).toBe(true)
  expect(evaluate("edit", "src/a.ts", PLANNER)).toBe("deny")
  expect(evaluate("edit", ".iolaus/plans/p.ts", PLANNER)).toBe("allow")
  expect(evaluate("edit", "src/a.ts", [])).toBe("ask")
  expect(blockedResources("edit", ["src/a.ts", ".iolaus/plans/p.ts"], PLANNER)).toEqual(["src/a.ts"])
  expect(blockedResources("edit", ["x"], [{ action: "edit", resource: "*", effect: "ask" }])).toEqual(["x"])
})

test("tools register in the ast_grep namespace; search is pinned and read-scoped, rewrite needs edit", () => {
  const { list } = tools("/tmp", ALLOW_ALL)
  const options = Object.fromEntries(list.map((tool) => [tool.name, tool.options]))
  expect(Object.keys(options).sort()).toEqual(["rewrite", "scan", "search"])
  for (const option of Object.values(options)) expect(option?.namespace).toBe(AST_GREP_NAMESPACE)
  expect(options.search).toEqual({ namespace: AST_GREP_NAMESPACE, pinned: true, permission: "grep" })
  expect(options.rewrite).toEqual({ namespace: AST_GREP_NAMESPACE, pinned: true, permission: "edit" })
  expect(options.scan?.permission).toBe("grep")
  for (const tool of list) expect((tool.output as { required?: string[] }).required).toEqual(["ok"])
})

withSg("search returns structured, session-relative matches with metavariables", async () => {
  const root = project()
  const { call, calls } = tools(root, ALLOW_ALL)
  const result = await call("search", { pattern: "console.log($A)", language: "typescript", paths: ["src"] })
  expect(result.ok).toBe(true)
  expect(result.workdir).toBe(root)
  expect(result.matches.map((m: any) => [m.path, m.range.start.line, m.metavariables.single.A])).toEqual([["src/a.ts", 1, "add(1, 2)"], ["src/a.ts", 2, "\"héllo\""]])
  expect(result.counts.totalMatches).toBe(2)
  const limited = await call("search", { pattern: "console.log($A)", language: "typescript", paths: ["src"], maxMatches: 1 })
  expect(limited.truncation).toMatchObject({ truncated: true, reason: "match_limit" })
  expect(limited.counts.totalMatches).toBeNull()
  expect(calls.at(-1)).toMatchObject({ tool: "search", ok: true, truncated: true })
})

withSg("search rejects regex-shaped patterns before spawning and reports schema errors as payloads", async () => {
  const root = project()
  const { call } = tools(root, ALLOW_ALL)
  const hinted = await call("search", { pattern: "console\\.log\\(.*\\)", language: "typescript", paths: ["src"] })
  expect(hinted.ok).toBe(false)
  expect(hinted.error.code).toBe("PATTERN_HINT_REJECTED")
  expect(hinted.error.phase).toBe("preflight")
  const schema = await call("search", { pattern: "x", language: "cobol", paths: ["src"] })
  expect(schema).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } })
})

withSg("workdir is fixed and paths outside the session need an external_directory allow", async () => {
  const root = project()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-ast-grep-outside-")))
  writeFileSync(join(outside, "b.ts"), "console.log(1)\n")
  try {
    const denied = tools(root, [...ALLOW_ALL, { action: "external_directory", resource: "*", effect: "ask" }])
    expect(await denied.call("search", { pattern: "console.log($A)", language: "typescript", paths: ["src"], workdir: "/" })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } })
    const blocked = await denied.call("search", { pattern: "console.log($A)", language: "typescript", paths: [outside] })
    expect(blocked.ok).toBe(false)
    expect(blocked.error.message).toContain("external_directory")
    const allowed = tools(root, [...ALLOW_ALL, { action: "external_directory", resource: "*", effect: "ask" }, { action: "external_directory", resource: `${outside}*`, effect: "allow" }])
    const hit = await allowed.call("search", { pattern: "console.log($A)", language: "typescript", paths: [outside] })
    expect(hit.ok).toBe(true)
    expect(hit.matches).toHaveLength(1)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

withSg("rewrite is a dry run by default and applies only with edit permission on every planned file", async () => {
  const root = project()
  const file = join(root, "src", "a.ts")
  const before = readFileSync(file, "utf8")
  const writer = tools(root, ALLOW_ALL)
  const preview = await writer.call("rewrite", { pattern: "console.log($A)", rewrite: "logger.info($A)", language: "typescript", paths: ["src"] })
  expect(preview).toMatchObject({ ok: true, applied: false, counts: { plannedMatches: 2, plannedFiles: 1 } })
  expect(preview.matches[0].replacement).toBe("logger.info(add(1, 2))")
  expect(readFileSync(file, "utf8")).toBe(before)

  const planner = tools(root, PLANNER)
  const denied = await planner.call("rewrite", { pattern: "console.log($A)", rewrite: "logger.info($A)", language: "typescript", paths: ["src", ".iolaus"], apply: true })
  expect(denied).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED", phase: "apply" } })
  expect(denied.error.message).toContain("src/a.ts")
  expect(readFileSync(file, "utf8")).toBe(before)
  expect(readFileSync(join(root, ".iolaus", "plans", "p.ts"), "utf8")).toBe("console.log(plan)\n")
  const plans = await planner.call("rewrite", { pattern: "console.log($A)", rewrite: "logger.info($A)", language: "typescript", paths: [".iolaus/plans"], apply: true, includeHidden: true })
  expect(plans).toMatchObject({ ok: true, applied: true })
  expect(readFileSync(join(root, ".iolaus", "plans", "p.ts"), "utf8")).toBe("logger.info(plan)\n")

  const applied = await writer.call("rewrite", { pattern: "console.log($A)", rewrite: "logger.info($A)", language: "typescript", paths: ["src"], apply: true })
  expect(applied).toMatchObject({ ok: true, applied: true })
  expect(readFileSync(file, "utf8")).toBe("logger.info(add(1, 2))\nlogger.info(\"héllo\")\nconst x = 1\n")
})

withSg("rewrite rejects replacements that reference unbound metavariables", async () => {
  const root = project()
  const result = await tools(root, ALLOW_ALL).call("rewrite", { pattern: "console.log($A)", rewrite: "logger.info($B)", language: "typescript", paths: ["src"], apply: true })
  expect(result).toMatchObject({ ok: false, error: { code: "REWRITE_UNBOUND_METAVARIABLE" } })
})

withSg("scan previews inline rules and its apply pass is gated by edit permission", async () => {
  const root = project()
  const rule = "id: no-console\nlanguage: typescript\nrule:\n  pattern: console.log($A)\nfix: logger.info($A)\n"
  const preview = await tools(root, PLANNER).call("scan", { inlineRules: rule, paths: ["src"] })
  expect(preview).toMatchObject({ ok: true, applied: false, counts: { plannedMatches: 2 } })
  expect(preview.matches[0].rule.ruleId).toBe("no-console")
  const denied = await tools(root, PLANNER).call("scan", { inlineRules: rule, paths: ["src"], apply: true })
  expect(denied).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
  expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("console.log")
})

test("binary resolution requires a candidate that answers --version as ast-grep", () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-ast-grep-bin-"))
  const fake = join(directory, "ast-grep")
  writeFileSync(fake, "#!/bin/sh\necho not-it 1.0\n")
  chmodSync(fake, 0o755)
  expect(resolveAstGrepBinary({ env: { IOLAUS_AST_GREP_BIN: fake } })).toBeUndefined()
  expect(resolveAstGrepBinary({ env: { PATH: directory }, directories: [directory] })).toBeUndefined()
  expect(resolveAstGrepBinary({ env: { IOLAUS_AST_GREP_BIN: join(directory, "missing") } })).toBeUndefined()
  if (sgPath) expect(resolveAstGrepBinary({ env: { IOLAUS_AST_GREP_BIN: sgPath } })).toBe(sgPath)
})

test("astGrep option is a boolean and read-only specialists may reach Code Mode", async () => {
  expect(parseOptions({}).astGrep).toBe(true)
  expect(parseOptions({ astGrep: false }).astGrep).toBe(false)
  expect(() => parseOptions({ astGrep: "no" })).toThrow()
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: (id) => agents.get(id), default: () => undefined, remove: (id) => { agents.delete(id) },
    update: (id, update) => { const value = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id)); update(value); agents.set(id, value) },
  }
  await Effect.runPromise(Effect.scoped(registerAgents({ agent: { transform: (run) => Effect.sync(() => { run(editor); return { dispose: Effect.void } }) } }, parseOptions({}))))
  const explore = agents.get(agentID("explore"))!.permissions as PermissionRule[]
  expect(evaluate("execute", "*", explore)).toBe("allow")
  expect(evaluate("grep", "*", explore)).toBe("allow")
  expect(evaluate("edit", "*", explore)).toBe("deny")
  expect(evaluate("shell", "*", explore)).toBe("deny")
})
