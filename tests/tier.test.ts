import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { createDagController as createEffectController } from "../src/dag/controller"
import { createOpenCodeDagRunner, runnerFromPromise } from "../src/dag/runner"
import { DagValidationError } from "../src/dag/errors"
import { admitTier, subagentTargets, tierDenial, tierSource, isTopLevel, type TierSession } from "../src/roles/tier"
import { expandTemplate } from "../src/dag/templates"
import type { DagDefinition, DagRunRecord } from "../src/dag/types"

let directory: string | undefined
function createDagController(options: Parameters<typeof createEffectController>[0]) {
  return createEffectController({ ...options, databasePath: options.databasePath ?? join(options.directory, "iolaus.db") })
}
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

test("session ancestry determines authority, not prompt markers or a child model", async () => {
  const sessions: Record<string, TierSession> = {
    si: { agent: "sisyphus" }, he: { agent: "hephaestus" }, pro: { agent: "prometheus" },
    lower: { agent: "momus", parentID: "si" },
    native: { agent: "build", parentID: "lower" },
    forged: { agent: "sisyphus", parentID: "lower" },
    foreign: { agent: "hephaestus", parentID: "si" },
    foreignChild: { agent: "hephaestus", parentID: "foreign" },
    internal: { agent: "sisyphus", metadata: { iolaus_dag_node: "work", iolaus_dag_run: "internal-run" } },
    ticket: { agent: "atlas", metadata: { iolaus_dag_node: "t01", iolaus_dag_run: "run" } },
    nestedTicket: { agent: "atlas", parentID: "ticket", metadata: { iolaus_dag_node: "work", iolaus_dag_run: "nested" } },
    "atlas-owner": { agent: "atlas" },
  }
  const atlasNode = { id: "t01", agent: "atlas", model: "openai/test", prompt: "ticket", dependsOn: [] }
  const graph: DagDefinition = { schemaVersion: 1, name: "plan", nodes: [atlasNode] }
  const run: DagRunRecord = { runID: "run", ownerSessionID: "atlas-owner", authorizedPlan: "cache", name: "plan", definition: graph, fingerprint: "hash", generation: 1, status: "running", nodes: [{ definition: atlasNode, fingerprint: "hash", status: "pending", attempt: 0 }], createdAt: 1, updatedAt: 1 }
  const internalRun: DagRunRecord = { ...run, runID: "internal-run", ownerSessionID: "si", nodes: [{ ...run.nodes[0]!, definition: { ...atlasNode, id: "work", agent: "sisyphus" } }] }
  const source = (id: string) => Effect.runPromise(tierSource(id, (name) => Effect.succeed(sessions[name]!), (runID, _nodeID, sessionID) =>
    Effect.succeed(sessionID === "ticket" && runID === "run" ? run : sessionID === "internal" && runID === "internal-run" ? internalRun : undefined)))
  expect(isTopLevel(sessions.internal!)).toBe(false)
  expect(tierDenial(await source("si"), "sisyphus")).toBeUndefined()
  expect(tierDenial(await source("si"), "hephaestus")).toContain("boundary")
  expect(tierDenial(await source("he"), "sisyphus")).toContain("boundary")
  expect(tierDenial(await source("pro"), "atlas")).toContain("boundary")
  expect(tierDenial(await source("internal"), "sisyphus")).toBeUndefined()
  expect(tierDenial(await source("internal"), "hephaestus")).toContain("boundary")
  expect(tierDenial(await source("foreignChild"), "hephaestus")).toContain("boundary")
  for (const id of ["lower", "native", "forged"]) {
    expect(tierDenial(await source(id), "sisyphus")).toContain("boundary")
    expect(tierDenial(await source(id), "hephaestus")).toContain("boundary")
    expect(tierDenial(await source(id), "quick")).toBeUndefined()
  }
  expect(tierDenial(await source("ticket"), "atlas")).toBeUndefined()
  expect((await source("nestedTicket")).atlasPlan).toBe("cache")
  expect(tierDenial(await source("nestedTicket"), "atlas")).toBeUndefined()
  expect(tierDenial(await source("atlas-owner"), "atlas")).toContain("boundary")
  expect(tierDenial(await source("atlas-owner"), "atlas", "cache")).toBeUndefined()
  sessions.forgedDag = { agent: "atlas", metadata: { iolaus_dag_node: "t01", iolaus_dag_run: "run" } }
  expect(tierDenial(await source("forgedDag"), "atlas")).toContain("boundary")
})

test("controller rejects expanded targets at create/amend/retry and before launch", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-tier-"))
  const started: string[] = []
  let owner = "sisyphus"
  const definition = (agent: string, kind?: "judge"): DagDefinition => ({ schemaVersion: 1, name: "tier", nodes: [{ id: "work", agent, ...(kind ? { kind } : {}), model: "openai/test", prompt: "work", dependsOn: [] }] })
  const controller = createDagController({
    directory,
    runner: runnerFromPromise({
      async start(input) { started.push(input.node.agent!); return { nodeID: input.node.id, attempt: input.attempt, sessionID: "child" } },
      async wait() { return { payload: { text: "done" } } },
      async cancel() {},
    }),
    admit: (_owner, graph) => {
      const denied = graph.nodes.map((node) => tierDenial({ agent: owner, primaryAllowed: owner === "sisyphus", atlasTicket: false, native: false }, node.agent ?? "")).find(Boolean)
      return denied ? Effect.fail(new DagValidationError(denied)) : Effect.void
    },
  })
  await expect(Effect.runPromise(controller.create(definition("hephaestus"), "owner"))).rejects.toThrow("boundary")
  await expect(Effect.runPromise(controller.create(definition("hephaestus", "judge"), "owner"))).rejects.toThrow("boundary")
  expect(started).toEqual([])
  const run = await Effect.runPromise(controller.create(definition("sisyphus"), "owner"))
  await Effect.runPromise(controller.wait(run.runID, "owner"))
  expect((await Effect.runPromise(controller.lineage(run.runID, "work", "child")))?.ownerSessionID).toBe("owner")
  expect(await Effect.runPromise(controller.lineage(run.runID, "work", "forged-child"))).toBeUndefined()
  expect(await Effect.runPromise(controller.lineage(run.runID, "unknown", "child"))).toBeUndefined()
  await expect(Effect.runPromise(controller.amend(run.runID, "owner", definition("prometheus")))).rejects.toThrow("boundary")
  owner = "momus"
  await expect(Effect.runPromise(controller.retry(run.runID, "owner", "work"))).rejects.toThrow("boundary")
  expect(started).toEqual(["sisyphus"])
  Effect.runSync(controller.close)
})

test("expanded template overrides and explicit judge models have no tier exception", () => {
  const caller = { agent: "sisyphus", primaryAllowed: true, atlasTicket: false, native: false }
  const session = { agent: "sisyphus" }
  const check = (template: object) => admitTier(caller, session, expandTemplate(template))
  expect(() => check({ template: "ultrawork", task: "x", reviewer: "hephaestus" })).toThrow("boundary")
  expect(() => check({ template: "ultrawork", task: "x", executor: "hephaestus" })).toThrow("boundary")
  expect(() => check({ template: "hyperplan", task: "x", members: ["sisyphus", "quick"] })).toThrow("boundary")
  expect(() => check({ template: "goal-review", task: "x" })).toThrow("boundary")
  expect(() => check({ template: "plan-review", task: "x" })).toThrow("boundary")
  expect(() => check({ template: "ultrawork", task: "x" })).not.toThrow()
  expect(() => admitTier({ ...caller, agent: "hephaestus" }, { agent: "hephaestus" }, expandTemplate({ template: "goal-review", task: "x" }))).not.toThrow()
  expect(() => admitTier({ ...caller, agent: "prometheus" }, { agent: "prometheus" }, expandTemplate({ template: "hyperplan", task: "x" }))).not.toThrow()
  const judge: DagDefinition = { schemaVersion: 1, name: "judge", nodes: [{ id: "review", kind: "judge", agent: "hephaestus", model: "anthropic/claude", prompt: "review", dependsOn: [] }] }
  expect(() => admitTier(caller, session, judge)).toThrow("boundary")
  expect(() => admitTier({ ...caller, agent: "atlas" }, { agent: "atlas", parentID: "child" }, judge, "cache")).toThrow("top-level")
})

test("native subagent continuation checks both the stored and supplied agents", async () => {
  const lower = { agent: "quick", primaryAllowed: false, atlasTicket: false, native: false }
  const get = () => Effect.succeed({ agent: "hephaestus" })
  const targets = await Effect.runPromise(subagentTargets({ agent: "quick", sessionID: "ses_primary" }, get))
  expect(targets).toEqual(["hephaestus", "quick"])
  expect(targets.map((target) => tierDenial(lower, target)).find(Boolean)).toContain("boundary")
  expect((await Effect.runPromise(subagentTargets({ agent: "sisyphus", sessionID: "ses_lower" }, () => Effect.succeed({ agent: "quick" })))).map((target) => tierDenial(lower, target)).find(Boolean)).toContain("boundary")
  expect(await Effect.runPromise(subagentTargets({ agent: "momus" }, get))).toEqual(["momus"])
})

test("authorized Atlas nodes persist across restart but cannot be forged by amendment", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-tier-"))
  const runner = runnerFromPromise({ async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: "child" } }, async wait() { return { payload: { text: "done" } } }, async cancel() {} })
  const graph: DagDefinition = { schemaVersion: 1, name: "start-work", nodes: [{ id: "t01", agent: "atlas", model: "openai/test", prompt: "ticket", dependsOn: [] }] }
  const options = { directory, runner, admit: (_owner: string, definition: DagDefinition, plan?: string) => Effect.try({ try: () => admitTier({ agent: "atlas", primaryAllowed: true, atlasTicket: false, native: false }, { agent: "atlas" }, definition, plan), catch: (error) => error instanceof DagValidationError ? error : new DagValidationError(String(error)) }) }
  const first = createDagController(options)
  await expect(Effect.runPromise(first.create(graph, "owner"))).rejects.toThrow("boundary")
  const run = await Effect.runPromise(first.create(graph, "owner", "cache"))
  await Effect.runPromise(first.wait(run.runID, "owner"))
  Effect.runSync(first.close)
  const restored = createDagController(options)
  expect((await Effect.runPromise(restored.snapshot(run.runID, "owner"))).run.authorizedPlan).toBe("cache")
  await expect(Effect.runPromise(restored.amend(run.runID, "owner", { ...graph, nodes: [{ ...graph.nodes[0]!, prompt: "forged ticket" }] }))).rejects.toThrow("not part of")
  const retried = await Effect.runPromise(restored.retry(run.runID, "owner", "t01"))
  expect((await Effect.runPromise(restored.wait(retried.runID, "owner"))).status).toBe("completed")
  Effect.runSync(restored.close)
})

test("a pending same-primary node is refused when its owner changes before gate approval", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-tier-"))
  const started: string[] = []
  let owner = "sisyphus"
  const controller = createDagController({
    directory,
    runner: runnerFromPromise({ async start(input) { started.push(input.node.id); return { nodeID: input.node.id, attempt: input.attempt, sessionID: "child" } }, async wait() { return { payload: { text: "done" } } }, async cancel() {} }),
    admit: (_session, definition) => Effect.try({
      try: () => admitTier({ agent: owner, primaryAllowed: owner === "sisyphus", atlasTicket: false, native: false }, { agent: owner }, definition),
      catch: (error) => error instanceof DagValidationError ? error : new DagValidationError(String(error)),
    }),
  })
  const graph: DagDefinition = { schemaVersion: 1, name: "drift", nodes: [
    { id: "gate", kind: "gate", prompt: "approve", dependsOn: [] },
    { id: "work", agent: "sisyphus", model: "openai/test", prompt: "work", dependsOn: ["gate"] },
  ] }
  const run = await Effect.runPromise(controller.create(graph, "owner"))
  owner = "momus"
  await Effect.runPromise(controller.approve(run.runID, "owner", "gate"))
  const completed = await Effect.runPromise(controller.wait(run.runID, "owner"))
  expect(completed.nodes.find((node) => node.definition.id === "work")?.status).toBe("failed")
  expect(started).toEqual([])
  Effect.runSync(controller.close)
})

test("the native DAG runner persists the execution before prompting without unsupported parentID", async () => {
  let created: { parentID?: unknown; metadata?: Record<string, unknown> } | undefined
  let prompted = false
  const runner = createOpenCodeDagRunner({
    location: { directory: "/project" },
    generate: { text: () => Effect.succeed({ text: "review" }) },
    session: {
      create: (input: { parentID?: unknown; metadata?: Record<string, unknown> }) => { created = input; return Effect.succeed({ id: "ses_child" }) },
      prompt: () => { prompted = true; return Effect.void }, wait: () => Effect.void,
      get: () => Effect.succeed({ outcome: "completed" }), context: () => Effect.succeed([]), interrupt: () => Effect.void,
    },
  } as never)
  const ref = await Effect.runPromise(runner.start({ node: { id: "work", agent: "sisyphus", model: "openai/test", prompt: "x", dependsOn: [] }, prompt: "x", attempt: 2, runID: "run" }))
  expect(created?.parentID).toBeUndefined()
  expect(created?.metadata).toEqual({ iolaus_dag_node: "work", iolaus_dag_attempt: 2, iolaus_dag_run: "run" })
  expect(prompted).toBe(false)
  await Effect.runPromise(runner.wait(ref))
  expect(prompted).toBe(true)
})
