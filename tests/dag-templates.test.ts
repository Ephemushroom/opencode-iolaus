import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyDefaultModels, createDagController } from "../src/dag/controller"
import { validateDefinition } from "../src/dag/graph"
import { expandTemplate, REVIEW_VERDICT_FAIL, REVIEW_VERDICT_PASS } from "../src/dag/templates"
import { createDagTool } from "../src/dag/tool"
import type { DagRunner } from "../src/dag/runner"
import type { DagDefinition } from "../src/dag/types"

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

function lanes(agent: string): string | undefined {
  return ({ "iolaus-prometheus": "anthropic/claude-fable-5-1", "iolaus-momus": "openai/gpt-6-astra", "iolaus-sisyphus": "anthropic/claude-opus-5-5", "iolaus-hephaestus": "openai/gpt-6-sol" } as Record<string, string>)[agent]
}

/** Replies per node id; a reviewer's reply list is consumed in order across attempts. */
function scriptedRunner(replies: Record<string, string[]>): DagRunner & { readonly started: string[]; readonly prompts: Map<string, string> } {
  const started: string[] = []
  const prompts = new Map<string, string>()
  return {
    started, prompts,
    async start(input) { started.push(input.node.id); prompts.set(input.node.id, input.prompt); return { nodeID: input.node.id, attempt: input.attempt, sessionID: `s-${input.node.id}-${input.attempt}` } },
    async wait(ref) { const text = replies[ref.nodeID]?.shift() ?? `${ref.nodeID} done`; return { payload: { text } } },
    async cancel() {},
  }
}

test("plan-review template expands to a valid definition and rejects bad input", () => {
  const def = expandTemplate({ template: "plan-review", task: "Add rate limiting to the API" })
  validateDefinition(applyDefaultModels(def, lanes))
  expect(def.nodes.map((n) => n.id)).toEqual(["plan", "review", "revise", "rereview", "approve", "execute"])
  expect(def.nodes.find((n) => n.id === "plan")?.agent).toBe("iolaus-prometheus")
  expect(def.nodes.find((n) => n.id === "review")?.agent).toBe("iolaus-momus")
  expect(def.nodes.find((n) => n.id === "approve")?.kind).toBe("gate")
  expect(def.nodes.find((n) => n.id === "execute")?.dependsOn).toEqual(["approve"])
  const noGate = expandTemplate({ template: "plan-review", task: "x", gate: false, reviewer: "iolaus-metis", executor: "iolaus-hephaestus" })
  validateDefinition(applyDefaultModels(noGate, (a) => lanes(a) ?? "openai/gpt-5.5"))
  expect(noGate.nodes.map((n) => n.id)).not.toContain("approve")
  expect(noGate.nodes.find((n) => n.id === "execute")?.when).toBeDefined()
  const goal = expandTemplate({ template: "goal-review", task: "Make the tests green" })
  validateDefinition(applyDefaultModels(goal, lanes))
  expect(goal.nodes.map((n) => n.id)).toEqual(["work", "review", "fix", "rereview", "accept"])
  expect(goal.nodes.find((n) => n.id === "work")?.agent).toBe("iolaus-hephaestus")
  expect(() => expandTemplate({ template: "nope", task: "x" })).toThrow(/Unknown DAG template/)
  expect(() => expandTemplate({ template: "plan-review" })).toThrow(/task/)
  expect(() => expandTemplate({ template: "plan-review", task: "x", maxAttempts: 0 })).toThrow(/maxAttempts/)
  expect(() => expandTemplate({ template: "plan-review", task: "x", gate: "yes" })).toThrow(/gate/)
})

test("routing is fail-closed: a lane without a model is rejected as model_unavailable at create", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-tpl-"))
  const controller = createDagController({ directory, runner: scriptedRunner({}), defaultModel: (agent) => agent === "iolaus-sisyphus" ? "openai/gpt-5.5" : undefined })
  const def: DagDefinition = { schemaVersion: 1, name: "t", nodes: [
    { id: "a", agent: "iolaus-sisyphus", prompt: "a", dependsOn: [] },
    { id: "b", agent: "iolaus-unconfigured", prompt: "b", dependsOn: ["a"] },
    { id: "c", agent: "iolaus-other", model: "openai/gpt-5.5", prompt: "c", dependsOn: [] },
  ] }
  await expect(controller.create(def, "owner")).rejects.toThrow(/model_unavailable: no configured model for b \(iolaus-unconfigured\)/)
  expect(await controller.list("owner")).toEqual([])
  const tool = createDagTool(controller)
  const result = await tool.execute({ action: "create", template: { template: "plan-review", task: "x" } }, { sessionID: "owner" } as never)
  expect(JSON.parse(String(result.content)).error).toMatch(/model_unavailable.*plan \(iolaus-prometheus\)/)
  const expanded = await tool.execute({ action: "template", template: { template: "goal-review", task: "ship it" } }, { sessionID: "owner" } as never)
  expect(JSON.parse(String(expanded.content)).nodes.map((n: { id: string }) => n.id)).toEqual(["work", "review", "fix", "rereview", "accept"])
  controller.close()
})

test("plan-review run: reviewer fails once, planner revises, re-review passes, gate approves, executor runs", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-tpl-"))
  const runner = scriptedRunner({
    plan: ["PLAN v1"], review: [`Step 2 is unverifiable.\n${REVIEW_VERDICT_FAIL}`], revise: ["PLAN v2"], rereview: [`Good.\n${REVIEW_VERDICT_PASS}`], execute: ["shipped"],
  })
  const controller = createDagController({ directory, runner, defaultModel: lanes })
  const run = await controller.create(expandTemplate({ template: "plan-review", task: "Add rate limiting" }), "owner")
  // wait() resolves only on terminal runs; a paused run is observed through snapshot.
  let paused = (await controller.snapshot(run.runID, "owner")).run
  for (let i = 0; i < 50 && paused.status !== "paused"; i++) { await new Promise((r) => setTimeout(r, 20)); paused = (await controller.snapshot(run.runID, "owner")).run }
  expect(paused.status).toBe("paused")
  const status = (r: typeof paused) => Object.fromEntries(r.nodes.map((n) => [n.definition.id, n.status]))
  expect(status(paused)).toEqual({ plan: "completed", review: "completed", revise: "completed", rereview: "completed", approve: "waiting_approval", execute: "pending" })
  expect(runner.prompts.get("revise")).toContain("PLAN v1")
  expect(runner.prompts.get("revise")).toContain("Step 2 is unverifiable")
  expect(runner.prompts.get("rereview")).toContain("PLAN v2")
  await controller.approve(run.runID, "owner", "approve", "go")
  const finished = await controller.wait(run.runID, "owner")
  expect(finished.status).toBe("completed")
  expect(runner.started).toEqual(["plan", "review", "revise", "rereview", "execute"])
  expect(runner.prompts.get("execute")).toContain("PLAN v2")
  expect(finished.nodes.find((n) => n.definition.id === "plan")?.result?.provenance.model).toBe("anthropic/claude-fable-5-1")
  controller.close()
})

test("plan-review run: a passing first review skips revise and re-review", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-tpl-"))
  const runner = scriptedRunner({ review: [`Fine.\n${REVIEW_VERDICT_PASS}`] })
  const controller = createDagController({ directory, runner, defaultModel: lanes })
  const run = await controller.create(expandTemplate({ template: "plan-review", task: "t", gate: false }), "owner")
  const finished = await controller.wait(run.runID, "owner")
  expect(finished.status).toBe("completed")
  expect(Object.fromEntries(finished.nodes.map((n) => [n.definition.id, n.status]))).toEqual({ plan: "completed", review: "completed", revise: "skipped", rereview: "skipped", execute: "completed" })
  expect(runner.started).toEqual(["plan", "review", "execute"])
  controller.close()
})

test("goal-review run: two failed reviews leave the run without an accepted result", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-tpl-"))
  const runner = scriptedRunner({ review: [`Nope.\n${REVIEW_VERDICT_FAIL}`], rereview: [`Still no.\n${REVIEW_VERDICT_FAIL}`] })
  const controller = createDagController({ directory, runner, defaultModel: lanes })
  const run = await controller.create(expandTemplate({ template: "goal-review", task: "t" }), "owner")
  const finished = await controller.wait(run.runID, "owner")
  expect(finished.status).toBe("completed")
  expect(Object.fromEntries(finished.nodes.map((n) => [n.definition.id, n.status]))).toEqual({ work: "completed", review: "completed", fix: "completed", rereview: "completed", accept: "skipped" })
  expect(runner.started).toEqual(["work", "review", "fix", "rereview"])
  controller.close()
})
