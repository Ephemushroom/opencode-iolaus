import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { createDagController, type DagControllerOptions } from "../src/dag/controller"
import { promiseController } from "../src/dag/promise"
import { createOpenCodeDagRunner, runnerFromPromise, type DagRunnerPromise, type DagRunnerStart } from "../src/dag/runner"
import { DagRunnerError } from "../src/dag/errors"
import type { DagDefinition, DagExecutionRef, DagSteerRequest } from "../src/dag/types"

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const flow = (extra: Record<string, unknown> = {}): DagDefinition => ({ schemaVersion: 1, name: "rescue", nodes: [
  { id: "work", agent: "deep-low", model: "a/one", fallbackModels: ["b/two"], prompt: "task", dependsOn: [], ...extra },
] })

const providerFailure = (model: string) => new DagRunnerError({ message: `provider failed on ${model}`, model: true })

/** A runner that continues sessions; `reply` decides each attempt's outcome by its model. */
function setup(reply: (start: DagRunnerStart) => string | Error, options: Partial<DagControllerOptions> = {}, owner = "o/owner") {
  const starts: DagRunnerStart[] = []
  const ownerCalls: string[] = []
  const pending = new Map<string, DagRunnerStart>()
  let sessions = 0
  const runner: DagRunnerPromise = {
    continues: true,
    async ownerModel(session) { ownerCalls.push(session); return owner },
    async start(input) {
      starts.push(input)
      const sessionID = input.continueFrom?.sessionID ?? `s${++sessions}`
      pending.set(input.identity!.token, input)
      return { nodeID: input.node.id, attempt: input.attempt, sessionID }
    },
    async wait(ref) { const out = reply(pending.get(ref.identity!.token)!); if (out instanceof Error) throw out; return { payload: { text: out } } },
    async cancel() {},
  }
  const directory = mkdtempSync(join(tmpdir(), "iolaus-rescue-"))
  directories.push(directory)
  const controller = promiseController(createDagController({ directory, databasePath: join(directory, "state.db"), runner: runnerFromPromise(runner), ...options }))
  return { controller, starts, ownerCalls }
}

const events = async (controller: ReturnType<typeof setup>["controller"], runID: string, type: string) =>
  (await controller.snapshot(runID, "owner")).events.filter((event) => event.type === type).map((event) => event.payload)

test("a model fallback continues the failed child session on the next model", async () => {
  const { controller, starts } = setup((start) => start.node.model === "a/one" ? providerFailure("a/one") : "done on b")
  const run = await controller.create(flow(), "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.status).toBe("completed")
  expect(starts.map((start) => [start.node.model, start.continueFrom?.sessionID])).toEqual([["a/one", undefined], ["b/two", "s1"]])
  expect(done.nodes[0]!.result?.provenance).toMatchObject({ model: "b/two", execution: expect.objectContaining({ sessionID: "s1" }) })
  expect(await events(controller, run.runID, "node.fallback")).toEqual([expect.objectContaining({ from: "a/one", to: "b/two", continued: true })])
  expect(done.nodes[0]!.recovery?.continueFrom).toBeUndefined()
})

test("remaining attempts on the last model continue the same session too", async () => {
  let failures = 2
  const { controller, starts } = setup((start) => failures-- > 0 ? providerFailure(start.node.model!) : "done")
  const run = await controller.create(flow({ maxAttempts: 3 }), "owner")
  expect((await controller.wait(run.runID, "owner")).status).toBe("completed")
  expect(starts.map((start) => [start.node.model, start.continueFrom?.sessionID])).toEqual([["a/one", undefined], ["b/two", "s1"], ["b/two", "s1"]])
})

test("default-off never consults the owner model once fallbacks and attempts are spent", async () => {
  const { controller, starts, ownerCalls } = setup((start) => providerFailure(start.node.model!))
  const run = await controller.create(flow(), "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.status).toBe("failed")
  expect(starts).toHaveLength(2)
  expect(ownerCalls).toEqual([])
  expect(await events(controller, run.runID, "node.rescued")).toEqual([])
})

test("the one owner-model rescue switches the same session to the owner's model after the chain is spent", async () => {
  const { controller, starts, ownerCalls } = setup((start) => start.node.model === "o/owner" ? "rescued" : providerFailure(start.node.model!), { rescue: { ownerModel: true } })
  const run = await controller.create(flow(), "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.status).toBe("completed")
  expect(ownerCalls).toEqual(["owner"])
  expect(starts.map((start) => [start.node.agent, start.node.model, start.continueFrom?.sessionID])).toEqual([["deep-low", "a/one", undefined], ["deep-low", "b/two", "s1"], ["deep-low", "o/owner", "s1"]])
  const rescued = await events(controller, run.runID, "node.rescued")
  expect(rescued).toEqual([expect.objectContaining({ from: "b/two", to: "o/owner", continued: true })])
  expect(done.nodes[0]!.result?.provenance.rescue).toEqual({ decisionID: (rescued[0] as { decisionID: string }).decisionID, model: "o/owner", from: "b/two" })
  expect(done.nodes[0]!.recovery?.rescue?.settled).toBe(true)
})

test("a rescue is spent once per node lifetime, across explicit retries", async () => {
  const { controller, starts } = setup((start) => providerFailure(start.node.model!), { rescue: { ownerModel: true } })
  const run = await controller.create(flow(), "owner")
  expect((await controller.wait(run.runID, "owner")).status).toBe("failed")
  expect(starts.map((start) => start.node.model)).toEqual(["a/one", "b/two", "o/owner"])
  await controller.retry(run.runID, "owner", "work")
  const again = await controller.wait(run.runID, "owner")
  expect(again.status).toBe("failed")
  // The retry restarts from the planned chain in a fresh session; the owner model is not offered again.
  expect(starts.slice(3).map((start) => [start.node.model, start.continueFrom?.sessionID])).toEqual([["a/one", undefined], ["b/two", "s2"]])
  expect(await events(controller, run.runID, "node.rescue-skipped")).toEqual([{ reason: "owner_rescue_spent" }])
})

test("an owner model that already failed on the node is not used for rescue", async () => {
  const { controller, starts } = setup((start) => providerFailure(start.node.model!), { rescue: { ownerModel: true } }, "b/two#default")
  const run = await controller.create(flow(), "owner")
  expect((await controller.wait(run.runID, "owner")).status).toBe("failed")
  expect(starts).toHaveLength(2)
  expect(await events(controller, run.runID, "node.rescue-skipped")).toEqual([{ reason: "owner_model_already_failed" }])
})

test("non-model failures, planning roles and Atlas flows never reserve a rescue", async () => {
  const tool = setup(() => new DagRunnerError({ message: "tool error" }), { rescue: { ownerModel: true } })
  const run = await tool.controller.create(flow({ fallbackModels: [] }), "owner")
  expect((await tool.controller.wait(run.runID, "owner")).status).toBe("failed")
  expect(tool.ownerCalls).toEqual([])

  const planning = setup((start) => providerFailure(start.node.model!), { rescue: { ownerModel: true }, rescueRoleAllowed: (session) => Effect.succeed(session !== "owner") })
  const planned = await planning.controller.create(flow(), "owner")
  expect((await planning.controller.wait(planned.runID, "owner")).status).toBe("failed")
  expect(await events(planning.controller, planned.runID, "node.rescue-skipped")).toEqual([{ reason: "rescue_role_excluded" }])
  expect(planning.ownerCalls).toEqual([])
})

test("a rescued reply asking for escalation is the result, not another rerun", async () => {
  const { controller, starts } = setup((start) => start.node.model === "o/owner" ? "found it\nESCALATE: deep-high" : providerFailure(start.node.model!), { rescue: { ownerModel: true }, defaultModel: () => "x/high" })
  const run = await controller.create(flow(), "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.status).toBe("completed")
  expect(starts).toHaveLength(3)
  expect(done.nodes[0]!.definition.agent).toBe("deep-low")
})

test("without a continuable session a fallback starts fresh, as before", async () => {
  const { controller, starts } = setup((start) => start.node.model === "a/one" ? providerFailure("a/one") : "done")
  const run = await controller.create({ ...flow(), nodes: [{ ...flow().nodes[0]!, kind: "judge" }] }, "owner")
  expect((await controller.wait(run.runID, "owner")).status).toBe("completed")
  expect(starts.map((start) => start.continueFrom)).toEqual([undefined, undefined])
})

// Native runner: the same-session switch against a fake host.
function host(options: { agent?: string; outcome?: string } = {}) {
  const calls: Array<[string, unknown]> = []
  let model = { providerID: "a", id: "one" }
  let metadata: Record<string, unknown> = { iolaus_execution_token: "t1", iolaus_dag_node: "work" }
  let outcome = options.outcome ?? "failed"
  const session = {
    create: (input: unknown) => { calls.push(["create", input]); return Effect.succeed({ id: "fresh" }) },
    get: () => Effect.succeed({ agent: options.agent ?? "deep-low", model, metadata, outcome }),
    switchModel: (input: { model: typeof model }) => { calls.push(["switchModel", input]); model = input.model; return Effect.void },
    update: (input: { metadata: Record<string, unknown> }) => { calls.push(["update", input]); metadata = input.metadata; return Effect.void },
    prompt: (input: unknown) => { calls.push(["prompt", input]); outcome = "succeeded"; return Effect.succeed({}) },
    wait: () => Effect.void,
    context: () => Effect.succeed([{ type: "user", id: "msg_t2" }, { type: "assistant", content: [{ type: "text", text: "continued" }] }]),
    synthetic: () => Effect.die("unused"), interrupt: () => Effect.void,
  }
  return { calls, runner: createOpenCodeDagRunner({ session, generate: { text: () => Effect.die("unused") }, location: { directory: "/project" } } as never) }
}
const from: DagExecutionRef = { nodeID: "work", attempt: 1, sessionID: "ses_child", identity: { token: "t1", agent: "deep-low", model: "a/one" } }
const next = (node = {}): DagRunnerStart => ({ node: { id: "work", agent: "deep-low", model: "b/two#high", prompt: "task", dependsOn: [], ...node }, prompt: "task", attempt: 2, identity: { token: "t2", agent: "deep-low", model: "b/two#high" }, continueFrom: from })

test("the native runner continues a failed session by switching its model and queuing a continue prompt", async () => {
  const { calls, runner } = host()
  expect(runner.continues).toBe(true)
  const ref = await Effect.runPromise(runner.start(next()))
  expect(ref).toEqual({ nodeID: "work", attempt: 2, sessionID: "ses_child", identity: next().identity })
  expect(calls.map(([name]) => name)).toEqual(["switchModel", "update"])
  expect(calls[0]![1]).toEqual({ sessionID: "ses_child", model: expect.objectContaining({ providerID: "b", id: "two", variant: "high" }) })
  expect(calls[1]![1]).toEqual({ sessionID: "ses_child", metadata: { iolaus_dag_node: "work", iolaus_dag_attempt: 2, iolaus_execution_token: "t2" } })
  expect((await Effect.runPromise(runner.wait(ref))).payload).toEqual({ text: "continued" })
  const prompt = calls.find(([name]) => name === "prompt")![1] as { id: string; text: string; delivery: string }
  expect(prompt).toMatchObject({ sessionID: "ses_child", id: "msg_t2", delivery: "queue" })
  expect(prompt.text).toContain('<iolaus-continuation from="a/one" to="b/two#high">')
  expect(calls.some(([name]) => name === "create")).toBe(false)
})

test("the native runner refuses to continue a session that changed agent, execution or did not end", async () => {
  await expect(Effect.runPromise(host({ agent: "sisyphus" }).runner.start(next()))).rejects.toThrow("changed agent or execution")
  await expect(Effect.runPromise(host().runner.start({ ...next(), continueFrom: { ...from, identity: { ...from.identity!, token: "other" } } }))).rejects.toThrow("changed agent or execution")
  await expect(Effect.runPromise(host({ outcome: "interrupted" }).runner.start(next()))).rejects.toThrow("ended interrupted")
})

test("a failed turn after a delivered supplement is a model failure that names the delivered requests", async () => {
  const request: DagSteerRequest = { runID: "run", nodeID: "work", requestID: "r1", text: "fontsource", execution: from, generation: 1, revision: 1, messageID: "msg_r1", state: "admitted", receipt: { messageID: "msg_r1" }, createdAt: 1 }
  const runner = createOpenCodeDagRunner({ location: { directory: "/project" }, generate: { text: () => Effect.die("unused") }, session: {
    get: () => Effect.succeed({ agent: "deep-low", model: { providerID: "a", id: "one" }, metadata: { iolaus_execution_token: "t1" }, outcome: "failed" }),
    wait: () => Effect.void, context: () => Effect.succeed([{ type: "user", id: "msg_t1" }, { type: "synthetic", id: "msg_r1", text: "fontsource" }]),
  } } as never)
  const error = await Effect.runPromise(Effect.flip(runner.wait(from, [request])))
  expect(error).toMatchObject({ model: true, deliveredRequests: ["r1"] })
})
