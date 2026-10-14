import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDagController, type DagControllerOptions } from "../src/dag/controller"
import { promiseController } from "../src/dag/promise"
import { runnerFromPromise, type DagRunnerPromise, type DagRunnerStart } from "../src/dag/runner"
import { DagRunnerError } from "../src/dag/errors"
import type { DagDefinition, DagExecutionRef } from "../src/dag/types"
import { parseOptions } from "../src/options"
import { DagStore } from "../src/dag/store"
import { Deferred, Effect } from "effect"

test("owner-model rescue is a strict global opt-in", () => {
  expect(parseOptions({}).rescue).toEqual({ ownerModel: false })
  expect(parseOptions({ rescue: { ownerModel: true } }).rescue).toEqual({ ownerModel: true })
  expect(parseOptions({ rescue: {} }).rescue).toEqual({ ownerModel: false })
  for (const rescue of [null, true, [], "true", { ownerModel: 1 }, { ownerModel: null }, { unknown: false }]) {
    expect(() => parseOptions({ rescue })).toThrow()
  }
})

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const definition: DagDefinition = { schemaVersion: 1, name: "rescue", nodes: [
  { id: "work", agent: "quick", model: "test/A", fallbackModels: ["test/B", "test/C"], maxAttempts: 5, prompt: "Do the task", dependsOn: [] },
] }

function setup(runner: DagRunnerPromise, enabled = true, defaultModel?: (agent: string) => string | undefined, options?: Pick<DagControllerOptions, "rescueRoleAllowed" | "admit">) {
  const directory = mkdtempSync(join(tmpdir(), "iolaus-rescue-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const effects = createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(runner), rescue: { ownerModel: enabled }, defaultModel, ...options })
  const controller = promiseController(effects)
  let closed = false
  const close = () => { if (!closed) { closed = true; controller.close() } }
  cleanups.push(close)
  return { controller, directory, close, effects }
}

test("configured models exhaust the global attempt budget before one owner-model extra", async () => {
  const models: string[] = []
  const runner: DagRunnerPromise = {
    async start(input) { models.push(input.node.model!); return { nodeID: input.node.id, attempt: input.attempt, sessionID: `ses_${input.attempt}`, identity: input.identity } },
    async admit() {}, async verify() {}, async cancel() {},
    async wait(ref) {
      if (ref.identity?.model === "test/owner") return { payload: "continued" }
      throw new DagRunnerError({ message: "provider unavailable", model: true, providerFailure: "provider.auth" })
    },
    async checkpoint(input) { return { task: input.previous?.task ?? "Do the task", checkpoints: input.previous?.checkpoints ?? [], tools: 0 } },
    async ownerModel() { return "test/owner" },
    async validateHandoff() {},
  }
  const { controller } = setup(runner)
  const run = await controller.create(definition, "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(models).toEqual(["test/A", "test/B", "test/C", "test/C", "test/C", "test/owner"])
  expect(done.status).toBe("completed")
  expect(done.nodes[0]?.recovery?.failedModels).toEqual(["test/A", "test/B", "test/C"])
  expect(done.nodes[0]?.recovery?.rescue?.state).toBe("settled")
  expect(done.nodes[0]?.result?.provenance.rescue?.model).toBe("test/owner")
  expect((await controller.snapshot(run.runID, "owner")).events.filter((event) => event.type === "node.rescued")).toHaveLength(1)
})

const one: DagDefinition = { ...definition, nodes: [{ ...definition.nodes[0]!, fallbackModels: [], maxAttempts: 1 }] }
function failingRunner() {
  const starts: DagRunnerStart[] = []
  let owner = "test/owner"
  let failureType = "provider.auth"
  let rescuedReply: string | undefined
  const runner: DagRunnerPromise = {
    async start(input) { starts.push(input); return { nodeID: input.node.id, attempt: input.attempt, sessionID: `ses_${starts.length}`, identity: input.identity } },
    async admit() {}, async verify() {}, async cancel() {},
    async wait(ref) {
      if (ref.identity?.model === "test/owner" && rescuedReply !== undefined) return { payload: rescuedReply }
      throw new DagRunnerError({ message: "failure", model: true, providerFailure: failureType })
    },
    async checkpoint(input) { return { task: input.previous?.task ?? "Do the task", checkpoints: [...(input.previous?.checkpoints ?? []), { source: input.ref, contextHash: "audit", parts: [], outcome: input.terminal ?? "failed" }], tools: 0 } },
    async ownerModel() { return owner }, async validateHandoff() {},
  }
  return { runner, starts, setOwner: (value: string) => { owner = value }, setFailure: (value: string) => { failureType = value }, setReply: (value: string) => { rescuedReply = value } }
}

test("default-off keeps the old fallback and attempt order with no owner lookup or recovery state", async () => {
  const fixture = failingRunner()
  fixture.runner.ownerModel = async () => { throw new Error("default-off must not inspect the owner") }
  const { controller } = setup(fixture.runner, false)
  const run = await controller.create(definition, "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/B", "test/C", "test/C", "test/C"])
  expect(done.nodes[0]?.recovery).toBeUndefined()
})

test("flow definitions cannot opt themselves into global owner rescue", async () => {
  const fixture = failingRunner()
  const { controller } = setup(fixture.runner, false)
  const flowOption = { ...one, rescue: { ownerModel: true } }
  const nodeOption = { ...one, nodes: [{ ...one.nodes[0]!, rescue: { ownerModel: true } }] }
  await expect(controller.create(flowOption, "owner")).rejects.toThrow("global")
  await expect(controller.create(nodeOption, "owner")).rejects.toThrow("global")
  expect(fixture.starts).toHaveLength(0)
})

test("failure after rescue spends the budget permanently and explicit retry restores the pre-rescue definition", async () => {
  const fixture = failingRunner()
  const { controller, close, directory } = setup(fixture.runner)
  const run = await controller.create(one, "owner")
  let done = await controller.wait(run.runID, "owner")
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/owner"])
  const decision = done.nodes[0]!.recovery!.rescue!.decisionID
  expect(done.nodes[0]?.recovery?.handoff?.checkpoints).toHaveLength(2)
  await controller.retry(run.runID, "owner")
  done = await controller.wait(run.runID, "owner")
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/owner", "test/A"])
  expect(fixture.starts[2]?.handoff?.checkpoints).toHaveLength(2)
  expect(done.nodes[0]?.recovery?.rescue?.decisionID).toBe(decision)
  close()
  const restored = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(fixture.runner), rescue: { ownerModel: true } }))
  cleanups.push(() => restored.close())
  await restored.retry(run.runID, "owner")
  await restored.wait(run.runID, "owner")
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/owner", "test/A", "test/A"])
  expect((await restored.snapshot(run.runID, "owner")).events.filter((event) => event.type === "node.rescued")).toHaveLength(1)
})

test.each([false, true])("retry after settled rescue honors the current planned task and model chain (amended: %s)", async (amended) => {
  const fixture = failingRunner()
  fixture.setReply("rescued original task")
  const { controller } = setup(fixture.runner)
  const original: DagDefinition = { ...definition, nodes: [{ ...definition.nodes[0]!, prompt: "ORIGINAL task", maxAttempts: 3 }] }
  const updated: DagDefinition = { ...definition, nodes: [{ ...definition.nodes[0]!, prompt: "AMENDED task", model: "test/D", fallbackModels: ["test/E"], maxAttempts: 1 }] }
  const created = await controller.create(original, "owner")
  const rescued = await controller.wait(created.runID, "owner")
  expect(rescued.status).toBe("completed")
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/B", "test/C", "test/owner"])
  const decision = rescued.nodes[0]!.recovery!.rescue!.decisionID
  if (amended) {
    await controller.amend(created.runID, "owner", updated)
    expect((await controller.wait(created.runID, "owner")).status).toBe("failed")
    expect(fixture.starts.slice(4).map((input) => input.node.model)).toEqual(["test/D", "test/E"])
  }
  const beforeRetry = fixture.starts.length
  await controller.retry(created.runID, "owner", "work")
  const done = await controller.wait(created.runID, "owner")
  expect(fixture.starts[beforeRetry]?.node).toEqual((amended ? updated : original).nodes[0])
  expect(fixture.starts.slice(beforeRetry).map((input) => input.node.model)).toEqual(amended ? ["test/D", "test/E"] : ["test/A", "test/B", "test/C"])
  expect(fixture.starts.slice(beforeRetry).map((input) => input.prompt)).toEqual(amended ? ["AMENDED task", "AMENDED task"] : ["ORIGINAL task", "ORIGINAL task", "ORIGINAL task"])
  expect(done.status).toBe("failed")
  expect(done.nodes[0]?.recovery?.rescue?.decisionID).toBe(decision)
  expect(done.nodes[0]?.recovery?.rescue?.state).toBe("settled")
  expect((await controller.snapshot(created.runID, "owner")).events.filter((event) => event.type === "node.rescued")).toHaveLength(1)
})

test("amend, node row rebuild, removal and re-addition retain the spent rescue record", async () => {
  const fixture = failingRunner()
  const { controller } = setup(fixture.runner)
  const run = await controller.create(one, "owner")
  const done = await controller.wait(run.runID, "owner")
  const decision = done.nodes[0]!.recovery!.rescue!.decisionID
  await controller.amend(run.runID, "owner", { ...one, nodes: [{ id: "approve", kind: "gate", prompt: "Approve?", dependsOn: [] }] })
  await controller.reject(run.runID, "owner", "approve")
  await controller.amend(run.runID, "owner", one)
  const restored = await controller.wait(run.runID, "owner")
  expect(restored.nodes[0]?.recovery?.rescue?.decisionID).toBe(decision)
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/owner", "test/A"])
  expect(fixture.starts[2]?.handoff?.checkpoints).toHaveLength(2)
})

test.each(["test/A", "test/A#default"])("an actually failed owner model %s is deduplicated", async (model) => {
  const fixture = failingRunner(); fixture.setOwner(model)
  const { controller } = setup(fixture.runner)
  const run = await controller.create(one, "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.status).toBe("failed")
  expect(fixture.starts).toHaveLength(1)
  expect((await controller.snapshot(run.runID, "owner")).events.some((event) => event.type === "node.rescue-skipped" && event.payload !== null && typeof event.payload === "object" && "reason" in event.payload && event.payload.reason === "owner_model_already_failed")).toBe(true)
})

test.each(["provider.unknown", "provider.content-filter", "provider.invalid-request", "tool.error", "permission.denied"])("terminal %s never reserves an owner rescue", async (failure) => {
  const fixture = failingRunner(); fixture.setFailure(failure)
  const { controller } = setup(fixture.runner)
  const run = await controller.create(one, "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.nodes[0]?.recovery?.rescue).toBeUndefined()
  expect(fixture.starts).toHaveLength(1)
})

test.each(["", "ESCALATE: deep-high"])("a rescue reply %j never restarts or escalates the rescue attempt", async (reply) => {
  const fixture = failingRunner(); fixture.setReply(reply)
  const { controller } = setup(fixture.runner)
  const run = await controller.create({ ...one, nodes: [{ ...one.nodes[0]!, agent: "deep-low", maxAttempts: 3 }] }, "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/A", "test/A", "test/owner"])
  expect(done.nodes[0]?.definition.agent).toBe("deep-low")
  expect(done.nodes[0]?.recovery?.rescue?.state).toBe("settled")
  expect(done.status).toBe(reply ? "completed" : "failed")
})

test.each(["judge", "atlas", "prometheus"])("excluded execution %s never reserves rescue", async (kind) => {
  const fixture = failingRunner()
  const { controller } = setup(fixture.runner)
  const node = kind === "judge" ? { ...one.nodes[0]!, kind: "judge" as const } : { ...one.nodes[0]!, agent: kind }
  const run = await controller.create({ ...one, nodes: [node] }, "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.nodes[0]?.recovery?.rescue).toBeUndefined()
  expect(fixture.starts).toHaveLength(1)
})

test.each(["atlas", "prometheus", "authorized-agent", "atlas-flow-agent"])("excluded %s keeps ordinary fallback, remaining attempts, retry and amend", async (kind) => {
  const fixture = failingRunner()
  fixture.runner.checkpoint = async () => { throw new Error("Excluded work must not inspect recovery history") }
  fixture.runner.ownerModel = async () => { throw new Error("Excluded work must not look up an owner rescue") }
  const { controller, effects } = setup(fixture.runner)
  const task = { ...definition.nodes[0]!, agent: kind === "atlas" || kind === "prometheus" ? kind : "quick" }
  const graph: DagDefinition = { ...definition, nodes: [task, ...(kind === "atlas-flow-agent" ? [{ ...task, id: "ticket", agent: "atlas" }] : [])] }
  const created = await Effect.runPromise(effects.create(graph, "owner", kind === "authorized-agent" ? "approved-plan" : undefined))
  const failed = await controller.wait(created.runID, "owner")
  expect(failed.status).toBe("failed")
  expect(fixture.starts.filter((input) => input.node.id === "work").map((input) => input.node.model)).toEqual(["test/A", "test/B", "test/C", "test/C", "test/C"])
  for (const node of failed.nodes) {
    expect(node.recovery?.blocked).toBeUndefined()
    expect(node.recovery?.handoff).toBeUndefined()
    expect(node.recovery?.rescue).toBeUndefined()
  }
  const beforeRetry = fixture.starts.length
  await controller.retry(created.runID, "owner", "work")
  await controller.wait(created.runID, "owner")
  expect(fixture.starts.slice(beforeRetry).map((input) => input.node.model)).toEqual(["test/A", "test/B", "test/C"])
  fixture.runner.wait = async () => ({ payload: "ordinary success" })
  await controller.amend(created.runID, "owner", { ...graph, name: "successful excluded work", nodes: graph.nodes.map((node) => ({ ...node, prompt: "Updated task" })) })
  expect((await controller.wait(created.runID, "owner")).status).toBe("completed")
  await controller.retry(created.runID, "owner", "work")
  expect((await controller.wait(created.runID, "owner")).status).toBe("completed")
  await controller.amend(created.runID, "owner", graph)
  expect((await controller.wait(created.runID, "owner")).status).toBe("completed")
  expect(fixture.starts.every((input) => input.handoff === undefined)).toBe(true)
  expect((await controller.snapshot(created.runID, "owner")).events.filter((event) => event.type === "node.rescued" || event.type === "node.rescue-skipped")).toHaveLength(0)
})

test.each([true, false])("successful lane escalation requires no failed safety check (safe checkpoint: %s)", async (safe) => {
  const fixture = failingRunner()
  fixture.runner.wait = async (ref) => ({ payload: ref.identity?.agent === "deep-low" ? "Findings\nESCALATE: deep-high" : "Decision" })
  if (!safe) fixture.runner.checkpoint = async () => { throw new DagRunnerError({ message: "pending_host_input", nonRetryable: true }) }
  const { controller } = setup(fixture.runner, true, (agent) => agent === "deep-high" ? "test/high" : undefined)
  const created = await controller.create({ ...one, nodes: [{ ...one.nodes[0]!, agent: "deep-low" }] }, "owner")
  const done = await controller.wait(created.runID, "owner")
  expect(done.status).toBe("completed")
  expect(fixture.starts.map((input) => input.node.agent)).toEqual(safe ? ["deep-low", "deep-high"] : ["deep-low"])
  if (safe) {
    expect(fixture.starts[1]?.handoff).toBeUndefined()
    expect(fixture.starts[1]?.prompt).toContain("Findings")
    await controller.retry(created.runID, "owner", "work")
    await controller.wait(created.runID, "owner")
    expect(fixture.starts.at(-1)?.node.agent).toBe("deep-high")
    expect(fixture.starts.at(-1)?.node.model).toBe("test/high")
  } else {
    expect(done.nodes[0]?.recovery?.blocked).toBe("pending_host_input")
    await expect(controller.retry(created.runID, "owner", "work")).rejects.toThrow("unresolved")
  }
})

test.each([false, true])("rescue crash recovery reattaches only recorded executions (recorded: %s)", async (recorded) => {
  const fixture = failingRunner()
  const { controller, directory, close } = setup(fixture.runner)
  const run = await controller.create(one, "owner")
  const done = await controller.wait(run.runID, "owner")
  close()
  const node = done.nodes[0]!
  const rescue = node.recovery!.rescue!
  const store = new DagStore(join(directory, "state.db"), directory)
  store.saveRun({ ...done, status: "running", nodes: [{ ...node, status: recorded ? "running" : "starting", execution: recorded ? node.execution : undefined, recovery: { ...node.recovery!, rescue: { ...rescue, state: "started", execution: recorded ? rescue.execution : undefined } } }] })
  store.close()
  const reattached: DagExecutionRef[] = []
  fixture.runner.reattach = async (ref) => { reattached.push(ref); return { payload: "completed offline" } }
  const restored = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(fixture.runner), rescue: { ownerModel: true } }))
  cleanups.push(() => restored.close())
  const result = await restored.wait(run.runID, "owner")
  expect(fixture.starts).toHaveLength(2)
  expect(reattached).toHaveLength(recorded ? 1 : 0)
  expect(result.nodes[0]?.status).toBe(recorded ? "completed" : "interrupted")
  if (!recorded) await expect(restored.retry(run.runID, "owner")).rejects.toThrow("unresolved")
})

test("reservation, portable checkpoint, event and non-waking notice are committed together", async () => {
  const fixture = failingRunner()
  const directory = mkdtempSync(join(tmpdir(), "iolaus-rescue-notice-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const observed: string[] = []
  const effect = createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(fixture.runner), rescue: { ownerModel: true }, notifier: {
    send: (notice) => Effect.gen(function* () {
      const state = yield* effect.snapshot(notice.runID, "owner").pipe(Effect.orDie)
      const event = state.events.find((event) => event.eventID === notice.eventID)!
      if (event.type === "node.rescued") {
        expect(state.run.nodes[0]?.recovery?.rescue).toBeDefined()
        expect(state.run.nodes[0]?.recovery?.handoff).toBeDefined()
        observed.push(event.type)
      }
      return { messageID: notice.messageID }
    }), reconcile: () => Effect.succeed(undefined),
  } })
  const controller = promiseController(effect)
  cleanups.push(() => controller.close())
  const run = await controller.create(one, "owner")
  await controller.wait(run.runID, "owner")
  expect(observed).toEqual(["node.rescued"])
})

test("confirmed steering survives provider failures through remaining fallbacks, attempts and the owner extra", async () => {
  const fixture = failingRunner()
  let ready!: () => void
  const waiting = new Promise<void>((resolve) => { ready = resolve })
  const never = new Promise<never>(() => {})
  fixture.runner.wait = async (ref, requests) => {
    if (ref.attempt === 1 && !requests?.length) { ready(); return never }
    if (ref.identity?.model === "test/owner") return { payload: "supplement preserved" }
    throw new DagRunnerError({ message: "auth outage after delivered input", model: true, providerFailure: "provider.auth" })
  }
  fixture.runner.steer = async (_ref, request) => ({ messageID: request.messageID })
  fixture.runner.checkpoint = async (input) => ({ task: "Do the task", tools: 0, checkpoints: [...(input.previous?.checkpoints ?? []), {
    source: input.ref, contextHash: "audited", outcome: input.terminal ?? "failed", parts: input.requests.filter((request) => request.execution.identity?.token === input.ref.identity?.token).map((request) => ({ type: "steer", requestID: request.requestID, messageID: request.receipt!.messageID, text: request.text, revision: request.revision, token: input.ref.identity!.token })),
  }] })
  const { controller } = setup(fixture.runner)
  const created = await controller.create(definition, "owner")
  await waiting
  await controller.steer(created.runID, "owner", "work", "Keep existing effects", "request")
  const done = await controller.wait(created.runID, "owner")
  expect(done.status).toBe("completed")
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/B", "test/C", "test/C", "test/C", "test/owner"])
  expect(new Set(fixture.starts.map((input) => input.identity?.token)).size).toBe(6)
  expect(done.nodes[0]?.result?.inputRevision).toBe(1)
  const snapshot = await controller.snapshot(created.runID, "owner")
  expect(snapshot.steering?.[0]?.state).toBe("delivered")
  expect((await controller.steer(created.runID, "owner", "work", "Keep existing effects", "request")).state).toBe("delivered")
  expect(done.nodes[0]?.recovery?.handoff?.checkpoints.flatMap((entry) => entry.parts)).toEqual([expect.objectContaining({ type: "steer", text: "Keep existing effects", token: fixture.starts[0]?.identity?.token })])
})

test("a failed continuation create is ambiguous, consumes rescue and cannot be replayed by retry or amend", async () => {
  const fixture = failingRunner()
  const start = fixture.runner.start
  fixture.runner.start = async (input) => {
    const ref = await start(input)
    if (input.handoff) throw new Error("lost create receipt")
    return ref
  }
  const { controller } = setup(fixture.runner)
  const created = await controller.create(one, "owner")
  const done = await controller.wait(created.runID, "owner")
  expect(fixture.starts).toHaveLength(2)
  expect(done.nodes[0]?.recovery?.rescue?.state).toBe("settled")
  await expect(controller.retry(created.runID, "owner")).rejects.toThrow("unresolved")
  await expect(controller.amend(created.runID, "owner", one)).rejects.toThrow("unresolved")
})

test("confirmed input remains delivered when unsafe tool history prevents provider-failure rescue", async () => {
  const fixture = failingRunner()
  let ready!: () => void
  const waiting = new Promise<void>((resolve) => { ready = resolve })
  fixture.runner.wait = async (_ref, requests) => {
    if (!requests?.length) { ready(); return new Promise<never>(() => {}) }
    throw new DagRunnerError({ message: "auth outage", model: true, providerFailure: "provider.auth", deliveredRequests: requests.map((request) => request.requestID) })
  }
  fixture.runner.steer = async (_ref, request) => ({ messageID: request.messageID })
  fixture.runner.checkpoint = async () => { throw new DagRunnerError({ message: "opaque_tool_history", nonRetryable: true }) }
  const { controller } = setup(fixture.runner)
  const created = await controller.create(one, "owner")
  await waiting
  await controller.steer(created.runID, "owner", "work", "confirmed input", "receipt")
  await controller.wait(created.runID, "owner")
  const snapshot = await controller.snapshot(created.runID, "owner")
  expect(snapshot.steering?.[0]?.state).toBe("delivered")
  expect(snapshot.run.nodes[0]?.recovery?.rescue).toBeUndefined()
  expect(fixture.starts).toHaveLength(1)
})

test("fresh child create errors and successful empty replies never become an initial owner rescue", async () => {
  for (const stage of ["create", "empty"] as const) {
    const fixture = failingRunner()
    if (stage === "create") fixture.runner.start = async (input) => { fixture.starts.push(input); throw new DagRunnerError({ message: "create failed", model: true }) }
    else fixture.runner.wait = async () => ({ payload: "" })
    const { controller } = setup(fixture.runner)
    const created = await controller.create(one, "owner")
    const done = await controller.wait(created.runID, "owner")
    expect(fixture.starts).toHaveLength(1)
    expect(done.nodes[0]?.recovery?.rescue).toBeUndefined()
  }
})

test("a recovered reservation keeps the pinned model and stores its new token before create", async () => {
  const fixture = failingRunner()
  const { controller, close, directory } = setup(fixture.runner)
  const created = await controller.create(one, "owner")
  const done = await controller.wait(created.runID, "owner")
  close()
  const node = done.nodes[0]!
  const store = new DagStore(join(directory, "state.db"), directory)
  store.saveRun({ ...done, status: "running", nodes: [{ ...node, status: "needs_retry", execution: undefined, recovery: { ...node.recovery!, handoff: { ...node.recovery!.handoff!, checkpoints: node.recovery!.handoff!.checkpoints.slice(0, 1) }, rescue: { ...node.recovery!.rescue!, state: "reserved", launchToken: undefined, execution: undefined } } }] })
  const start = fixture.runner.start
  fixture.runner.start = async (input) => {
    const persisted = store.getRun(created.runID)!.nodes[0]!
    expect(persisted.recovery?.rescue?.state).toBe("started")
    expect(persisted.recovery?.rescue?.launchToken).toBe(input.identity?.token)
    return start(input)
  }
  fixture.setOwner("test/new-owner"); fixture.setReply("pinned model succeeded")
  const restored = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(fixture.runner), rescue: { ownerModel: true } }))
  cleanups.push(() => { restored.close(); store.close() })
  const result = await restored.wait(created.runID, "owner")
  expect(result.status).toBe("completed")
  expect(fixture.starts.at(-1)?.node.model).toBe("test/owner")
})

test("restart recovery waits for security registrations before launching a reserved rescue", async () => {
  const fixture = failingRunner()
  const { controller, close, directory } = setup(fixture.runner)
  const created = await controller.create(one, "owner")
  const done = await controller.wait(created.runID, "owner")
  close()
  const node = done.nodes[0]!
  const store = new DagStore(join(directory, "state.db"), directory)
  store.saveRun({ ...done, status: "running", nodes: [{ ...node, status: "needs_retry", execution: undefined, recovery: { ...node.recovery!, rescue: { ...node.recovery!.rescue!, state: "reserved", launchToken: undefined, execution: undefined } } }] })
  store.close()
  const ready = Deferred.makeUnsafe<void>()
  let registered = false
  fixture.runner.validateHandoff = async () => { if (!registered) throw new Error("permission transforms not registered") }
  fixture.setReply("resumed after registration")
  const restored = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(fixture.runner), rescue: { ownerModel: true }, recoveryReady: Deferred.await(ready) }))
  cleanups.push(() => restored.close())
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(fixture.starts).toHaveLength(2)
  registered = true
  Deferred.doneUnsafe(ready, await Effect.runPromise(Effect.exit(Effect.void)))
  const result = await restored.wait(created.runID, "owner")
  expect(result.status).toBe("completed")
  expect(fixture.starts).toHaveLength(3)
})

test("enabling rescue after a legacy failure does not invent the missing historical checkpoint", async () => {
  const fixture = failingRunner()
  const { controller, close, directory } = setup(fixture.runner, false)
  const created = await controller.create(one, "owner")
  await controller.wait(created.runID, "owner")
  close()
  const restored = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(fixture.runner), rescue: { ownerModel: true } }))
  cleanups.push(() => restored.close())
  await restored.retry(created.runID, "owner")
  const result = await restored.wait(created.runID, "owner")
  expect(result.nodes[0]?.recovery?.historyKnown).toBe(false)
  expect(result.nodes[0]?.recovery?.rescue).toBeUndefined()
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/A"])
})

test("cancelling the owner extra consumes it and fences a late successful reply", async () => {
  const fixture = failingRunner()
  let ready!: () => void
  let release!: (value: { payload: string }) => void
  const waiting = new Promise<void>((resolve) => { ready = resolve })
  const result = new Promise<{ payload: string }>((resolve) => { release = resolve })
  const wait = fixture.runner.wait
  fixture.runner.wait = async (ref) => {
    if (ref.identity?.model !== "test/owner") return wait(ref)
    ready(); return result
  }
  const { controller } = setup(fixture.runner)
  const created = await controller.create(one, "owner")
  await waiting
  await controller.cancel(created.runID, "owner")
  release({ payload: "late rescue result" })
  const done = await controller.wait(created.runID, "owner")
  expect(done.status).toBe("cancelled")
  expect(done.nodes[0]?.result).toBeUndefined()
  expect(done.nodes[0]?.recovery?.rescue?.state).toBe("settled")
  await expect(controller.retry(created.runID, "owner", "work")).rejects.toThrow("unresolved")
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/owner"])
})

test.each(["eligible", "planning-owner", "default-off", "judge", "atlas", "prometheus", "authorized-agent"])("cancellation during child creation preserves the initial %s boundary", async (kind) => {
  const fixture = failingRunner()
  let ready!: () => void
  let release!: () => void
  let cancelled!: () => void
  const starting = new Promise<void>((resolve) => { ready = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const stopped = new Promise<void>((resolve) => { cancelled = resolve })
  const start = fixture.runner.start
  const admitted: string[] = []
  fixture.runner.start = async (input) => {
    const ref = await start(input)
    if (fixture.starts.length === 1) { ready(); await held }
    return ref
  }
  fixture.runner.admit = async (ref) => { admitted.push(ref.sessionID) }
  fixture.runner.cancel = async () => { cancelled() }
  fixture.runner.wait = async () => ({ payload: "ordinary success" })
  const { controller, effects } = setup(fixture.runner, kind !== "default-off", undefined, { rescueRoleAllowed: () => Effect.succeed(kind !== "planning-owner") })
  const graph: DagDefinition = { ...one, nodes: [{ ...one.nodes[0]!, ...(kind === "judge" ? { kind: "judge" } : ["atlas", "prometheus"].includes(kind) ? { agent: kind } : {}) }] }
  const created = await Effect.runPromise(effects.create(graph, "owner", kind === "authorized-agent" ? "approved-plan" : undefined))
  await starting
  const cancelledRun = await controller.cancel(created.runID, "owner")
  release(); await stopped
  expect(admitted).toEqual([])
  expect(cancelledRun.nodes[0]?.recovery?.handoff).toBeUndefined()
  expect(cancelledRun.nodes[0]?.recovery?.rescue).toBeUndefined()
  if (kind === "eligible") {
    expect(cancelledRun.nodes[0]?.recovery?.blocked).toBe("cancelled_continuation")
    await expect(controller.retry(created.runID, "owner", "work")).rejects.toThrow("unresolved")
    await expect(controller.amend(created.runID, "owner", graph)).rejects.toThrow("unresolved")
    expect(fixture.starts).toHaveLength(1)
  } else {
    expect(cancelledRun.nodes[0]?.recovery?.blocked).toBeUndefined()
    if (kind === "planning-owner") expect(cancelledRun.nodes[0]?.recovery?.initialRoleAllowed).toBe(false)
    if (kind === "default-off") expect(cancelledRun.nodes[0]?.recovery).toBeUndefined()
    await controller.retry(created.runID, "owner", "work")
    expect((await controller.wait(created.runID, "owner")).status).toBe("completed")
    await controller.amend(created.runID, "owner", { ...graph, nodes: graph.nodes.map((node) => ({ ...node, prompt: "Updated ordinary task" })) })
    expect((await controller.wait(created.runID, "owner")).status).toBe("completed")
    expect(fixture.starts).toHaveLength(3)
  }
})

test("cancel before launch admission never starts a child or poisons untouched recovery history", async () => {
  const fixture = failingRunner()
  const ready = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const returned = Deferred.makeUnsafe<void>()
  let admissions = 0
  const { controller } = setup(fixture.runner, true, undefined, {
    admit: () => Effect.gen(function* () {
      if (++admissions !== 2) return
      yield* Deferred.succeed(ready, undefined)
      yield* Deferred.await(release)
      yield* Deferred.succeed(returned, undefined)
    }),
    rescueRoleAllowed: () => Effect.succeed(true),
  })
  const created = await controller.create(one, "owner")
  await Effect.runPromise(Deferred.await(ready))
  const cancelled = await controller.cancel(created.runID, "owner")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(Deferred.await(returned))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(fixture.starts).toHaveLength(0)
  expect(cancelled.nodes[0]?.recovery?.blocked).toBeUndefined()
  fixture.runner.wait = async () => ({ payload: "fresh execution" })
  await controller.retry(created.runID, "owner", "work")
  expect((await controller.wait(created.runID, "owner")).status).toBe("completed")
  expect(fixture.starts).toHaveLength(1)
})

test.each(["eligible", "default-off", "judge", "atlas", "prometheus", "authorized-agent", "planning-owner", "planning-child"])("cancellation after admission preserves the initial %s boundary", async (kind) => {
  const fixture = failingRunner()
  const ready = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  fixture.runner.wait = async (ref) => {
    if (ref.attempt === 1) {
      await Effect.runPromise(Deferred.succeed(ready, undefined))
      await Effect.runPromise(Deferred.await(release))
    }
    return { payload: "ordinary completion" }
  }
  const { controller, effects } = setup(fixture.runner, kind !== "default-off", undefined, {
    rescueRoleAllowed: (sessionID) => Effect.succeed(kind !== "planning-owner" && !(kind === "planning-child" && sessionID !== "owner")),
  })
  const graph: DagDefinition = { ...one, nodes: [{ ...one.nodes[0]!, ...(kind === "judge" ? { kind: "judge" } : ["atlas", "prometheus"].includes(kind) ? { agent: kind } : {}) }] }
  const created = await Effect.runPromise(effects.create(graph, "owner", kind === "authorized-agent" ? "approved-plan" : undefined))
  await Effect.runPromise(Deferred.await(ready))
  const cancelled = await controller.cancel(created.runID, "owner")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect((await controller.node(created.runID, "owner", "work")).result).toBeUndefined()
  if (kind === "eligible") {
    expect(cancelled.nodes[0]?.recovery?.blocked).toBe("cancelled_continuation")
    expect(cancelled.nodes[0]?.recovery?.handoff).toBeUndefined()
    await expect(controller.retry(created.runID, "owner", "work")).rejects.toThrow("unresolved")
  } else {
    expect(cancelled.nodes[0]?.recovery?.blocked).toBeUndefined()
    await controller.retry(created.runID, "owner", "work")
    expect((await controller.wait(created.runID, "owner")).status).toBe("completed")
  }
})

test("cancelling an active continuation after disabling rescue still blocks its persisted handoff", async () => {
  const fixture = failingRunner()
  let ready!: () => void
  const waiting = new Promise<void>((resolve) => { ready = resolve })
  const wait = fixture.runner.wait
  fixture.runner.wait = async (ref) => {
    if (ref.attempt === 1) return wait(ref)
    ready(); return new Promise<never>(() => {})
  }
  const { controller, directory, close } = setup(fixture.runner)
  const created = await controller.create(definition, "owner")
  await waiting
  const before = await controller.node(created.runID, "owner", "work")
  expect(before.recovery?.rescue).toBeUndefined()
  close()
  const attached = Deferred.makeUnsafe<void>()
  fixture.runner.reattach = async () => {
    await Effect.runPromise(Deferred.succeed(attached, undefined))
    return new Promise<never>(() => {})
  }
  const restored = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(fixture.runner), rescue: { ownerModel: false } }))
  cleanups.push(() => restored.close())
  await Effect.runPromise(Deferred.await(attached))
  const cancelled = await restored.cancel(created.runID, "owner")
  expect(cancelled.nodes[0]?.recovery?.blocked).toBe("cancelled_continuation")
  expect(cancelled.nodes[0]?.recovery?.handoff).toEqual(before.recovery?.handoff)
  await expect(restored.retry(created.runID, "owner", "work")).rejects.toThrow("unresolved")
  await expect(restored.resume(created.runID, "owner")).rejects.toThrow("unresolved")
  await expect(restored.amend(created.runID, "owner", definition)).rejects.toThrow("unresolved")
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/B"])
})

test("cancelled pre-rescue fallback creation fences a late B ref without admitting or recapturing A", async () => {
  const fixture = failingRunner()
  const ready = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const stopped = Deferred.makeUnsafe<DagExecutionRef>()
  const start = fixture.runner.start
  const admitted: string[] = []
  const captures: string[] = []
  const checkpoint = fixture.runner.checkpoint!
  fixture.runner.start = async (input) => {
    const ref = await start(input)
    if (input.attempt === 2) {
      await Effect.runPromise(Deferred.succeed(ready, undefined))
      await Effect.runPromise(Deferred.await(release))
    }
    return ref
  }
  fixture.runner.admit = async (ref) => { admitted.push(ref.sessionID) }
  fixture.runner.cancel = async (ref) => { await Effect.runPromise(Deferred.succeed(stopped, ref)) }
  fixture.runner.checkpoint = async (input) => { captures.push(input.ref.sessionID); return checkpoint(input) }
  const { controller } = setup(fixture.runner)
  const created = await controller.create(definition, "owner")
  await Effect.runPromise(Deferred.await(ready))
  const cancelled = await controller.cancel(created.runID, "owner")
  expect(cancelled.nodes[0]?.execution).toBeUndefined()
  expect(cancelled.nodes[0]?.recovery?.blocked).toBe("cancelled_continuation")
  expect(cancelled.nodes[0]?.recovery?.rescue).toBeUndefined()
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect((await Effect.runPromise(Deferred.await(stopped))).identity?.token).toBe(fixture.starts[1]?.identity?.token)
  await expect(controller.retry(created.runID, "owner", "work")).rejects.toThrow("unresolved")
  await expect(controller.amend(created.runID, "owner", definition)).rejects.toThrow("unresolved")
  expect(admitted).toEqual(["ses_1"])
  expect(captures).toEqual(["ses_1"])
  expect(fixture.starts.map((input) => input.node.model)).toEqual(["test/A", "test/B"])
})

test("cancellation leaves completed history intact and never blocks untouched gates or observed calls", async () => {
  const fixture = failingRunner()
  const ready = Deferred.makeUnsafe<void>()
  fixture.runner.wait = async (ref) => {
    if (ref.nodeID === "work") return { payload: "completed work" }
    await Effect.runPromise(Deferred.succeed(ready, undefined))
    return new Promise<never>(() => {})
  }
  const { controller, effects } = setup(fixture.runner)
  const graph: DagDefinition = { ...one, nodes: [one.nodes[0]!, { ...one.nodes[0]!, id: "active", dependsOn: ["work"] }, { id: "gate", kind: "gate", prompt: "Approve?", dependsOn: ["active"] }] }
  const created = await controller.create(graph, "owner")
  await Effect.runPromise(Deferred.await(ready))
  const completed = await controller.node(created.runID, "owner", "work")
  await controller.cancel(created.runID, "owner")
  expect(await controller.node(created.runID, "owner", "work")).toEqual(completed)
  expect((await controller.node(created.runID, "owner", "active")).recovery?.blocked).toBe("cancelled_continuation")
  expect((await controller.node(created.runID, "owner", "gate")).recovery?.blocked).toBeUndefined()
  const observed = await Effect.runPromise(effects.observe({ ownerSessionID: "owner", agent: "quick", title: "native work", prompt: "task", sessionID: "ses_observed" }))
  const cancelled = await controller.cancel(observed.runID, "owner")
  expect(cancelled.nodes[0]?.recovery?.blocked).toBeUndefined()
  await expect(controller.retry(observed.runID, "owner", observed.nodeID)).rejects.toThrow("native subagent")
})
