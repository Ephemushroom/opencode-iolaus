import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDagController as createEffectController, resolveInputs } from "../src/dag/controller"
import { promiseController } from "../src/dag/promise"
import { runnerFromPromise, type DagRunnerPromise } from "../src/dag/runner"
import { evaluateCondition, selectField } from "../src/dag/condition"
import { canonicalJson } from "../src/dag/canonical-json"
import { fingerprint, graphFingerprint } from "../src/dag/fingerprint"
import { DagValidationError, validateDefinition } from "../src/dag/graph"
import type { DagDefinition, DagExecutionRef, DagNodeDefinition } from "../src/dag/types"

let directory: string | undefined

type ControllerOptions = Omit<Parameters<typeof createEffectController>[0], "runner"> & { readonly runner: DagRunnerPromise }
function createDagController(options: ControllerOptions) {
  return promiseController(createEffectController({ ...options, runner: runnerFromPromise(options.runner) }))
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function node(id: string, dependsOn: readonly string[] = []): DagNodeDefinition {
  return { id, agent: "sisyphus", model: "openai/gpt-5.5", prompt: `run ${id}`, dependsOn }
}

function definition(nodes: readonly DagNodeDefinition[]): DagDefinition {
  return { schemaVersion: 1, name: "test", nodes, maxParallel: 2 }
}

function fakeRunner(failures = new Set<string>()): DagRunnerPromise & { readonly started: string[] } {
  const started: string[] = []
  return {
    started,
    async start(input) {
      started.push(input.node.id)
      return { nodeID: input.node.id, attempt: input.attempt, sessionID: `session-${input.node.id}-${input.attempt}` }
    },
    async wait(ref: DagExecutionRef) {
      if (failures.has(ref.nodeID)) throw new Error(`failed ${ref.nodeID}`)
      return { payload: { node: ref.nodeID, attempt: ref.attempt } }
    },
    async cancel() {},
  }
}

test("canonical JSON and graph fingerprints are stable across object ordering", () => {
  expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  const left = definition([node("a"), node("b", ["a"])])
  const right = definition([node("b", ["a"]), node("a")])
  expect(graphFingerprint(left)).toBe(graphFingerprint(right))
  expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }))
})

test("graph validation rejects cycles and unknown dependencies", () => {
  expect(() => validateDefinition(definition([node("a", ["b"]), node("b", ["a"])]))).toThrow(DagValidationError)
  expect(() => validateDefinition(definition([node("a", ["missing"])]))).toThrow("Unknown dependency")
})

test("dependency frontier starts independent roots and then unlocks descendants", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-test-"))
  const runner = fakeRunner()
  const controller = createDagController({ directory, runner })
  const run = await controller.create(definition([node("a"), node("b"), node("c", ["a"])]), "caller")
  const completed = await controller.wait(run.runID, "caller")
  expect(completed.status).toBe("completed")
  expect(runner.started).toEqual(["a", "b", "c"])
  controller.close()
})

test("failed nodes are retried by generation without rerunning completed nodes", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-test-"))
  const failures = new Set(["b"])
  const runner = fakeRunner(failures)
  const controller = createDagController({ directory, runner })
  const run = await controller.create(definition([node("a"), { ...node("b"), maxAttempts: 1 }]), "caller")
  const failed = await controller.wait(run.runID, "caller")
  expect(failed.status).toBe("failed")
  failures.clear()
  const retried = await controller.retry(run.runID, "caller")
  const completed = await controller.wait(retried.runID, "caller")
  expect(completed.status).toBe("completed")
  expect(runner.started.filter((id) => id === "a")).toHaveLength(1)
  expect(runner.started.filter((id) => id === "b")).toHaveLength(2)
  controller.close()
})

test("completed DAG state survives controller restart through SQLite WAL", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-test-"))
  const first = createDagController({ directory, runner: fakeRunner() })
  const run = await first.create(definition([node("a")]), "caller")
  await first.wait(run.runID, "caller")
  first.close()

  const second = createDagController({ directory, runner: fakeRunner() })
  const restored = await second.snapshot(run.runID, "caller")
  expect(restored.run.status).toBe("completed")
  expect(restored.run.nodes[0]?.result?.payload).toEqual({ node: "a", attempt: 1 })
  expect(restored.events.some((event) => event.type === "node.completed")).toBe(true)
  second.close()
})

test("fan-in binding expands to every dependency and carries producer provenance", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-test-"))
  const prompts = new Map<string, string>()
  const runner = fakeRunner()
  const start = runner.start.bind(runner)
  runner.start = async (input) => { prompts.set(input.node.id, input.prompt); return start(input) }
  const controller = createDagController({ directory, runner })
  const b = { ...node("b"), agent: "hephaestus", model: "anthropic/claude-opus-5-5" }
  const merge: DagNodeDefinition = { ...node("merge", ["a", "b"]), inputs: [{ node: "*" }] }
  const run = await controller.create(definition([node("a"), b, merge]), "owner")
  const finished = await controller.wait(run.runID, "owner")
  expect(finished.status).toBe("completed")
  expect(prompts.get("a")).toBe("run a")
  const prompt = prompts.get("merge")!
  const inputs = JSON.parse(prompt.slice(prompt.indexOf("<iolaus-dag-inputs>") + "<iolaus-dag-inputs>".length, prompt.indexOf("</iolaus-dag-inputs>")))
  expect(inputs).toEqual([
    { node: "a", field: "payload", value: { node: "a", attempt: 1 }, provenance: { agent: "sisyphus", model: "openai/gpt-5.5", attempt: 1, status: "completed", sessionID: "session-a-1" } },
    { node: "b", field: "payload", value: { node: "b", attempt: 1 }, provenance: { agent: "hephaestus", model: "anthropic/claude-opus-5-5", attempt: 1, status: "completed", sessionID: "session-b-1" } },
  ])
  const record = await controller.node(run.runID, "owner", "b")
  expect(record.result?.provenance.agent).toBe("hephaestus")
  expect(record.result?.provenance.execution?.sessionID).toBe("session-b-1")
  await expect(controller.node(run.runID, "other", "b")).rejects.toThrow("another session")
  await expect(controller.node(run.runID, "owner", "zzz")).rejects.toThrow("Unknown DAG node")
  controller.close()
})

test("field binding selects one payload key and fan-in requires dependencies", () => {
  const run = {
    nodes: [{ definition: node("a"), result: { payload: { text: "hello", score: 3 }, attempt: 2, status: "completed", provenance: { agent: "x", model: "p/m" } } }],
  } as unknown as Parameters<typeof resolveInputs>[1]
  const target = { definition: { ...node("z", ["a"]), inputs: [{ node: "a", field: "text" }, { node: "*", field: "score" }] } } as unknown as Parameters<typeof resolveInputs>[0]
  expect(resolveInputs(target, run).map((input) => [input.node, input.field, input.value, input.provenance?.sessionID])).toEqual([
    ["a", "text", "hello", null], ["a", "score", 3, null],
  ])
  expect(() => validateDefinition(definition([{ ...node("solo"), inputs: [{ node: "*" }] }]))).toThrow('Fan-in binding "*" requires dependsOn')
  expect(() => validateDefinition(definition([node("a"), { ...node("z", ["a"]), inputs: [{ node: "*" }] }]))).not.toThrow()
})

test("condition evaluation selects dotted fields and composes all/any/not", () => {
  const source = new Map<string, import("../src/dag/types").JsonValue | null>([
    ["review", { text: "Verdict: PASS", score: 9, nested: { tags: ["a", "b"] } }],
    ["skipped", null],
  ])
  expect(selectField(source.get("review")!, "nested.tags.1")).toBe("b")
  expect(selectField(source.get("review")!, "missing.path")).toBeNull()
  expect(evaluateCondition({ node: "review", field: "text", includes: "PASS" }, source)).toBe(true)
  expect(evaluateCondition({ node: "review", field: "text", matches: "^Verdict: (PASS|FAIL)$" }, source)).toBe(true)
  expect(evaluateCondition({ node: "review", field: "score", equals: 9 }, source)).toBe(true)
  expect(evaluateCondition({ node: "review", field: "score", equals: "9" }, source)).toBe(false)
  expect(evaluateCondition({ node: "skipped", exists: true }, source)).toBe(false)
  expect(evaluateCondition({ node: "skipped", exists: false }, source)).toBe(true)
  expect(evaluateCondition({ all: [{ node: "review", field: "text", includes: "PASS" }, { not: { node: "skipped", exists: true } }] }, source)).toBe(true)
  expect(evaluateCondition({ any: [{ node: "review", field: "text", includes: "FAIL" }, { node: "review", field: "score", equals: 9 }] }, source)).toBe(true)
})

test("conditional routing skips the false branch, runs the true branch and keeps dependents unblocked", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-test-"))
  const prompts = new Map<string, string>()
  const runner = fakeRunner()
  const start = runner.start.bind(runner)
  runner.start = async (input) => { prompts.set(input.node.id, input.prompt); return start(input) }
  const controller = createDagController({ directory, runner })
  const review = node("review")
  const ship: DagNodeDefinition = { ...node("ship", ["review"]), when: { node: "review", field: "node", equals: "review" } }
  const fix: DagNodeDefinition = { ...node("fix", ["review"]), when: { node: "review", field: "node", equals: "something-else" } }
  const report: DagNodeDefinition = { ...node("report", ["ship", "fix"]), inputs: [{ node: "*" }] }
  const run = await controller.create(definition([review, ship, fix, report]), "owner")
  const finished = await controller.wait(run.runID, "owner")
  expect(finished.status).toBe("completed")
  const status = Object.fromEntries(finished.nodes.map((n) => [n.definition.id, n.status]))
  expect(status).toEqual({ review: "completed", ship: "completed", fix: "skipped", report: "completed" })
  expect(runner.started).toEqual(["review", "ship", "report"])
  const prompt = prompts.get("report")!
  const inputs = JSON.parse(prompt.slice(prompt.indexOf("<iolaus-dag-inputs>") + "<iolaus-dag-inputs>".length, prompt.indexOf("</iolaus-dag-inputs>")))
  expect(inputs.map((i: { node: string; value: unknown; provenance: { status: string } }) => [i.node, i.value, i.provenance.status])).toEqual([
    ["ship", { node: "ship", attempt: 1 }, "completed"], ["fix", null, "skipped"],
  ])
  const { events } = await controller.snapshot(run.runID, "owner")
  expect(events.some((e) => e.type === "node.skipped" && e.nodeID === "fix")).toBe(true)
  controller.close()
})

test("condition validation rejects non-dependency references, empty groups and bad regex", () => {
  expect(() => validateDefinition(definition([node("a"), { ...node("b", ["a"]), when: { node: "zzz", exists: true } }]))).toThrow("non-dependency")
  expect(() => validateDefinition(definition([node("a"), { ...node("b", ["a"]), when: { node: "a" } }]))).toThrow("no predicate")
  expect(() => validateDefinition(definition([node("a"), { ...node("b", ["a"]), when: { all: [] } }]))).toThrow('Empty "all"')
  expect(() => validateDefinition(definition([node("a"), { ...node("b", ["a"]), when: { node: "a", matches: "(" } }]))).toThrow("Invalid condition regex")
  expect(() => validateDefinition(definition([node("a"), { ...node("b", ["a"]), when: { node: "a", field: "text", includes: "ok" } }]))).not.toThrow()
})

test("gate pauses the run, approve resumes with a human result, reject fails and blocks dependents", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-test-"))
  const runner = fakeRunner()
  const controller = createDagController({ directory, runner })
  const plan = node("plan")
  const gate: DagNodeDefinition = { id: "gate", kind: "gate", prompt: "Approve the plan?", dependsOn: ["plan"], inputs: [{ node: "plan" }] }
  const execute: DagNodeDefinition = { ...node("execute", ["gate"]), inputs: [{ node: "gate" }] }
  const run = await controller.create(definition([plan, gate, execute]), "owner")
  let waited = false
  const waiting = controller.wait(run.runID, "owner").then((r) => { waited = true; return r })
  await new Promise((resolve) => setTimeout(resolve, 50))
  let snapshot = await controller.snapshot(run.runID, "owner")
  expect(snapshot.run.status).toBe("paused")
  expect(snapshot.run.nodes.find((n) => n.definition.id === "gate")?.status).toBe("waiting_approval")
  expect(snapshot.run.nodes.find((n) => n.definition.id === "execute")?.status).toBe("pending")
  expect(runner.started).toEqual(["plan"])
  expect(waited).toBe(false)
  expect(snapshot.events.some((e) => e.type === "run.paused")).toBe(true)
  expect(snapshot.events.some((e) => e.type === "node.waiting" && e.nodeID === "gate")).toBe(true)
  await expect(controller.approve(run.runID, "owner", "plan")).rejects.toThrow("Not a gate node")
  await expect(controller.approve(run.runID, "intruder", "gate")).rejects.toThrow("another session")
  const approved = await controller.approve(run.runID, "owner", "gate", "looks good")
  expect(approved.nodes.find((n) => n.definition.id === "gate")?.result?.payload).toEqual({ decision: "approved", note: "looks good" })
  expect(approved.nodes.find((n) => n.definition.id === "gate")?.result?.provenance.agent).toBe("human")
  const finished = await waiting
  expect(finished.status).toBe("completed")
  expect(runner.started).toEqual(["plan", "execute"])
  await expect(controller.approve(run.runID, "owner", "gate")).rejects.toThrow("not waiting")

  const second = await controller.create(definition([plan, gate, execute]), "owner")
  await new Promise((resolve) => setTimeout(resolve, 50))
  const rejected = await controller.reject(second.runID, "owner", "gate", "not yet")
  expect(rejected.status).toBe("failed")
  expect(rejected.nodes.find((n) => n.definition.id === "gate")?.status).toBe("failed")
  expect(rejected.nodes.find((n) => n.definition.id === "gate")?.error).toBe("Rejected by approver: not yet")
  expect(rejected.nodes.find((n) => n.definition.id === "execute")?.status).toBe("blocked")
  snapshot = await controller.snapshot(second.runID, "owner")
  expect(snapshot.events.some((e) => e.type === "node.rejected")).toBe(true)
  const retried = await controller.retry(second.runID, "owner")
  await new Promise((resolve) => setTimeout(resolve, 50))
  const again = await controller.snapshot(second.runID, "owner")
  expect(retried.generation).toBe(2)
  expect(again.run.status).toBe("paused")
  expect(again.run.nodes.find((n) => n.definition.id === "gate")?.status).toBe("waiting_approval")
  const cancelled = await controller.cancel(second.runID, "owner")
  expect(cancelled.nodes.find((n) => n.definition.id === "gate")?.status).toBe("cancelled")
  controller.close()
})

test("gate validation requires a message and forbids an execution target", () => {
  expect(() => validateDefinition(definition([{ id: "g", kind: "gate", prompt: "  ", dependsOn: [] }]))).toThrow("needs a message")
  expect(() => validateDefinition(definition([{ id: "g", kind: "gate", agent: "sisyphus", prompt: "ok?", dependsOn: [] }]))).toThrow("must not name an agent")
  expect(() => validateDefinition(definition([{ id: "g", kind: "aggregator", agent: "x", model: "p/m", prompt: "ok?", dependsOn: [] }]))).toThrow("Unsupported node kind")
  expect(() => validateDefinition(definition([{ id: "g", kind: "gate", prompt: "ok?", dependsOn: [] }]))).not.toThrow()
})
