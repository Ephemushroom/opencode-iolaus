import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Agent } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { loadPlan, resolvePlan, PLANNING_MARKER, ticketMarker } from "../src/roles/plan"
import { compilePlan } from "../src/roles/startwork"
import { denial, inheritPlanning, resolvePolicy } from "../src/roles/guard"
import { parseCommand, COMMAND_OWNERS } from "../src/roles/command"
import { createGoalRuntime, extendGoal, readGoal, saveGoal, setGoal, GOAL_MAX_CONTINUATIONS, GOAL_STAGNATION_LIMIT, GOAL_TOOL_NAMES, type Goal } from "../src/roles/goal"
import { isGoalSessionInfo } from "../src/roles/register"
import { validateDefinition } from "../src/dag/graph"
import { applyDefaultModels } from "../src/dag/controller"
import { REVIEW_VERDICT_FAIL } from "../src/dag/templates"
import { registerAgents } from "../src/registration"
import { parseOptions } from "../src/options"
import { evaluate } from "../src/ast-grep/permissions"
import { renderAgent } from "../src/prompts/render"
import { buildDynamicHephaestusPrompt } from "../src/omo/agents"
import { SessionStateStore } from "../src/database"
import { readRole, saveRole } from "../src/roles/register"

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

function project(tickets: Record<string, string>, spec = "# Spec\nProblem and solution.\n"): string {
  directory = mkdtempSync(join(tmpdir(), "iolaus-roles-"))
  const root = join(directory, ".iolaus/plans/cache/tickets")
  mkdirSync(root, { recursive: true })
  if (spec) writeFileSync(join(directory, ".iolaus/plans/cache/spec.md"), spec)
  for (const [file, text] of Object.entries(tickets)) writeFileSync(join(root, file), text)
  return directory
}

const ticket = (n: string, blocked: string) => `# ${n}: Slice ${n}\n\n**Blocked by:** ${blocked}\n\n- [ ] works\n`

test("plans load with blocking edges and reject missing lines, unknown blockers and cycles", () => {
  const dir = project({ "01-schema.md": ticket("01", "None"), "02-api.md": ticket("02", "01"), "03-ui.md": ticket("03", "01, 02") })
  const result = loadPlan(dir, "cache")
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.plan.tickets.map((t) => [t.id, t.blockedBy])).toEqual([["01", []], ["02", ["01"]], ["03", ["01", "02"]]])
  expect(resolvePlan(dir, "").ok).toBe(true)
  rmSync(dir, { recursive: true, force: true })

  const bad = project({ "01-a.md": "# 01: a\nno line\n", "02-b.md": ticket("02", "07"), "03-c.md": ticket("03", "04"), "04-d.md": ticket("04", "03") }, "")
  const failed = loadPlan(bad, "cache")
  expect(failed.ok).toBe(false)
  if (failed.ok) return
  expect(failed.errors.join("\n")).toMatch(/spec\.md is missing/)
  expect(failed.errors.join("\n")).toMatch(/01-a\.md: missing the "\*\*Blocked by:\*\*" line/)
  expect(failed.errors.join("\n")).toMatch(/blocked by unknown ticket 07/)
  expect(failed.errors.join("\n")).toMatch(/form a cycle/)
  expect(loadPlan(bad, "../etc").ok).toBe(false)
  expect(resolvePlan(bad, "").ok).toBe(false)
})

test("start-work compiles tickets to fresh Atlas nodes, two review axes, a conditional fix and an accept gate", () => {
  const dir = project({ "01-schema.md": ticket("01", "None"), "02-api.md": ticket("02", "01") })
  const result = loadPlan(dir, "cache")
  if (!result.ok) throw new Error(result.errors.join())
  const def = compilePlan(result.plan, "abc123")
  validateDefinition(applyDefaultModels(def, () => "openai/gpt-5.5"))
  expect(def.maxParallel).toBe(1)
  expect(def.nodes.map((n) => n.id)).toEqual(["t01", "t02", "review-standards", "review-spec", "fix", "accept"])
  expect(def.nodes.find((n) => n.id === "t02")?.dependsOn).toEqual(["t01"])
  expect(def.nodes.filter((n) => n.id.startsWith("t")).every((n) => n.agent === "atlas" && n.prompt.startsWith(ticketMarker("cache", n.id.slice(1))))).toBe(true)
  expect(def.nodes.find((n) => n.id === "review-spec")?.dependsOn).toEqual(["t01", "t02"])
  expect(def.nodes.find((n) => n.id === "fix")?.when).toEqual({ any: [{ node: "review-standards", field: "text", includes: REVIEW_VERDICT_FAIL }, { node: "review-spec", field: "text", includes: REVIEW_VERDICT_FAIL }] })
  expect(def.nodes.find((n) => n.id === "accept")?.kind).toBe("gate")
})

test("role policy: planner writes only plan and domain docs, Atlas needs a plan, workers are unrestricted", () => {
  const dir = "/p"
  const edit = (path: string) => ({ filePath: path, oldString: "a", newString: "b" })
  expect(denial("planner", "edit", edit(".iolaus/plans/x/spec.md"), dir)).toBeUndefined()
  for (const path of ["CONTEXT.md", "docs/adr/0001-x.md", "src/ordering/CONTEXT.md"]) expect(denial("planner", "write", edit(path), dir)).toBeUndefined()
  expect(denial("planner", "edit", edit("src/a.ts"), dir)).toMatch(/read-only/)
  expect(denial("planner", "edit", edit("../outside/.iolaus/plans/x.md"), dir)).toMatch(/read-only/)
  expect(denial("planner", "patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch" }, dir)).toMatch(/src\/a\.ts/)
  expect(denial("planner", "shell", { command: "ls" }, dir)).toMatch(/no shell/)
  expect(denial("planner", "iolaus_dag", { action: "create", template: { template: "ultrawork", task: "x" } }, dir)).toMatch(/only planning runs/)
  expect(denial("planner", "iolaus_dag", { action: "create", template: { template: "hyperplan", task: "x" } }, dir)).toBeUndefined()
  expect(denial("planner", "iolaus_dag", { action: "wait", run_id: "r" }, dir)).toBeUndefined()
  expect(denial("planner", "ast_grep_rewrite", { apply: true }, dir)).toBeUndefined()
  expect(denial("planning", "ast_grep_rewrite", { apply: true }, dir)).toMatch(/codemods/)
  for (const [tool, input] of [["edit", edit("src/a.ts")], ["shell", {}], ["subagent", { prompt: "x" }], ["iolaus_dag", { action: "create" }]] as const) {
    expect(denial("atlas-unbound", tool, input, dir)).toMatch(/\/start-work/)
    expect(denial("atlas-orchestrator", tool, input, dir)).toMatch(/orchestrates/)
  }
  expect(denial("atlas-unbound", "read", { path: "a" }, dir)).toBeUndefined()
  expect(denial("atlas-orchestrator", "iolaus_dag", { action: "wait", run_id: "r" }, dir)).toBeUndefined()
  expect(denial("worker", "edit", edit(".iolaus/plans/x/spec.md"), dir)).toBeUndefined()
  expect(denial("worker", "edit", edit("src/a.ts"), dir)).toBeUndefined()
  expect(denial("native", "edit", edit(".iolaus/plans/x/spec.md"), dir)).toBeUndefined()

  expect(resolvePolicy("prometheus", undefined, false)).toBe("planner")
  expect(resolvePolicy("sisyphus", { role: "planning" }, false)).toBe("planning")
  expect(resolvePolicy("atlas", undefined, false)).toBe("atlas-unbound")
  expect(resolvePolicy("atlas", { role: "ticket", plan: "p" }, false)).toBe("atlas-unbound")
  expect(resolvePolicy("atlas", { role: "ticket", plan: "p" }, true)).toBe("worker")
  expect(resolvePolicy("atlas", { role: "orchestrator", plan: "p", runID: "r" }, true)).toBe("atlas-orchestrator")
  expect(resolvePolicy("hephaestus", undefined, false)).toBe("worker")
})

test("a planner's subagents and DAG nodes inherit the planning notice; gates and judges do not", () => {
  const sub = { agent: "explore", prompt: "look" }
  expect(inheritPlanning("subagent", sub)).toBe(true)
  expect(sub.prompt.endsWith(PLANNING_MARKER + "\nThis session consults for a planning run and is read-only: Iolaus blocks file edits and shell here. Report findings and recommendations; do not implement.")).toBe(true)
  inheritPlanning("subagent", sub)
  expect(sub.prompt.split(PLANNING_MARKER).length).toBe(2)
  const dag: Record<string, unknown> = { action: "create", template: { template: "hyperplan", task: "t", members: ["ultrabrain", "artistry"] } }
  expect(inheritPlanning("iolaus_dag", dag)).toBe(true)
  expect(dag.template).toBeUndefined()
  const nodes = (dag.definition as { nodes: { id: string; kind?: string; prompt: string }[] }).nodes
  expect(nodes.filter((n) => n.kind !== "gate" && n.kind !== "judge").every((n) => n.prompt.includes(PLANNING_MARKER))).toBe(true)
  expect(nodes.find((n) => n.kind === "gate")?.prompt.includes(PLANNING_MARKER)).toBe(false)
  expect(inheritPlanning("iolaus_dag", { action: "wait", run_id: "r" })).toBe(false)
})

test("commands parse from markers and slash text, and each role command has an owner", () => {
  expect(parseCommand("/start-work cache")).toEqual({ name: "start-work", args: "cache" })
  expect(parseCommand('"/goal make tests green"')).toEqual({ name: "goal", args: "make tests green" })
  expect(parseCommand("<iolaus-command:goal>\nship it")).toEqual({ name: "goal", args: "ship it" })
  expect(parseCommand("<iolaus-mode:hyperplan>\nplan x")).toEqual({ name: "hyperplan", args: "plan x" })
  expect(parseCommand("/goals now")).toBeUndefined()
  expect(parseCommand("please /goal x")).toBeUndefined()
  expect(parseCommand("<iolaus-command:nope>\nx")).toBeUndefined()
  expect(COMMAND_OWNERS).toEqual({ ultrawork: "sisyphus", hyperplan: "prometheus", goal: "hephaestus", "start-work": "atlas" })
})

test("goal loop continues an idle active goal, stops on completion, stagnation and the continuation cap", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-goal-"))
  const dir = new SessionStateStore(join(directory, "iolaus.db"))
  const dispatched: string[] = []
  const runtime = createGoalRuntime({
    read: (s) => readGoal(dir, s), save: (g) => saveGoal(dir, g),
    isGoalSession: async (s) => s !== "child", dispatch: async (s) => { dispatched.push(s) }, settle: async () => {},
  })
  const turn = async (sessionID: string, toolCalls: number) => {
    await runtime.handle({ type: "session.execution.started", data: { sessionID } })
    for (let i = 0; i < toolCalls; i++) runtime.toolCalled(sessionID)
    await runtime.handle({ type: "session.execution.succeeded", data: { sessionID } })
  }
  setGoal(dir, "s", "make tests green")
  await turn("s", 2)
  expect(dispatched).toEqual(["s"])
  expect(readGoal(dir, "s")?.continuations).toBe(1)
  // A late idle edge from the same turn does not dispatch twice.
  await runtime.handle({ type: "session.idle", data: { sessionID: "s" } })
  expect(dispatched).toEqual(["s"])
  saveGoal(dir, { ...readGoal(dir, "s")!, status: "complete" })
  await turn("s", 1)
  expect(dispatched).toEqual(["s"])

  setGoal(dir, "idle", "x")
  for (let i = 0; i < GOAL_STAGNATION_LIMIT + 1; i++) await turn("idle", 0)
  expect(readGoal(dir, "idle")?.status).toBe("paused")
  expect(readGoal(dir, "idle")?.reason).toBe("stagnated")
  expect(dispatched.filter((s) => s === "idle").length).toBe(GOAL_STAGNATION_LIMIT - 1)

  saveGoal(dir, { ...setGoal(dir, "cap", "x"), continuations: GOAL_MAX_CONTINUATIONS } as Goal)
  await turn("cap", 1)
  expect(readGoal(dir, "cap")?.reason).toBe("continuation limit")

  setGoal(dir, "child", "x")
  await turn("child", 1)
  expect(dispatched.includes("child")).toBe(false)

  expect(extendGoal(dir, "idle", "also docs").objective).toContain("Update from the user: also docs")
  expect(readGoal(dir, "idle")?.status).toBe("active")
  expect(extendGoal(dir, "s", "new task").objective).toBe("new task")
  dir.close()
})

test("roles and goals round-trip in one database without project JSON files", () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-state-"))
  const path = join(directory, "iolaus.db")
  const first = new SessionStateStore(path)
  saveRole(first, "ses_role", { role: "orchestrator", plan: "p", runID: "r" })
  setGoal(first, "ses_goal", "finish")
  first.close()
  const second = new SessionStateStore(path)
  expect(readRole(second, "ses_role")).toEqual({ role: "orchestrator", plan: "p", runID: "r" })
  expect(readGoal(second, "ses_goal")?.objective).toBe("finish")
  second.save("role", "invalid", { role: "unknown" })
  second.save("goal", "invalid", { status: "unknown", objective: "x" })
  expect(readRole(second, "invalid")).toBeUndefined()
  expect(readGoal(second, "invalid")).toBeNull()
  second.save("role", "empty", null)
  second.save("goal", "empty", null)
  expect(readRole(second, "empty")).toBeUndefined()
  expect(readGoal(second, "empty")).toBeNull()
  second.close()
})

test("only top-level Hephaestus sessions loop", () => {
  expect(isGoalSessionInfo({ agent: "hephaestus" })).toBe(true)
  expect(isGoalSessionInfo({ agent: "hephaestus", parentID: "ses_p" })).toBe(false)
  expect(isGoalSessionInfo({ agent: "hephaestus", metadata: { iolaus_dag_node: "work" } })).toBe(false)
  expect(isGoalSessionInfo({ agent: "sisyphus" })).toBe(false)
})

test("goal tools are hidden from every Iolaus lane but Hephaestus; Prometheus may edit plan and domain docs", async () => {
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: (id) => agents.get(id), default: () => {}, remove: (id) => { agents.delete(id) },
    update: (id, update) => { const value = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id)); update(value); agents.set(id, value) },
  }
  const ctx = { agent: { transform: (run: (editor: AgentEditor) => void) => Effect.sync(() => { run(editor); return { dispose: Effect.void } }) } }
  await Effect.runPromise(Effect.scoped(registerAgents(ctx, parseOptions({}))))
  const allow = (id: string, action: string, resource = "*") => evaluate(action, resource, agents.get(id)!.permissions)
  for (const tool of GOAL_TOOL_NAMES) {
    expect(allow("hephaestus", tool)).toBe("allow")
    for (const id of ["sisyphus", "atlas", "prometheus", "oracle", "quick"]) expect(allow(id, tool)).toBe("deny")
  }
  expect(allow("prometheus", "edit", "docs/adr/0001-x.md")).toBe("allow")
  expect(allow("prometheus", "edit", "CONTEXT.md")).toBe("allow")
  expect(allow("prometheus", "edit", "src/a.ts")).toBe("deny")
})

test("Hephaestus renders on any model: GPT variants for GPT, the generic GPT body otherwise", () => {
  expect(renderAgent("hephaestus", { model: "openai/gpt-5.5" })).toBe(buildDynamicHephaestusPrompt({ model: "openai/gpt-5.5", availableAgents: [], availableSkills: [], availableTools: [], availableCategories: [] }))
  const claude = renderAgent("hephaestus", { model: "anthropic/claude-opus-5-5" })
  expect(claude).toBe(renderAgent("hephaestus", { model: "zai/glm-5.2" }))
  expect(claude).not.toBe(renderAgent("sisyphus-junior", { model: "anthropic/claude-opus-5-5" }))
})
