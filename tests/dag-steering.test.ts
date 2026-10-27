import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { createDagController } from "../src/dag/controller"
import { promiseController } from "../src/dag/promise"
import { createOpenCodeDagRunner, runnerFromPromise, type DagRunnerPromise } from "../src/dag/runner"
import type { DagDefinition, DagExecutionRef, DagSteerRequest } from "../src/dag/types"
import { denial } from "../src/roles/guard"
import { createDagTool, FLOW_TOOL_NAME } from "../src/dag/tool"
import { DagRunnerError, DagValidationError } from "../src/dag/errors"
import { createOpenCodeDagNotifier } from "../src/dag/notices"
import { SessionStateStore } from "../src/database"
import { admitSteering } from "../src/roles/steering"
import { DagStore } from "../src/dag/store"
import { graphFingerprint, nodeFingerprint } from "../src/dag/fingerprint"

const directories: string[] = []
const controllers: ReturnType<typeof promiseController>[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => { resolve = done })
  return { promise, resolve }
}

const graph: DagDefinition = { schemaVersion: 1, name: "steering", nodes: [
  { id: "implement", agent: "visual-engineering", model: "test/visual", prompt: "Implement", dependsOn: [] },
  { id: "review", agent: "momus", model: "test/review", prompt: "Review", dependsOn: ["implement"], inputs: [{ node: "*" }] },
] }

function setup(runner: DagRunnerPromise, extra: Partial<Omit<Parameters<typeof createDagController>[0], "runner" | "directory" | "databasePath">> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "iolaus-steering-"))
  directories.push(directory)
  const effect = createDagController({ ...extra, directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(runner) })
  const controller = promiseController(effect)
  controllers.push(controller)
  return { controller, effect, directory }
}

test("cancelling during session creation fences ref publication and never prompts the late child", async () => {
  const creating = deferred<void>()
  const release = deferred<void>()
  const cancelled = deferred<string>()
  let waits = 0
  const { controller } = setup({
    async start(input) { creating.resolve(); await release.promise; return { nodeID: input.node.id, attempt: input.attempt, sessionID: "late" } },
    async wait() { waits++; return { payload: "stale" } },
    async cancel(ref) { cancelled.resolve(ref.sessionID) },
  })
  const run = await controller.create(graph, "owner")
  await creating.promise
  await controller.cancel(run.runID, "owner")
  release.resolve()
  expect(await cancelled.promise).toBe("late")
  expect(waits).toBe(0)
  expect((await controller.snapshot(run.runID, "owner")).run.status).toBe("cancelled")
})

test.each([false, true])("owner interruption during steering cannot strand the live controller (failed admission: %s)", async (failAdmission) => {
  const waiting = deferred<void>()
  const admitting = deferred<void>()
  const receipt = deferred<void>()
  const oldResult = deferred<{ payload: string }>()
  const cancelled = deferred<void>()
  let dispatches = 0
  const { controller, effect } = setup({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: input.node.id } },
    async admit() {}, async verify() {},
    async steer(_ref, request) {
      dispatches++; admitting.resolve(); await receipt.promise
      if (failAdmission) throw new Error("delivery uncertain")
      return { messageID: request.messageID }
    },
    async wait(ref, requests) {
      if (ref.nodeID === "review") return { payload: "reviewed" }
      if (requests?.length) return { payload: "supplement applied" }
      waiting.resolve(); return oldResult.promise
    },
    async cancel() { cancelled.resolve() },
  })
  const run = await controller.create(graph, "owner")
  await waiting.promise
  const steering = Effect.runFork(effect.steer(run.runID, "owner", "implement", "fontsource", "interrupted"))
  await admitting.promise
  await Effect.runPromise(Fiber.interrupt(steering))
  expect((await controller.snapshot(run.runID, "owner")).steering?.[0]?.state).toBe("reserved")
  oldResult.resolve({ payload: "stale" })
  receipt.resolve()
  const done = await controller.wait(run.runID, "owner")
  expect(dispatches).toBe(1)
  if (failAdmission) {
    await cancelled.promise
    expect(done.nodes[0]?.status).toBe("interrupted")
    expect(done.nodes[0]?.result).toBeUndefined()
    expect(done.nodes[1]?.status).toBe("blocked")
    expect((await controller.snapshot(run.runID, "owner")).steering?.[0]?.state).toBe("unresolved")
  } else {
    expect(done.status).toBe("completed")
    expect(done.nodes[0]?.result?.payload).toBe("supplement applied")
    expect(done.nodes[0]?.result?.inputRevision).toBe(1)
    expect((await controller.steer(run.runID, "owner", "implement", "fontsource", "interrupted")).state).toBe("delivered")
    expect(dispatches).toBe(1)
  }
}, 1000)

test("restart reconciles a reserved exact-execution request without replaying or restarting the child", async () => {
  const waiting = deferred<void>()
  const admitting = deferred<void>()
  const never = new Promise<never>(() => {})
  const { controller, effect, directory } = setup({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: input.node.id } },
    async admit() {}, async verify() {},
    async steer() { admitting.resolve(); return never },
    async wait() { waiting.resolve(); return never }, async cancel() {},
  })
  const run = await controller.create(graph, "owner")
  await waiting.promise
  const steering = Effect.runFork(effect.steer(run.runID, "owner", "implement", "fontsource", "recovery"))
  await admitting.promise
  const snapshot = await controller.snapshot(run.runID, "owner")
  expect(snapshot.steering?.[0]?.state).toBe("reserved")
  await Effect.runPromise(Fiber.interrupt(steering))
  controller.close()
  controllers.splice(controllers.indexOf(controller), 1)
  const starts: string[] = []
  const reattached: unknown[] = []
  const restored = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise({
    async start(input) { starts.push(input.node.id); return { nodeID: input.node.id, attempt: input.attempt, sessionID: input.node.id } },
    async wait() { return { payload: "reviewed" } }, async cancel() {}, async verify() {},
    async reattach(ref, requests) { reattached.push({ ref, requests }); return { payload: "fontsource applied while offline" } },
    async steer() { throw new Error("must not replay") },
  }) }))
  controllers.push(restored)
  const done = await restored.wait(run.runID, "owner")
  expect(done.nodes[0]?.result?.payload).toBe("fontsource applied while offline")
  expect(starts).toEqual(["review"])
  expect(reattached).toEqual([expect.objectContaining({ requests: [expect.objectContaining({ requestID: "recovery" })] })])
  expect((await restored.snapshot(run.runID, "owner")).steering?.[0]?.state).toBe("delivered")
})

test("a reserved supplement fences idle results until admission and the resulting execution finish", async () => {
  const waiting = deferred<void>()
  const oldResult = deferred<{ payload: string }>()
  const admitting = deferred<void>()
  const receipt = deferred<{ messageID: string }>()
  const steeredResult = deferred<{ payload: string }>()
  const finalWait = deferred<void>()
  const starts: string[] = []
  const targets: unknown[] = []
  const { controller } = setup({
    async start(input) { starts.push(input.node.id); return { nodeID: input.node.id, attempt: input.attempt, sessionID: input.node.id } },
    async admit() {},
    async verify() {},
    async steer(ref, request) { targets.push(ref.identity); admitting.resolve(); return receipt.promise },
    async wait(ref, requests) {
      if (ref.nodeID === "review") return { payload: "reviewed" }
      if (requests?.length) { finalWait.resolve(); return steeredResult.promise }
      waiting.resolve(); return oldResult.promise
    },
    async cancel() {},
  })
  const run = await controller.create(graph, "owner")
  await waiting.promise
  const supplement = controller.steer(run.runID, "owner", "implement", "consider fontsource", "request-1")
  await admitting.promise
  oldResult.resolve({ payload: "stale result" })
  expect((await controller.node(run.runID, "owner", "implement")).runtime?.inputRevision).toBe(1)
  expect(starts).toEqual(["implement"])
  receipt.resolve({ messageID: "msg_supplement" })
  expect((await supplement).state).toBe("admitted")
  await finalWait.promise
  expect(starts).toEqual(["implement"])
  steeredResult.resolve({ payload: "uses fontsource" })
  const done = await controller.wait(run.runID, "owner")
  expect(done.nodes[0]?.result?.payload).toBe("uses fontsource")
  expect(done.nodes[0]?.result?.inputRevision).toBe(1)
  expect(done.nodes[0]?.result?.provenance.agent).toBe("visual-engineering")
  expect(targets).toEqual([expect.objectContaining({ agent: "visual-engineering", model: "test/visual", token: expect.any(String) })])
  expect((await controller.steer(run.runID, "owner", "implement", "consider fontsource", "request-1")).state).toBe("delivered")
  expect(targets).toHaveLength(1)
})

test("native steering keeps the pinned identity and requires a delivered supplement followed by a reply", async () => {
  const identity = { token: "execution-1", agent: "visual-engineering", model: "test/visual#high" }
  const ref: DagExecutionRef = { nodeID: "implement", attempt: 1, sessionID: "ses_child", identity }
  const request: DagSteerRequest = { runID: "run", nodeID: ref.nodeID, execution: ref, generation: 1, revision: 1, requestID: "fontsource", text: "consider fontsource", messageID: "msg_fontsource", state: "reserved", createdAt: 1 }
  const calls: unknown[] = []
  let agent = identity.agent
  let messages: unknown[] = [{ type: "assistant", content: [{ type: "text", text: "old" }] }]
  const runner = createOpenCodeDagRunner({
    location: { directory: "/project" },
    experimental: { generate: { text: () => Effect.succeed({ text: "review" }) } },
    session: {
      get: () => Effect.succeed({ agent, model: { providerID: "test", id: "visual", variant: "high" }, metadata: { iolaus_execution_token: identity.token }, outcome: "succeeded" }),
      synthetic: (input: unknown) => { calls.push(input); return Effect.succeed({ id: request.messageID }) },
      wait: () => Effect.void, context: () => Effect.succeed(messages),
    },
  } as never)
  expect(await Effect.runPromise(runner.steer!(ref, request))).toEqual({ messageID: request.messageID })
  expect(calls).toEqual([expect.objectContaining({ sessionID: "ses_child", id: "msg_fontsource", text: "consider fontsource", delivery: "steer", resume: true })])
  expect(Object.keys(calls[0] as object)).not.toContain("agent")
  expect(Object.keys(calls[0] as object)).not.toContain("model")
  await expect(Effect.runPromise(runner.wait(ref, [request]))).rejects.toThrow("unresolved")
  messages = [...messages, { id: request.messageID, type: "synthetic", text: request.text }]
  await expect(Effect.runPromise(runner.wait(ref, [request]))).rejects.toThrow("unresolved")
  messages.push({ type: "assistant", content: [{ type: "text", text: "fontsource integrated" }] })
  expect((await Effect.runPromise(runner.wait(ref, [request]))).payload).toEqual({ text: "fontsource integrated" })
  agent = "sisyphus"
  await expect(Effect.runPromise(runner.steer!(ref, request))).rejects.toThrow("identity drift")
  expect(calls).toHaveLength(1)
})

test("the host's default variant is the canonical spelling of an omitted variant, not permission to change variants", async () => {
  let variant = "default"
  const ref: DagExecutionRef = { nodeID: "work", attempt: 1, sessionID: "ses_child", identity: { token: "token", agent: "sisyphus", model: "openai/gpt-5.5" } }
  const runner = createOpenCodeDagRunner({ session: {
    get: () => Effect.succeed({ agent: "sisyphus", model: { providerID: "openai", id: "gpt-5.5", variant }, metadata: { iolaus_execution_token: "token" } }),
  } } as never)
  await Effect.runPromise(runner.verify!(ref))
  variant = "high"
  await expect(Effect.runPromise(runner.verify!(ref))).rejects.toThrow("identity drift")
})

test("steering is delegation and planning or Atlas roles cannot use it", () => {
  for (const policy of ["planner", "planning", "atlas-unbound", "atlas-orchestrator"] as const) {
    expect(denial(policy, FLOW_TOOL_NAME, { action: "steer" }, "/project")).toBeDefined()
  }
  expect(denial("worker", FLOW_TOOL_NAME, { action: "steer" }, "/project")).toBeUndefined()
})

test("the tool exposes steering and rejects missing durable request ids before controller admission", async () => {
  const { effect } = setup({ async start() { throw new Error("not called") }, async wait() { throw new Error("not called") }, async cancel() {} })
  const tool = createDagTool(effect)
  expect(tool.input).toEqual(expect.objectContaining({ properties: expect.objectContaining({ action: expect.objectContaining({ enum: expect.arrayContaining(["steer"]) }) }) }))
  const result = await Effect.runPromise(tool.execute!({ action: "steer", run_id: "run", node_id: "implement", text: "fontsource" }, { sessionID: "owner" } as never))
  expect(JSON.parse(String(result.content)).error).toContain("request_id")
})

test("gate and terminal notices refer to committed state and are not sent for observed runs", async () => {
  const gateNotice = deferred<void>()
  const terminalNotice = deferred<void>()
  const notices: string[] = []
  const { controller, effect } = setup({ async start() { throw new Error("not called") }, async wait() { throw new Error("not called") }, async cancel() {} }, {
    notifier: {
      send: (notice) => Effect.promise(async () => {
        const snapshot = await controller.snapshot(notice.runID, "owner")
        const event = snapshot.events.find((event) => event.eventID === notice.eventID)!
        notices.push(event.type)
        if (event.type === "node.waiting") { expect(snapshot.run.nodes[0]?.status).toBe("waiting_approval"); gateNotice.resolve() }
        else { expect(snapshot.run.status).toBe("completed"); terminalNotice.resolve() }
        return { messageID: notice.messageID }
      }),
      reconcile: () => Effect.succeed(undefined),
    },
  })
  const run = await controller.create({ schemaVersion: 1, name: "approval", nodes: [{ id: "accept", kind: "gate", prompt: "Approve?", dependsOn: [] }] }, "owner")
  await gateNotice.promise
  await controller.approve(run.runID, "owner", "accept")
  await terminalNotice.promise
  const observed = await Effect.runPromise(effect.observe({ ownerSessionID: "owner", title: "native", agent: "explore", prompt: "look" }))
  await Effect.runPromise(effect.observed(observed.runID, observed.nodeID, { status: "completed", text: "found" }))
  expect(notices).toEqual(["node.waiting", "run.completed"])
  expect((await controller.snapshot(run.runID, "owner")).notices).toHaveLength(2)
})

test("pre-initial-admission, pending, foreign-owner and live amend requests are refused", async () => {
  const admitting = deferred<void>()
  const initial = deferred<void>()
  const waiting = deferred<void>()
  const never = new Promise<never>(() => {})
  let supplements = 0
  const { controller } = setup({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: "ses_child" } },
    async admit() { admitting.resolve(); await initial.promise }, async verify() {},
    async steer() { supplements++; return { messageID: "msg_new" } },
    async wait() { waiting.resolve(); return never }, async cancel() {},
  })
  const run = await controller.create(graph, "owner")
  await admitting.promise
  expect((await controller.node(run.runID, "owner", "implement")).status).toBe("running")
  await expect(controller.steer(run.runID, "owner", "implement", "fontsource", "early")).rejects.toThrow("initial prompt admission")
  await expect(controller.steer(run.runID, "owner", "review", "fontsource", "pending")).rejects.toThrow("pending")
  await expect(controller.steer(run.runID, "stranger", "implement", "fontsource", "foreign")).rejects.toThrow("another session")
  initial.resolve()
  await waiting.promise
  await expect(controller.amend(run.runID, "owner", graph)).rejects.toThrow("live executions")
  expect(supplements).toBe(0)
})

test("starting, settled, gate, judge, observed and Atlas/authorized-plan targets are refused", async () => {
  const creating = deferred<void>()
  const never = new Promise<never>(() => {})
  const { controller, effect } = setup({
    async start(input) { if (input.node.id === "starting") { creating.resolve(); return never }; return { nodeID: input.node.id, attempt: input.attempt, sessionID: input.node.id } },
    async admit() {}, async verify() {}, async steer() { throw new Error("must not steer") },
    async wait(ref) { if (ref.nodeID === "settled") return { payload: "done" }; return never }, async cancel() {},
  })
  const definitions = [
    { node: { ...graph.nodes[0]!, id: "starting" }, error: "starting" },
    { node: { id: "gate", kind: "gate" as const, prompt: "approve", dependsOn: [] }, error: "gate or judge" },
    { node: { ...graph.nodes[0]!, id: "judge", kind: "judge" as const }, error: "gate or judge" },
    { node: { ...graph.nodes[0]!, id: "atlas", agent: "atlas" }, error: "Atlas" },
    { node: { ...graph.nodes[0]!, id: "settled" }, error: "completed" },
  ]
  for (const { node, error } of definitions) {
    const run = await controller.create({ schemaVersion: 1, name: node.id, nodes: [node] }, "owner")
    if (node.id === "starting") await creating.promise
    if (node.id === "settled") await controller.wait(run.runID, "owner")
    await expect(controller.steer(run.runID, "owner", node.id, "fontsource", node.id)).rejects.toThrow(error)
  }
  const authorized = await Effect.runPromise(effect.create(graph, "owner", "plan"))
  await expect(controller.steer(authorized.runID, "owner", "implement", "fontsource", "plan")).rejects.toThrow("authorized-plan")
  const observed = await Effect.runPromise(effect.observe({ ownerSessionID: "owner", title: "native", agent: "explore", prompt: "look" }))
  await expect(controller.steer(observed.runID, "owner", observed.nodeID, "fontsource", "observed")).rejects.toThrow("observed")
})

test("owner authorization drift during admission keeps the receipt, stops the child and blocks result publication", async () => {
  const waiting = deferred<void>()
  const admitting = deferred<void>()
  const receipt = deferred<{ messageID: string }>()
  const cancelled: string[] = []
  let allowed = true
  const { controller } = setup({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: "ses_child" } },
    async admit() {}, async verify() {},
    async steer() { admitting.resolve(); return receipt.promise },
    async wait() { waiting.resolve(); return new Promise<never>(() => {}) },
    async cancel(ref) { cancelled.push(ref.sessionID) },
  }, { admitSteer: () => allowed ? Effect.void : Effect.fail(new DagValidationError("owner role drift")) })
  const run = await controller.create(graph, "owner")
  await waiting.promise
  const request = controller.steer(run.runID, "owner", "implement", "fontsource", "drift")
  await admitting.promise
  allowed = false
  receipt.resolve({ messageID: "msg_accepted" })
  const result = await request
  expect(result.state).toBe("unresolved")
  expect(result.receipt).toEqual({ messageID: "msg_accepted" })
  expect(result.error).toContain("owner role drift")
  expect((await controller.wait(run.runID, "owner")).nodes.map((node) => node.status)).toEqual(["interrupted", "blocked"])
  expect(cancelled).toEqual(["ses_child"])
  await expect(controller.retry(run.runID, "owner", "implement")).rejects.toThrow("steered execution")
  await expect(controller.amend(run.runID, "owner", graph)).rejects.toThrow("unresolved steering")
})

test("notices use queued non-resuming synthetic input and reconcile by the stable event message id", async () => {
  const calls: unknown[] = []
  const notice = { eventID: "event", runID: "run", ownerSessionID: "ses_owner", messageID: "msg_event", text: "completed", state: "pending" as const }
  const notifier = createOpenCodeDagNotifier({
    synthetic: (input: unknown) => { calls.push(input); return Effect.succeed({ id: notice.messageID }) },
    context: () => Effect.succeed([{ id: notice.messageID, type: "synthetic", text: notice.text }]),
  } as never)
  expect(await Effect.runPromise(notifier.send(notice))).toEqual({ messageID: "msg_event" })
  expect(await Effect.runPromise(notifier.reconcile(notice))).toEqual({ messageID: "msg_event" })
  expect(calls).toEqual([{ sessionID: "ses_owner", id: "msg_event", text: "completed", delivery: "queue", resume: false, metadata: { iolaus_flow_notice: "event", iolaus_dag_run: "run" } }])
})

test("same request ids are idempotent while in flight and cannot change node or text", async () => {
  const waiting = deferred<void>()
  const admitting = deferred<void>()
  const receipt = deferred<{ messageID: string }>()
  const never = new Promise<never>(() => {})
  let sent = 0
  const { controller } = setup({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: input.node.id } },
    async admit() {}, async verify() {}, async steer() { sent++; admitting.resolve(); return receipt.promise },
    async wait() { waiting.resolve(); return never }, async cancel() {},
  })
  const run = await controller.create(graph, "owner")
  await waiting.promise
  const first = controller.steer(run.runID, "owner", "implement", "fontsource", "same")
  await admitting.promise
  expect((await controller.steer(run.runID, "owner", "implement", "fontsource", "same")).state).toBe("reserved")
  await expect(controller.steer(run.runID, "owner", "implement", "different", "same")).rejects.toThrow("different steering request")
  await expect(controller.steer(run.runID, "owner", "review", "fontsource", "same")).rejects.toThrow("different steering request")
  receipt.resolve({ messageID: "msg_receipt" })
  await first
  expect(sent).toBe(1)
})

test("cancellation serializes with admission, and a late result cannot reopen the cancelled execution", async () => {
  const waiting = deferred<void>()
  const admitting = deferred<void>()
  const receipt = deferred<{ messageID: string }>()
  const result = deferred<{ payload: string }>()
  const order: string[] = []
  const { controller } = setup({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: "ses_child" } },
    async admit() {}, async verify() {},
    async steer() { order.push("admitting"); admitting.resolve(); const value = await receipt.promise; order.push("admitted"); return value },
    async wait() { waiting.resolve(); return result.promise }, async cancel() { order.push("cancelled") },
  })
  const run = await controller.create(graph, "owner")
  await waiting.promise
  const steering = controller.steer(run.runID, "owner", "implement", "fontsource", "cancel-race")
  await admitting.promise
  const cancel = controller.cancel(run.runID, "owner")
  receipt.resolve({ messageID: "msg_receipt" })
  await steering
  await cancel
  result.resolve({ payload: "late" })
  expect(order).toEqual(["admitting", "admitted", "cancelled"])
  const done = await controller.wait(run.runID, "owner")
  expect(done.status).toBe("cancelled")
  expect(done.nodes[0]?.result).toBeUndefined()
  await expect(controller.retry(run.runID, "owner")).rejects.toThrow("steered execution")
  await expect(controller.resume(run.runID, "owner")).rejects.toThrow("steered execution")
  expect((await controller.snapshot(run.runID, "owner")).run.status).toBe("cancelled")
})

test("retry allocates a new immutable token and rejects an old start even when it returns after the new result", async () => {
  const creating = deferred<void>()
  const release = deferred<void>()
  const cancelled = deferred<void>()
  const tokens: string[] = []
  const waits: string[] = []
  const { controller } = setup({
    async start(input) {
      tokens.push(input.identity!.token)
      if (input.attempt === 1) { creating.resolve(); await release.promise }
      return { nodeID: input.node.id, attempt: input.attempt, sessionID: `ses_${input.attempt}` }
    },
    async wait(ref) { waits.push(ref.sessionID); return { payload: "new result" } },
    async cancel(ref) { if (ref.sessionID === "ses_1") cancelled.resolve() },
  })
  const run = await controller.create({ ...graph, nodes: [graph.nodes[0]!] }, "owner")
  await creating.promise
  await controller.cancel(run.runID, "owner")
  await controller.retry(run.runID, "owner", "implement")
  await controller.wait(run.runID, "owner")
  release.resolve()
  await cancelled.promise
  expect(tokens).toHaveLength(2)
  expect(tokens[0]).not.toBe(tokens[1])
  expect(waits).toEqual(["ses_2"])
  expect((await controller.node(run.runID, "owner", "implement")).execution?.sessionID).toBe("ses_2")
})

test("execution identity is checked again at finalization and drift cannot trigger automatic retry", async () => {
  const waiting = deferred<void>()
  const result = deferred<{ payload: string }>()
  let drift = false
  let starts = 0
  const { controller } = setup({
    async start(input) { starts++; return { nodeID: input.node.id, attempt: input.attempt, sessionID: "ses_child" } },
    async admit() {}, async verify() { if (drift) throw new DagRunnerError({ message: "identity drift", nonRetryable: true }) },
    async wait() { waiting.resolve(); return result.promise }, async cancel() {},
  })
  const run = await controller.create({ ...graph, nodes: [{ ...graph.nodes[0]!, maxAttempts: 3 }] }, "owner")
  await waiting.promise
  drift = true
  result.resolve({ payload: "wrong agent result" })
  const done = await controller.wait(run.runID, "owner")
  expect(done.status).toBe("failed")
  expect(done.nodes[0]?.error).toContain("identity drift")
  expect(done.nodes[0]?.result).toBeUndefined()
  expect(starts).toBe(1)
})

test("steering rechecks live owner permissions and sticky planning roles instead of bypassing native delegation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "iolaus-steer-policy-"))
  directories.push(directory)
  const state = new SessionStateStore(join(directory, "state.db"))
  let permission: "allow" | "deny" | "ask" = "allow"
  const host = {
    session: { get: () => Effect.succeed({ agent: "sisyphus", location: { directory }, permissions: [] }) },
    agent: { get: () => Effect.succeed({ data: { permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "subagent", resource: "visual-engineering", effect: permission }] } }) },
  }
  const node = { definition: graph.nodes[0]!, fingerprint: "fingerprint", status: "running" as const, attempt: 1 }
  try {
    await Effect.runPromise(admitSteering(host as never, state, "owner", node))
    for (const value of ["deny", "ask"] as const) {
      permission = value
      await expect(Effect.runPromise(admitSteering(host as never, state, "owner", node))).rejects.toThrow("delegation permission")
    }
    permission = "allow"
    state.save("role", "owner", { role: "planning" })
    await expect(Effect.runPromise(admitSteering(host as never, state, "owner", node))).rejects.toThrow("Planning sessions")
  } finally { state.close() }
})

test("an ambiguous initial admission cannot automatically retry or replay through retry/amend", async () => {
  let starts = 0
  let cancelled = 0
  const { controller } = setup({
    async start(input) { starts++; return { nodeID: input.node.id, attempt: input.attempt, sessionID: "ses_child" } },
    async admit() { throw new Error("receipt connection lost") },
    async wait() { return { payload: "must not publish" } }, async cancel() { cancelled++ },
  })
  const run = await controller.create({ ...graph, nodes: [{ ...graph.nodes[0]!, maxAttempts: 3 }] }, "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.nodes[0]?.runtime?.initial).toBe("unresolved")
  expect(done.nodes[0]?.result).toBeUndefined()
  expect(starts).toBe(1)
  expect(cancelled).toBe(1)
  await expect(controller.retry(run.runID, "owner")).rejects.toThrow("unresolved")
  await expect(controller.amend(run.runID, "owner", graph)).rejects.toThrow("unresolved")
})

test.each([true, false])("notice recovery reconciles a stable id without replay when host evidence is visible: %s", async (visible) => {
  const sending = deferred<string>()
  const idleRunner: DagRunnerPromise = { async start() { throw new Error("not called") }, async wait() { throw new Error("not called") }, async cancel() {} }
  const { controller, directory } = setup(idleRunner, { notifier: {
    send: (notice) => Effect.gen(function* () { sending.resolve(notice.messageID); return yield* Effect.never }),
    reconcile: () => Effect.succeed(undefined),
  } })
  const run = await controller.create({ schemaVersion: 1, name: "gate", nodes: [{ id: "gate", kind: "gate", prompt: "approve", dependsOn: [] }] }, "owner")
  const messageID = await sending.promise
  controller.close()
  controllers.splice(controllers.indexOf(controller), 1)
  const reconciled = deferred<string>()
  let sends = 0
  const restored = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(idleRunner), notifier: {
    send: (notice) => Effect.sync(() => { sends++; return { messageID: notice.messageID } }),
    reconcile: (notice) => Effect.sync(() => { reconciled.resolve(notice.messageID); return visible ? { messageID: notice.messageID } : undefined }),
  } }))
  controllers.push(restored)
  expect(await reconciled.promise).toBe(messageID)
  expect(sends).toBe(0)
  expect((await restored.snapshot(run.runID, "owner")).notices?.[0]).toEqual(expect.objectContaining({ messageID, state: visible ? "admitted" : "unresolved" }))
})

test("additive runtime persistence preserves and recovers a legacy unpinned execution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "iolaus-legacy-steering-"))
  directories.push(directory)
  const path = join(directory, "state.db")
  const store = new DagStore(path, directory)
  const definition = { ...graph, nodes: [graph.nodes[0]!] }
  store.createRun({ runID: "legacy", ownerSessionID: "owner", name: "legacy", definition, fingerprint: graphFingerprint(definition), generation: 1, status: "running", createdAt: 1, updatedAt: 1,
    nodes: [{ definition: definition.nodes[0]!, fingerprint: nodeFingerprint(definition.nodes[0]!), status: "running", attempt: 1, execution: { nodeID: "implement", attempt: 1, sessionID: "ses_legacy" } }] })
  store.close()
  const returning = deferred<{ payload: string }>()
  let starts = 0
  const controller = promiseController(createDagController({ directory, databasePath: path, runner: runnerFromPromise({
    async start() { starts++; throw new Error("must not restart") }, async wait() { throw new Error("must reattach") },
    async reattach() { return returning.promise }, async cancel() {}, async admit() {}, async verify() {}, async steer() { throw new Error("unpinned") },
  }) }))
  controllers.push(controller)
  await expect(controller.steer("legacy", "owner", "implement", "fontsource", "new")).rejects.toThrow("legacy unpinned")
  returning.resolve({ payload: "legacy result" })
  const done = await controller.wait("legacy", "owner")
  expect(done.nodes[0]?.result?.payload).toBe("legacy result")
  expect(done.nodes[0]?.execution?.sessionID).toBe("ses_legacy")
  expect(starts).toBe(0)
})

test("amend invalidates steered outputs and their descendants but preserves unrelated reuse", async () => {
  const waiting = deferred<void>()
  let amended = false
  const starts: string[] = []
  const { controller } = setup({
    async start(input) { starts.push(input.node.id); return { nodeID: input.node.id, attempt: input.attempt, sessionID: input.node.id } },
    async admit() {}, async verify() {}, async steer(_ref, request) { return { messageID: request.messageID } },
    async wait(ref, requests) {
      if (ref.nodeID !== "implement" || requests?.length || amended) return { payload: "done" }
      waiting.resolve(); return new Promise<never>(() => {})
    }, async cancel() {},
  })
  const definition = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0]!, id: "independent" }] }
  const run = await controller.create(definition, "owner")
  await waiting.promise
  await controller.steer(run.runID, "owner", "implement", "fontsource", "amend")
  await controller.wait(run.runID, "owner")
  amended = true
  await controller.amend(run.runID, "owner", definition)
  await controller.wait(run.runID, "owner")
  expect(starts.filter((id) => id === "implement")).toHaveLength(2)
  expect(starts.filter((id) => id === "review")).toHaveLength(2)
  expect(starts.filter((id) => id === "independent")).toHaveLength(1)
})

test("recovery preserves an admitted receipt but stops downstream when host delivery cannot be established", async () => {
  const waiting = deferred<void>()
  const never = new Promise<never>(() => {})
  const { controller, directory } = setup({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: "ses_child" } },
    async admit() {}, async verify() {}, async steer() { return { messageID: "msg_admitted" } },
    async wait() { waiting.resolve(); return never }, async cancel() {},
  })
  const run = await controller.create(graph, "owner")
  await waiting.promise
  await controller.steer(run.runID, "owner", "implement", "fontsource", "uncertain")
  controller.close()
  controllers.splice(controllers.indexOf(controller), 1)
  const restored = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise({
    async start() { throw new Error("must not replay original") }, async wait() { throw new Error("must reattach") },
    async reattach() { return undefined }, async cancel() {}, async steer() { throw new Error("must not replay supplement") },
  }) }))
  controllers.push(restored)
  const done = await restored.wait(run.runID, "owner")
  expect(done.nodes.map((node) => node.status)).toEqual(["interrupted", "blocked"])
  expect(done.nodes[0]?.result).toBeUndefined()
  expect((await restored.snapshot(run.runID, "owner")).steering?.[0]).toEqual(expect.objectContaining({ state: "unresolved", receipt: { messageID: "msg_admitted" } }))
})
