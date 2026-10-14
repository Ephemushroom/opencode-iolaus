import { afterEach, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Schema } from "effect"
import { Agent, Model, Provider } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { Location } from "@opencode/schema/location"
import { Permission } from "@opencode/schema/permission"
import { AbsolutePath } from "@opencode/schema/schema"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionApi } from "@opencode/client/effect/api"
import { createOpenCodeDagRunner, type DagRunnerStart } from "../src/dag/runner"
import { createDagController } from "../src/dag/controller"
import { promiseController } from "../src/dag/promise"
import type { DagDefinition, DagSteerRequest } from "../src/dag/types"
import { recoveryTerminal } from "../src/dag/rescue"
import { SessionStateStore } from "../src/database"
import { admitSteering, rescueRoleAllowed } from "../src/roles/steering"
import { saveRole } from "../src/roles/register"
import { admitTier, tierSource } from "../src/roles/tier"
import { DagValidationError } from "../src/dag/errors"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const run = <Value, Error>(effect: Effect.Effect<Value, Error>) => Effect.runPromise(effect)
const message = Schema.decodeUnknownSync(SessionMessage.Info)

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "iolaus-rescue-host-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
  const sessions = new Map<string, Session.Info>()
  const histories = new Map<string, SessionMessage.Info[]>()
  const pending = new Map<string, readonly SessionInbox.Info[]>()
  const prompts: Array<{ sessionID: string; text: string }> = []
  const creates: Array<Parameters<Context["session"]["create"]>[0]> = []
  let models: Model.Info[] = ["A", "B", "C", "owner"].map((id) => Model.Info.default(Provider.ID.make("test"), Model.ID.make(id)))
  let lane: Agent.Info = Agent.Info.default(Agent.ID.make("quick"))
  const info = (id: string, input: Partial<Session.Info> = {}) => Schema.decodeUnknownSync(Session.Info)({ id, projectID: "project", agent: "quick", model: { providerID: "test", id: "A" }, location: { directory }, permissions: [{ action: "edit", resource: "*.env", effect: "deny" }], cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, ...input })
  sessions.set("ses_owner", info("ses_owner", { model: Model.Ref.parse("test/owner") }))
  const session: Pick<Context["session"], "create" | "get" | "context" | "wait" | "prompt" | "synthetic" | "interrupt"> & { inbox: Pick<SessionApi<unknown>["inbox"], "list"> } = {
    create: (input) => Effect.sync(() => {
      const id = `ses_child${creates.length + 1}`
      creates.push(input)
      const value = info(id, { ...(input?.agent ? { agent: input.agent } : {}), ...(input?.model ? { model: input.model } : {}), ...(input?.metadata ? { metadata: input.metadata } : {}), ...(input?.permissions ? { permissions: input.permissions } : {}) })
      sessions.set(id, value); histories.set(id, [])
      return value
    }),
    get: ({ sessionID }) => sessions.has(sessionID) ? Effect.succeed(sessions.get(sessionID)!) : Effect.fail(new Error("missing session")),
    context: ({ sessionID }) => Effect.sync(() => histories.get(sessionID) ?? []),
    wait: () => Effect.void,
    interrupt: () => Effect.succeed({ interrupted: true }),
    prompt: (input) => Effect.sync(() => {
      prompts.push({ sessionID: input.sessionID, text: input.text })
      const item = Schema.decodeUnknownSync(SessionInbox.User)({ id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: 2 } })
      histories.set(input.sessionID, [message({ id: input.id, type: "user", text: input.text, time: { created: 2 } })])
      return item
    }),
    synthetic: (input) => Effect.sync(() => {
      histories.get(input.sessionID)!.push(message({ id: input.id, type: "synthetic", text: input.text, metadata: input.metadata, time: { created: 3 } }))
      return Schema.decodeUnknownSync(SessionInbox.Synthetic)({ id: input.id, sessionID: input.sessionID, type: "synthetic", payload: { text: input.text }, delivery: "steer", time: { created: 3 } })
    }),
    inbox: { list: ({ sessionID }) => Effect.sync(() => pending.get(sessionID) ?? []) },
  }
  const ctx = { session, location, generate: { text: () => Effect.succeed({ text: "judge" }) },
    agent: { get: () => Effect.succeed({ location, data: lane }) },
    model: { list: () => Effect.succeed({ location, data: models }) },
    permission: { list: () => Effect.succeed([]) },
  } satisfies Parameters<typeof createOpenCodeDagRunner>[0]
  const runner = createOpenCodeDagRunner(ctx, { ownerModel: true })
  const input: DagRunnerStart = { runID: "run", node: { id: "work", agent: "quick", model: "test/A", prompt: "task", dependsOn: [] }, prompt: "task with bound upstream inputs", attempt: 1, identity: { token: "token-one", agent: "quick", model: "test/A" } }
  const finish = (sessionID: string, type = "provider.auth", content: unknown[] = []) => {
    const current = sessions.get(sessionID)!
    sessions.set(sessionID, { ...current, outcome: "failed" })
    histories.get(sessionID)!.push(message({ id: `msg_assistant${sessionID}`, type: "assistant", agent: current.agent, model: current.model, content, time: { created: 4, completed: 5 } }), message({ id: `msg_idle${sessionID}`, type: "idle", outcome: "failed", error: { type, message: "provider unavailable" }, time: { created: 6 } }))
  }
  return { directory, ctx, runner, input, sessions, histories, pending, prompts, creates, finish,
    setModels: (value: typeof models) => { models = value }, models: () => models,
    setLane: (value: typeof lane) => { lane = value }, lane: () => lane }
}

const successfulPatch = { type: "tool", id: "patch1", name: "patch", executed: false,
  state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Add File: draft.txt\n+draft\n*** End Patch" }, content: [{ type: "text", text: "Created draft.txt" }] },
  time: { created: 3, ran: 4, completed: 5 } }

function judgeController(generate: Context["generate"]["text"]) {
  const host = fixture()
  const sessionAccess = mock(() => Effect.die(new Error("A judge must not access sessions or rescue inspection")))
  const session = { create: sessionAccess, get: sessionAccess, context: sessionAccess, wait: sessionAccess, prompt: sessionAccess, synthetic: sessionAccess, interrupt: sessionAccess, inbox: { list: sessionAccess } }
  const runner = createOpenCodeDagRunner({
    location: host.ctx.location,
    generate: { text: generate },
    session,
    agent: { get: sessionAccess }, model: { list: sessionAccess }, permission: { list: sessionAccess },
  }, { ownerModel: true })
  const controller = promiseController(createDagController({ directory: host.directory, databasePath: join(host.directory, "state.db"), runner, rescue: { ownerModel: true } }))
  cleanups.push(() => controller.close())
  return { controller, sessionAccess }
}

test("sessionless judge completion remains amendable and retryable without session inspection", async () => {
  const prompts: string[] = []
  const { controller, sessionAccess } = judgeController((input) => Effect.sync(() => {
    prompts.push(input.prompt)
    return { text: "VERDICT: PASS" }
  }))
  const definition: DagDefinition = { schemaVersion: 1, name: "judge review", nodes: [{ id: "review", kind: "judge", agent: "momus", model: "test/A", prompt: "Review original task", dependsOn: [] }] }
  const created = await controller.create(definition, "ses_owner")
  const done = await controller.wait(created.runID, "ses_owner")
  expect(done.status).toBe("completed")
  expect(done.nodes[0]?.result?.payload).toEqual({ text: "VERDICT: PASS" })
  expect(done.nodes[0]?.execution?.sessionID).toStartWith("judge:")
  const amended: DagDefinition = { ...definition, nodes: [{ ...definition.nodes[0]!, prompt: "Review amended task" }] }
  await controller.amend(created.runID, "ses_owner", amended)
  expect((await controller.wait(created.runID, "ses_owner")).status).toBe("completed")
  await controller.retry(created.runID, "ses_owner", "review")
  const retried = await controller.wait(created.runID, "ses_owner")
  expect(retried.status).toBe("completed")
  expect(retried.nodes[0]?.attempt).toBe(2)
  expect(retried.nodes[0]?.recovery?.blocked).toBeUndefined()
  expect(retried.nodes[0]?.recovery?.handoff).toBeUndefined()
  expect(retried.nodes[0]?.recovery?.rescue).toBeUndefined()
  expect(prompts).toEqual(["Review original task", "Review amended task", "Review amended task"])
  expect(sessionAccess).not.toHaveBeenCalled()
})

test.each([
  { maxAttempts: 1, models: ["A", "B", "C"] },
  { maxAttempts: 5, models: ["A", "B", "C", "C", "C"] },
])("sessionless judge failures exhaust fallbacks and maxAttempts=$maxAttempts without owner rescue", async ({ maxAttempts, models }) => {
  const calls: string[] = []
  const { controller, sessionAccess } = judgeController((input) => Effect.suspend(() => {
    calls.push(String(input.model?.id))
    return Effect.fail(new Error("provider unavailable"))
  }))
  const definition: DagDefinition = { schemaVersion: 1, name: "failed judge", nodes: [{ id: "review", kind: "judge", agent: "momus", model: "test/A", fallbackModels: ["test/B", "test/C"], maxAttempts, prompt: "Review task", dependsOn: [] }] }
  const created = await controller.create(definition, "ses_owner")
  const done = await controller.wait(created.runID, "ses_owner")
  expect(done.status).toBe("failed")
  expect(calls).toEqual([...models])
  expect(done.nodes[0]?.attempt).toBe(models.length)
  expect(done.nodes[0]?.recovery?.blocked).toBeUndefined()
  expect(done.nodes[0]?.recovery?.handoff).toBeUndefined()
  expect(done.nodes[0]?.recovery?.rescue).toBeUndefined()
  expect(done.nodes[0]?.error).toBe("provider unavailable")
  await controller.retry(created.runID, "ses_owner", "review")
  expect((await controller.wait(created.runID, "ses_owner")).status).toBe("failed")
  expect(calls.slice(models.length)).toEqual(["A", "B", "C"])
  const snapshot = await controller.snapshot(created.runID, "ses_owner")
  expect(snapshot.events.filter((event) => event.type === "node.fallback")).toHaveLength(4)
  expect(snapshot.events.filter((event) => event.type === "node.rescued" || event.type === "node.rescue-skipped")).toHaveLength(0)
  expect(sessionAccess).not.toHaveBeenCalled()
})

test("owner rescue leaves gate approval and retry outside session inspection", async () => {
  const generate = mock(() => Effect.succeed({ text: "unused" }))
  const { controller, sessionAccess } = judgeController(generate)
  const definition: DagDefinition = { schemaVersion: 1, name: "gate only", nodes: [{ id: "accept", kind: "gate", prompt: "Approve?", dependsOn: [] }] }
  const created = await controller.create(definition, "ses_owner")
  expect(created.status).toBe("paused")
  expect(created.nodes[0]?.status).toBe("waiting_approval")
  await controller.approve(created.runID, "ses_owner", "accept")
  expect((await controller.wait(created.runID, "ses_owner")).status).toBe("completed")
  await controller.retry(created.runID, "ses_owner", "accept")
  expect((await controller.node(created.runID, "ses_owner", "accept")).status).toBe("waiting_approval")
  await controller.reject(created.runID, "ses_owner", "accept")
  expect((await controller.wait(created.runID, "ses_owner")).status).toBe("failed")
  await controller.amend(created.runID, "ses_owner", definition)
  expect((await controller.node(created.runID, "ses_owner", "accept")).status).toBe("waiting_approval")
  expect(generate).not.toHaveBeenCalled()
  expect(sessionAccess).not.toHaveBeenCalled()
})

test("native runner carries audited work and confirmed steering as text into a fresh same-agent child", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source))
  const request: DagSteerRequest = { runID: "run", nodeID: "work", requestID: "supplement", text: "keep the draft", execution: source, generation: 1, revision: 1, messageID: "msg_supplement", state: "admitted", receipt: { messageID: "msg_supplement" }, createdAt: 3 }
  await run(host.runner.steer!(source, request))
  writeFileSync(join(host.directory, "draft.txt"), "draft")
  host.finish(source.sessionID, "provider.auth", [{ type: "reasoning", text: "private reasoning", state: { secret: "provider state" } }, { type: "text", text: "Draft written" }, successfulPatch])
  await expect(run(host.runner.wait(source, [request]))).rejects.toMatchObject({ providerFailure: "provider.auth" })
  const handoff = await run(host.runner.checkpoint!({ ref: source, requests: [request] }))
  expect(handoff.task).toBe(host.input.prompt)
  expect(handoff.tools).toBe(1)
  expect(handoff.checkpoints[0]?.parts).toEqual([
    { type: "steer", requestID: "supplement", messageID: "msg_supplement", text: "keep the draft", token: "token-one", revision: 1 },
    { type: "assistant", text: "Draft written" },
    { type: "tool", id: "patch1", name: "patch", input: successfulPatch.state.input, output: ["Created draft.txt"] },
  ])
  const owner = await run(host.runner.ownerModel!("ses_owner", handoff))
  expect(owner).toBe("test/owner")
  const fresh = await run(host.runner.start({ ...host.input, handoff, node: { ...host.input.node, model: owner, worktree: true }, identity: { token: "token-two", agent: "quick", model: owner }, attempt: 2, prompt: "portable task" }))
  await run(host.runner.admit!(fresh))
  expect(host.creates[1]?.permissions).toEqual(host.creates[0]?.permissions ?? source.origin!.permissions)
  expect(host.creates[1]?.location).toEqual(host.creates[0]?.location)
  expect(String(host.creates[1]?.agent)).toBe("quick")
  expect(fresh.sessionID).not.toBe(source.sessionID)
  expect(readFileSync(join(host.directory, "draft.txt"), "utf8")).toBe("draft")
  expect(host.prompts).toHaveLength(2)
})

test("the opt-in is explicitly unsupported on stock hosts while default-off remains usable", () => {
  const host = fixture()
  const { inbox: _inbox, ...session } = host.ctx.session
  expect(() => createOpenCodeDagRunner({ ...host.ctx, session })).not.toThrow()
  expect(() => createOpenCodeDagRunner({ ...host.ctx, session }, { ownerModel: true })).toThrow("unsupported")
})

test("unexpected delivered input blocks continuation result publication", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID)
  const handoff = await run(host.runner.checkpoint!({ ref: source, requests: [] }))
  const child = await run(host.runner.start({ ...host.input, handoff, attempt: 2, identity: { ...host.input.identity!, token: "fresh" } }))
  await run(host.runner.admit!(child))
  host.histories.get(child.sessionID)!.push(message({ id: "msg_unexpected", type: "user", text: "other task", time: { created: 7 } }))
  await expect(run(host.runner.validateHandoff!(handoff, "test/A", child))).rejects.toThrow("unexpected")
})

test.each(["user", "synthetic", "compaction", "move"] as const)("authoritative pending %s input refuses capture and pre-admission without consumption", async (type) => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID)
  const handoff = await run(host.runner.checkpoint!({ ref: source, requests: [] }))
  const item = Schema.decodeUnknownSync(SessionInbox.Info)({ id: "msg_queued", sessionID: source.sessionID, type, delivery: "queue", time: { created: 8 }, payload: type === "move" ? { location: { directory: host.directory }, projectID: "project" } : { text: "pending" } })
  host.pending.set(source.sessionID, [item])
  await expect(run(host.runner.checkpoint!({ ref: source, requests: [] }))).rejects.toThrow("pending_host_input")
  await expect(run(host.runner.start({ ...host.input, handoff }))).rejects.toThrow("pending_host_input")
  expect(host.pending.get(source.sessionID)).toEqual([item])
  expect(host.creates).toHaveLength(1)
  host.pending.delete(source.sessionID)
  const fresh = await run(host.runner.start({ ...host.input, handoff, identity: { ...host.input.identity!, token: "new" }, attempt: 2 }))
  host.pending.set(source.sessionID, [item])
  await expect(run(host.runner.admit!(fresh))).rejects.toThrow("pending_host_input")
  expect(host.prompts).toHaveLength(1)
})

test.each([
  ["provider.auth", true], ["provider.quota", true], ["provider.rate-limit", true], ["provider.internal", true],
  ["provider.transport", true], ["provider.timeout", true], ["provider.no-route", true], ["provider.invalid-output", true],
  ["provider.unknown", false], ["provider.content-filter", false], ["provider.invalid-request", false],
  ["provider.unsupported-operation", false], ["tool.error", false], ["permission.denied", false],
] as const)("only terminal whitelist error %s qualifies (%s)", async (type, qualifies) => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID, type)
  const failure = await run(Effect.flip(host.runner.wait(source)))
  expect(failure.providerFailure).toBe(qualifies ? type : undefined)
  if (qualifies) expect((await run(host.runner.checkpoint!({ ref: source, requests: [] }))).tools).toBe(0)
  else await expect(run(host.runner.checkpoint!({ ref: source, requests: [] }))).rejects.toThrow("ineligible_terminal_failure")
})

test.each([
  { ...successfulPatch, name: "shell" }, { ...successfulPatch, name: "execute" }, { ...successfulPatch, name: "subagent" },
  { ...successfulPatch, name: "context7_query_docs" }, { ...successfulPatch, executed: true },
  { ...successfulPatch, state: { status: "running", input: {}, metadata: {} } },
  { ...successfulPatch, state: { status: "error", input: {}, error: { type: "tool.error", message: "failed" } } },
  { ...successfulPatch, state: { ...successfulPatch.state, content: [{ type: "file", mime: "image/png", uri: "file:///image.png" }] } },
])("opaque, partial, provider-executed or nontext tools never become a handoff", async (tool) => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID, "provider.auth", [tool])
  await expect(run(host.runner.checkpoint!({ ref: source, requests: [] }))).rejects.toThrow()
  expect(host.creates).toHaveLength(1)
})

test("missing history, completed compaction and attachments cannot be silently summarized", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID)
  const history = host.histories.get(source.sessionID)!
  host.histories.set(source.sessionID, history.slice(1))
  await expect(run(host.runner.checkpoint!({ ref: source, requests: [] }))).rejects.toThrow("missing_initial_history")
  host.histories.set(source.sessionID, [history[0]!, message({ id: "msg_compact", type: "compaction", status: "completed", reason: "auto", summary: "summary", recent: "", time: { created: 3 } }), ...history.slice(1)])
  await expect(run(host.runner.checkpoint!({ ref: source, requests: [] }))).rejects.toThrow("unsupported_history")
  const initial = history[0]!
  if (initial.type !== "user") throw new Error("fixture initial user missing")
  host.histories.set(source.sessionID, [{ ...initial, files: [{ data: "image", mime: "image/png", source: { type: "inline" } }] }, ...history.slice(1)])
  await expect(run(host.runner.checkpoint!({ ref: source, requests: [] }))).rejects.toThrow("unexpected_input")
})

test("admitted plaintext attachments remain complete in the portable task", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID)
  const history = host.histories.get(source.sessionID)!
  const initial = history[0]!
  if (initial.type !== "user") throw new Error("fixture initial user missing")
  host.histories.set(source.sessionID, [{ ...initial, files: [{ data: Buffer.from("Required attachment text").toString("base64"), mime: "text/plain", name: "requirements.txt", source: { type: "inline" } }] }, ...history.slice(1)])
  const handoff = await run(host.runner.checkpoint!({ ref: source, requests: [] }))
  expect(handoff.task).toContain("Required attachment text")
  expect(handoff.task).toContain("requirements.txt")
})

test("rendered UTF-8 and cumulative tool budgets reject without truncation", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID, "provider.auth", [{ type: "text", text: "\u4e2d".repeat(23000) }])
  await expect(run(host.runner.checkpoint!({ ref: source, requests: [] }))).rejects.toThrow("handoff_byte_limit")
  host.histories.set(source.sessionID, host.histories.get(source.sessionID)!.slice(0, 1))
  host.finish(source.sessionID, "provider.auth", [successfulPatch])
  const previous = await run(host.runner.checkpoint!({ ref: source, requests: [] }))
  const next = await run(host.runner.start({ ...host.input, handoff: previous, identity: { ...host.input.identity!, token: "new" }, attempt: 2 }))
  await run(host.runner.admit!(next)); host.finish(next.sessionID, "provider.auth", Array.from({ length: 256 }, (_, index) => ({ ...successfulPatch, id: `tool${index}`, state: { ...successfulPatch.state, input: {}, content: [{ type: "text", text: "ok" }] } })))
  await expect(run(host.runner.checkpoint!({ ref: next, previous, requests: [] }))).rejects.toThrow("handoff_tool_limit")
})

test("pinned owner model does not follow later owner changes, but catalog and ordered security changes fail closed", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID)
  const handoff = await run(host.runner.checkpoint!({ ref: source, requests: [] }))
  const model = await run(host.runner.ownerModel!("ses_owner", handoff))
  host.sessions.set("ses_owner", { ...host.sessions.get("ses_owner")!, model: Model.Ref.parse("test/B") })
  await run(host.runner.validateHandoff!(handoff, model))
  const child = await run(host.runner.start({ ...host.input, handoff, node: { ...host.input.node, model }, identity: { ...host.input.identity!, token: "pinned", model } }))
  expect(child.identity?.model).toBe("test/owner")
  const models = host.models()
  host.setModels(models.map((value) => ({ ...value, enabled: value.id !== "owner" })))
  await expect(run(host.runner.validateHandoff!(handoff, model))).rejects.toThrow("model_unavailable")
  host.setModels(models)
  host.setLane({ ...host.lane(), permissions: [...host.lane().permissions].reverse() })
  await expect(run(host.runner.validateHandoff!(handoff, model))).rejects.toThrow("security_or_location_drift")
})

test("model capability, variant and missing owner selection are checked on the actual catalog", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID)
  const handoff = await run(host.runner.checkpoint!({ ref: source, requests: [] }))
  const owner = host.sessions.get("ses_owner")!
  host.sessions.set("ses_owner", { ...owner, model: undefined })
  await expect(run(host.runner.ownerModel!("ses_owner", handoff))).rejects.toThrow("owner_has_no_model")
  host.sessions.set("ses_owner", { ...owner, model: Model.Ref.parse("test/owner#missing") })
  await expect(run(host.runner.ownerModel!("ses_owner", handoff))).rejects.toThrow("model_unavailable")
  host.sessions.set("ses_owner", { ...owner, model: Model.Ref.parse("test/owner#default") })
  expect(await run(host.runner.ownerModel!("ses_owner", handoff))).toBe("test/owner")
  for (const capabilities of [{ tools: false, input: ["text"], output: ["text"] }, { tools: true, input: ["image"], output: ["text"] }, { tools: true, input: ["text"], output: ["image"] }]) {
    host.setModels(host.models().map((value) => ({ ...value, capabilities })))
    await expect(run(host.runner.ownerModel!("ses_owner", handoff))).rejects.toThrow("model_unavailable")
  }
})

test("pending permissions, source identity changes and nonauthoritative catalog locations refuse handoff", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID)
  const handoff = await run(host.runner.checkpoint!({ ref: source, requests: [] }))
  const permission = Permission.Request.make({ id: Permission.ID.create("per_pending"), sessionID: Session.ID.make(source.sessionID), action: "edit", resources: ["draft.txt"] })
  const blocked = createOpenCodeDagRunner({ ...host.ctx, permission: { list: () => Effect.succeed([permission]) } }, { ownerModel: true })
  await expect(run(blocked.checkpoint!({ ref: source, requests: [] }))).rejects.toThrow("pending_permission")
  const foreign = createOpenCodeDagRunner({ ...host.ctx, model: { list: () => Effect.succeed({ location: { directory: AbsolutePath.make("/other/location") }, data: host.models() }) } }, { ownerModel: true })
  await expect(run(foreign.ownerModel!("ses_owner", handoff))).rejects.toThrow("catalog_location_unavailable")
  host.sessions.set(source.sessionID, { ...host.sessions.get(source.sessionID)!, agent: Agent.ID.make("sisyphus") })
  await expect(run(host.runner.validateHandoff!(handoff, "test/owner"))).rejects.toThrow("identity drift")
})

test("changing the preserved checkout branch refuses continuation without recreating the worktree", async () => {
  const host = fixture()
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: host.directory, stdio: "ignore" })
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source)); host.finish(source.sessionID)
  const handoff = await run(host.runner.checkpoint!({ ref: source, requests: [] }))
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/moved"], { cwd: host.directory })
  await expect(run(host.runner.start({ ...host.input, handoff, node: { ...host.input.node, worktree: true } }))).rejects.toThrow("security_or_location_drift")
  expect(host.creates).toHaveLength(1)
  expect(execFileSync("git", ["branch", "--show-current"], { cwd: host.directory, encoding: "utf8" }).trim()).toBe("moved")
})

test("historical confirmed supplements survive token rotation without synthetic replay", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source))
  const request: DagSteerRequest = { runID: "run", nodeID: "work", requestID: "supplement", text: "preserve", execution: source, generation: 1, revision: 1, messageID: "msg_supplement", state: "admitted", receipt: { messageID: "msg_supplement" }, createdAt: 3 }
  await run(host.runner.steer!(source, request)); host.finish(source.sessionID)
  const previous = await run(host.runner.checkpoint!({ ref: source, requests: [request] }))
  const next = await run(host.runner.start({ ...host.input, handoff: previous, identity: { ...host.input.identity!, token: "rotated" }, attempt: 2 }))
  await run(host.runner.admit!(next)); host.finish(next.sessionID)
  const result = await run(host.runner.checkpoint!({ ref: next, previous, requests: [{ ...request, state: "delivered" }] }))
  expect(result.checkpoints.flatMap((entry) => entry.parts.filter((part) => part.type === "steer"))).toHaveLength(1)
  expect(host.histories.get(next.sessionID)!.filter((entry) => entry.type === "synthetic")).toHaveLength(0)
  expect(host.prompts[1]!.text).toContain('"token":"token-one"')
  for (const state of ["reserved", "unresolved"] as const) await expect(run(host.runner.checkpoint!({ ref: next, previous, requests: [{ ...request, state }] }))).rejects.toThrow("unresolved_steering")
})

test("controller and native runner complete portable rescue end to end", async () => {
  const host = fixture()
  const originalWait = host.ctx.session.wait
  const wait: Context["session"]["wait"] = ({ sessionID }) => Effect.gen(function* () {
    yield* originalWait({ sessionID })
    if (host.histories.get(sessionID)?.at(-1)?.type === "idle") return
    const info = host.sessions.get(sessionID)!
    if (info.model?.id !== "owner") { host.finish(sessionID); return }
    host.sessions.set(sessionID, { ...info, outcome: "succeeded" })
    host.histories.get(sessionID)!.push(message({ id: "msg_success", type: "assistant", agent: info.agent, model: info.model, content: [{ type: "text", text: "continued task" }], time: { created: 8, completed: 9 } }), message({ id: "msg_finished", type: "idle", outcome: "succeeded", time: { created: 10 } }))
  })
  const runner = createOpenCodeDagRunner({ ...host.ctx, session: { ...host.ctx.session, wait } }, { ownerModel: true })
  const controller = promiseController(createDagController({ directory: host.directory, databasePath: join(host.directory, "state.db"), runner, rescue: { ownerModel: true } }))
  cleanups.push(() => controller.close())
  const created = await controller.create({ schemaVersion: 1, name: "native rescue", nodes: [host.input.node] }, "ses_owner")
  const done = await controller.wait(created.runID, "ses_owner")
  expect(done.status).toBe("completed")
  expect(host.creates.map((value) => String(value?.model?.id))).toEqual(["A", "owner"])
  expect(done.nodes[0]?.result?.payload).toEqual({ text: "continued task" })
  expect(done.nodes[0]?.recovery?.rescue?.state).toBe("settled")
  expect(done.nodes[0]?.recovery?.handoff?.checkpoints).toHaveLength(2)
})

test.each([
  ["fallback", true], ["fallback", false], ["attempt", true], ["attempt", false],
] as const)("cancelled pre-rescue %s cannot replay A after B work and pending input (reload enabled: %s)", async (budget, enabled) => {
  const host = fixture()
  const ready = Deferred.makeUnsafe<string>()
  const release = Deferred.makeUnsafe<void>()
  const returned = Deferred.makeUnsafe<void>()
  const wait: Context["session"]["wait"] = ({ sessionID }) => Effect.gen(function* () {
    if (host.histories.get(sessionID)?.at(-1)?.type === "idle") return
    if (sessionID === "ses_child1") { host.finish(sessionID); return }
    const current = host.sessions.get(sessionID)!
    writeFileSync(join(host.directory, "draft.txt"), "B completed work")
    host.histories.get(sessionID)!.push(message({ id: "msg_work", type: "assistant", agent: current.agent, model: current.model, content: [successfulPatch], time: { created: 7, completed: 8 } }))
    host.pending.set(sessionID, [Schema.decodeUnknownSync(SessionInbox.Synthetic)({ id: "msg_pending_B", sessionID, type: "synthetic", payload: { text: "PRESERVE_B_REQUIREMENT" }, delivery: "queue", time: { created: 9 } })])
    yield* Deferred.succeed(ready, sessionID)
    yield* Deferred.await(release)
    host.sessions.set(sessionID, { ...current, outcome: "succeeded" })
    host.histories.get(sessionID)!.push(message({ id: "msg_late", type: "assistant", agent: current.agent, model: current.model, content: [{ type: "text", text: "late B result" }], time: { created: 10, completed: 11 } }), message({ id: "msg_finished", type: "idle", outcome: "succeeded", time: { created: 12 } }))
    yield* Deferred.succeed(returned, undefined)
  })
  const ctx = { ...host.ctx, session: { ...host.ctx.session, wait } }
  const options = { directory: host.directory, databasePath: join(host.directory, "state.db") }
  const native = createOpenCodeDagRunner(ctx, { ownerModel: true })
  const captures: string[] = []
  let controller = promiseController(createDagController({ ...options, runner: { ...native,
    checkpoint: (input) => { captures.push(input.ref.sessionID); return native.checkpoint!(input) },
  }, rescue: { ownerModel: true } }))
  cleanups.push(() => controller.close())
  const definition: DagDefinition = { schemaVersion: 1, name: "cancel continuation", nodes: [
    { ...host.input.node, fallbackModels: budget === "fallback" ? ["test/B"] : [], maxAttempts: 2 },
    { ...host.input.node, id: "downstream", dependsOn: ["work"] },
  ] }
  const created = await controller.create(definition, "ses_owner")
  const child = await run(Deferred.await(ready))
  const active = await controller.node(created.runID, "ses_owner", "work")
  expect(active.recovery?.rescue).toBeUndefined()
  expect(active.recovery?.handoff?.checkpoints.map((entry) => entry.source.sessionID)).toEqual(["ses_child1"])
  expect(host.creates.map((input) => String(input?.model?.id))).toEqual(["A", budget === "fallback" ? "B" : "A"])
  await controller.cancel(created.runID, "ses_owner")
  await expect(controller.retry(created.runID, "ses_owner", "work")).rejects.toThrow("unresolved")
  await expect(controller.resume(created.runID, "ses_owner")).rejects.toThrow("unresolved")
  await expect(controller.amend(created.runID, "ses_owner", definition)).rejects.toThrow("unresolved")
  await run(Deferred.succeed(release, undefined))
  await run(Deferred.await(returned))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const cancelled = await controller.snapshot(created.runID, "ses_owner")
  const work = cancelled.run.nodes.find((node) => node.definition.id === "work")!
  expect(cancelled.run.status).toBe("cancelled")
  expect(work.recovery?.blocked).toBe("cancelled_continuation")
  expect(work.recovery?.handoff).toEqual(active.recovery?.handoff)
  expect(work.recovery?.rescue).toBeUndefined()
  expect(cancelled.run.nodes.every((node) => node.result === undefined)).toBe(true)
  expect(cancelled.events.filter((event) => event.type === "node.completed")).toHaveLength(0)
  expect(captures).toEqual(["ses_child1"])
  controller.close()
  controller = promiseController(createDagController({ ...options, runner: createOpenCodeDagRunner(ctx, { ownerModel: enabled }), rescue: { ownerModel: enabled } }))
  await expect(controller.retry(created.runID, "ses_owner", "work")).rejects.toThrow("unresolved")
  await expect(controller.resume(created.runID, "ses_owner")).rejects.toThrow("unresolved")
  await expect(controller.amend(created.runID, "ses_owner", definition)).rejects.toThrow("unresolved")
  expect((await controller.node(created.runID, "ses_owner", "work")).recovery).toEqual(work.recovery)
  expect(host.creates).toHaveLength(2)
  expect(host.prompts).toHaveLength(2)
  expect(host.pending.get(child)).toEqual([expect.objectContaining({ id: "msg_pending_B", payload: { text: "PRESERVE_B_REQUIREMENT" } })])
  expect(readFileSync(join(host.directory, "draft.txt"), "utf8")).toBe("B completed work")
})

test.each([false, true])("cancel during native admission waits for the actual child role snapshot (planning: %s)", async (planning) => {
  const host = fixture()
  const state = new SessionStateStore(join(host.directory, "roles.db"))
  cleanups.push(() => state.close())
  const ready = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let complete = false
  const ctx = { ...host.ctx, session: { ...host.ctx.session,
    prompt: (input: Parameters<Context["session"]["prompt"]>[0]) => Effect.gen(function* () {
      const receipt = yield* host.ctx.session.prompt(input)
      if (planning) saveRole(state, input.sessionID, { role: "planning" })
      yield* Deferred.succeed(ready, undefined)
      yield* Deferred.await(release)
      return receipt
    }),
    wait: ({ sessionID }: Parameters<Context["session"]["wait"]>[0]) => Effect.gen(function* () {
      if (!complete) return yield* Effect.never
      if (host.histories.get(sessionID)?.at(-1)?.type === "idle") return
      const current = host.sessions.get(sessionID)!
      host.sessions.set(sessionID, { ...current, outcome: "succeeded" })
      host.histories.get(sessionID)!.push(message({ id: "msg_success", type: "assistant", agent: current.agent, model: current.model, content: [{ type: "text", text: "ordinary completion" }], time: { created: 8, completed: 9 } }), message({ id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 10 } }))
    }),
  } }
  const controller = promiseController(createDagController({ directory: host.directory, databasePath: join(host.directory, "state.db"), runner: createOpenCodeDagRunner(ctx, { ownerModel: true }), rescue: { ownerModel: true }, rescueRoleAllowed: (sessionID) => rescueRoleAllowed(ctx, state, sessionID) }))
  cleanups.push(() => controller.close())
  const definition: DagDefinition = { schemaVersion: 1, name: "admission cancellation", nodes: [host.input.node] }
  const created = await controller.create(definition, "ses_owner")
  await run(Deferred.await(ready))
  const pendingCancel = controller.cancel(created.runID, "ses_owner")
  await run(Deferred.succeed(release, undefined))
  const cancelled = await pendingCancel
  expect(cancelled.nodes[0]?.runtime?.initial).toBe("admitted")
  expect(cancelled.nodes[0]?.recovery?.initialRoleAllowed).toBe(!planning)
  expect(cancelled.nodes[0]?.recovery?.handoff).toBeUndefined()
  if (planning) {
    expect(cancelled.nodes[0]?.recovery?.blocked).toBeUndefined()
    complete = true
    await controller.retry(created.runID, "ses_owner", "work")
    expect((await controller.wait(created.runID, "ses_owner")).status).toBe("completed")
  } else {
    expect(cancelled.nodes[0]?.recovery?.blocked).toBe("cancelled_continuation")
    await expect(controller.retry(created.runID, "ses_owner", "work")).rejects.toThrow("unresolved")
  }
})

function roleController(kind: string, successful = false, drift?: (host: ReturnType<typeof fixture>, state: SessionStateStore, child: string) => void) {
  const host = fixture()
  const databasePath = join(host.directory, "state.db")
  const state = new SessionStateStore(databasePath)
  cleanups.push(() => state.close())
  host.setLane({ ...host.lane(), permissions: [{ action: "*", resource: "*", effect: "allow" }] })
  const owner = host.sessions.get("ses_owner")!
  host.sessions.set("ses_owner", { ...owner, agent: Agent.ID.make(kind.startsWith("owner-") ? kind.slice(6) : "build") })
  if (["planning", "ticket", "orchestrator"].includes(kind)) saveRole(state, "ses_owner", { role: kind as "planning" | "ticket" | "orchestrator" })
  const ctx = { ...host.ctx, session: { ...host.ctx.session,
    prompt: (input: Parameters<Context["session"]["prompt"]>[0]) => host.ctx.session.prompt(input).pipe(Effect.tap(() => Effect.sync(() => {
      if (kind === "planning-child") saveRole(state, input.sessionID, { role: "planning" })
    }))),
    wait: ({ sessionID }: Parameters<Context["session"]["wait"]>[0]) => Effect.sync(() => {
      if (host.histories.get(sessionID)?.at(-1)?.type === "idle") return
      drift?.(host, state, sessionID)
      if (!successful) { host.finish(sessionID); return }
      const current = host.sessions.get(sessionID)!
      host.sessions.set(sessionID, { ...current, outcome: "succeeded" })
      host.histories.get(sessionID)!.push(message({ id: `msg_done${sessionID}`, type: "assistant", agent: current.agent, model: current.model, content: [{ ...successfulPatch, name: "shell" }, { type: "text", text: "ordinary success" }], time: { created: 8, completed: 9 } }), message({ id: `msg_idle${sessionID}`, type: "idle", outcome: "succeeded", time: { created: 10 } }))
    }),
  } }
  const effects = createDagController({ directory: host.directory, databasePath, runner: createOpenCodeDagRunner(ctx, { ownerModel: true }), rescue: { ownerModel: true },
    rescueRoleAllowed: (sessionID) => rescueRoleAllowed(ctx, state, sessionID),
    admitSteer: (owner, node) => admitSteering(ctx, state, owner, node),
    admit: (owner, definition, authorizedPlan) => Effect.gen(function* () {
      const get = (sessionID: string) => ctx.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(Effect.mapError(() => new DagValidationError("Missing tier session")))
      const session = yield* get(owner)
      const source = yield* tierSource(owner, get, effects.lineage)
      yield* Effect.try({ try: () => admitTier(source, session, definition, authorizedPlan), catch: (error) => new DagValidationError(String(error)) })
    }),
  })
  const controller = promiseController(effects)
  cleanups.push(() => controller.close())
  return { ...host, state, effects, controller, setSuccess: () => { successful = true } }
}

test.each(["atlas", "prometheus", "authorized-agent", "owner-atlas", "owner-prometheus", "planning", "ticket", "orchestrator", "planning-child"])("native excluded %s exhausts A B C C C and remains retryable/amendable", async (kind) => {
  const host = roleController(kind === "authorized-agent" ? "owner-atlas" : kind)
  const task = { ...host.input.node, agent: ["atlas", "prometheus"].includes(kind) ? kind : "quick", fallbackModels: ["test/B", "test/C"], maxAttempts: 5 }
  const definition: DagDefinition = { schemaVersion: 1, name: kind, nodes: [task] }
  const created = await run(host.effects.create(definition, "ses_owner", kind === "authorized-agent" ? "approved-plan" : undefined))
  const failed = await host.controller.wait(created.runID, "ses_owner")
  expect(failed.status).toBe("failed")
  expect(host.creates.map((input) => String(input?.model?.id))).toEqual(["A", "B", "C", "C", "C"])
  expect(failed.nodes[0]?.recovery?.blocked).toBeUndefined()
  expect(failed.nodes[0]?.recovery?.handoff).toBeUndefined()
  expect(failed.nodes[0]?.recovery?.rescue).toBeUndefined()
  await host.controller.retry(created.runID, "ses_owner", "work")
  expect((await host.controller.wait(created.runID, "ses_owner")).status).toBe("failed")
  expect(host.creates.slice(5).map((input) => String(input?.model?.id))).toEqual(["A", "B", "C"])
  host.setSuccess()
  await host.controller.amend(created.runID, "ses_owner", definition)
  expect((await host.controller.wait(created.runID, "ses_owner")).status).toBe("completed")
  await host.controller.retry(created.runID, "ses_owner", "work")
  expect((await host.controller.wait(created.runID, "ses_owner")).status).toBe("completed")
  await host.controller.amend(created.runID, "ses_owner", definition)
  const amended = await host.controller.wait(created.runID, "ses_owner")
  expect(amended.status).toBe("completed")
  expect(amended.nodes[0]?.recovery?.blocked).toBeUndefined()
  expect(amended.nodes[0]?.recovery?.handoff).toBeUndefined()
  expect(amended.nodes[0]?.recovery?.rescue).toBeUndefined()
  expect(host.prompts.every((input) => input.text === task.prompt)).toBe(true)
  expect((await host.controller.snapshot(created.runID, "ses_owner")).events.filter((event) => event.type === "node.rescued" || event.type === "node.rescue-skipped")).toHaveLength(0)
})

test.each(["atlas", "prometheus", "authorized-agent", "owner-prometheus", "planning", "planning-child"])("native initially successful excluded %s never captures handoff or blocks manual operations", async (kind) => {
  const host = roleController(kind === "authorized-agent" ? "owner-atlas" : kind, true)
  const task = { ...host.input.node, agent: ["atlas", "prometheus"].includes(kind) ? kind : "quick" }
  const definition: DagDefinition = { schemaVersion: 1, name: kind, nodes: [task] }
  const created = await run(host.effects.create(definition, "ses_owner", kind === "authorized-agent" ? "approved-plan" : undefined))
  expect((await host.controller.wait(created.runID, "ses_owner")).status).toBe("completed")
  await host.controller.retry(created.runID, "ses_owner", "work")
  expect((await host.controller.wait(created.runID, "ses_owner")).status).toBe("completed")
  await host.controller.amend(created.runID, "ses_owner", { ...definition, nodes: [{ ...task, prompt: "Amended ordinary task" }] })
  const done = await host.controller.wait(created.runID, "ses_owner")
  expect(done.status).toBe("completed")
  expect(done.nodes[0]?.recovery?.blocked).toBeUndefined()
  expect(done.nodes[0]?.recovery?.handoff).toBeUndefined()
  expect(done.nodes[0]?.recovery?.rescue).toBeUndefined()
  expect(host.prompts.map((input) => input.text)).toEqual([task.prompt, task.prompt, "Amended ordinary task"])
})

test.each(["owner-role", "owner-agent", "child-role", "flow-permission", "delegate-permission", "tier"])("rescue-eligible work still blocks %s drift before fallback and manual replay", async (change) => {
  const host = roleController("eligible", false, (host, state, child) => {
    const owner = host.sessions.get("ses_owner")!
    if (change === "owner-role") saveRole(state, "ses_owner", { role: "planning" })
    if (change === "child-role") saveRole(state, child, { role: "planning" })
    if (change === "owner-agent" || change === "tier") host.sessions.set("ses_owner", { ...owner, agent: Agent.ID.make(change === "tier" ? "quick" : "prometheus") })
    if (change.endsWith("permission")) host.sessions.set("ses_owner", { ...owner, permissions: [{ action: change === "flow-permission" ? "iolaus_flow" : "subagent", resource: "*", effect: "deny" }] })
  })
  const definition: DagDefinition = { schemaVersion: 1, name: "drift", nodes: [{ ...host.input.node, agent: change === "tier" ? "sisyphus" : "quick", fallbackModels: ["test/B", "test/C"], maxAttempts: 5 }] }
  const created = await host.controller.create(definition, "ses_owner")
  const done = await host.controller.wait(created.runID, "ses_owner")
  expect(done.status).toBe("failed")
  expect(host.creates).toHaveLength(1)
  expect(done.nodes[0]?.recovery?.blocked).toBeDefined()
  expect(done.nodes[0]?.recovery?.rescue).toBeUndefined()
  host.sessions.set("ses_owner", { ...host.sessions.get("ses_owner")!, agent: Agent.ID.make("build"), permissions: [] })
  await expect(host.controller.retry(created.runID, "ses_owner", "work")).rejects.toThrow("unresolved")
  await expect(host.controller.amend(created.runID, "ses_owner", definition)).rejects.toThrow("unresolved")
  expect(host.creates).toHaveLength(1)
})

test.each([
  ["pending_host_input", "fallback"], ["pending_host_input", "attempt"],
  ["opaque_tool_history", "fallback"], ["opaque_tool_history", "attempt"],
] as const)("controller halts unsteered %s before remaining %s continuations", async (reason, budget) => {
  const host = fixture()
  const wait: Context["session"]["wait"] = ({ sessionID }) => Effect.sync(() => {
    if (host.histories.get(sessionID)?.at(-1)?.type === "idle") return
    host.finish(sessionID, "provider.auth", reason === "opaque_tool_history" ? [{ ...successfulPatch, name: "shell" }] : [])
    if (reason === "pending_host_input") host.pending.set(sessionID, [Schema.decodeUnknownSync(SessionInbox.Synthetic)({ id: "msg_hidden_requirement", sessionID, type: "synthetic", payload: { text: "PRESERVE_PENDING_REQUIREMENT" }, delivery: "queue", time: { created: 7 } })])
  })
  const runner = createOpenCodeDagRunner({ ...host.ctx, session: { ...host.ctx.session, wait } }, { ownerModel: true })
  const controller = promiseController(createDagController({ directory: host.directory, databasePath: join(host.directory, "state.db"), runner, rescue: { ownerModel: true } }))
  cleanups.push(() => controller.close())
  const created = await controller.create({ schemaVersion: 1, name: "unsafe continuation", nodes: [{ ...host.input.node, fallbackModels: budget === "fallback" ? ["test/B", "test/C"] : [], maxAttempts: 3 }] }, "ses_owner")
  const done = await controller.wait(created.runID, "ses_owner")
  expect(done.status).toBe("failed")
  expect(host.creates).toHaveLength(1)
  expect(host.prompts).toHaveLength(1)
  expect(done.nodes[0]?.attempt).toBe(1)
  expect(done.nodes[0]?.recovery?.blocked).toBe(reason)
  expect(done.nodes[0]?.recovery?.handoff).toBeUndefined()
  expect(done.nodes[0]?.recovery?.rescue).toBeUndefined()
  const snapshot = await controller.snapshot(created.runID, "ses_owner")
  expect(snapshot.steering).toHaveLength(0)
  expect(snapshot.events.filter((event) => event.type === "node.fallback" || event.type === "node.rescued")).toHaveLength(0)
  if (reason === "pending_host_input") expect(host.pending.get(done.nodes[0]!.execution!.sessionID)).toEqual([expect.objectContaining({ id: "msg_hidden_requirement", payload: { text: "PRESERVE_PENDING_REQUIREMENT" } })])
})

test.each([true, false])("persisted unsafe history refuses retry, resume and amend after reload (rescue enabled: %s)", async (enabled) => {
  const host = fixture()
  const wait: Context["session"]["wait"] = ({ sessionID }) => Effect.sync(() => {
    if (host.histories.get(sessionID)?.at(-1)?.type === "idle") return
    host.finish(sessionID)
    host.pending.set(sessionID, [Schema.decodeUnknownSync(SessionInbox.Synthetic)({ id: "msg_hidden_requirement", sessionID, type: "synthetic", payload: { text: "PRESERVE_PENDING_REQUIREMENT" }, delivery: "queue", time: { created: 7 } })])
  })
  const ctx = { ...host.ctx, session: { ...host.ctx.session, wait } }
  const options = { directory: host.directory, databasePath: join(host.directory, "state.db") }
  let controller = promiseController(createDagController({ ...options, runner: createOpenCodeDagRunner(ctx, { ownerModel: true }), rescue: { ownerModel: true } }))
  cleanups.push(() => controller.close())
  const definition = { schemaVersion: 1 as const, name: "persisted refusal", nodes: [host.input.node] }
  const created = await controller.create(definition, "ses_owner")
  const done = await controller.wait(created.runID, "ses_owner")
  expect(done.nodes[0]?.recovery?.blocked).toBe("pending_host_input")
  expect(host.creates).toHaveLength(1)
  controller.close()
  controller = promiseController(createDagController({ ...options, runner: createOpenCodeDagRunner(ctx, { ownerModel: enabled }), rescue: { ownerModel: enabled } }))
  await expect(controller.retry(created.runID, "ses_owner", "work")).rejects.toThrow("unresolved")
  await expect(controller.resume(created.runID, "ses_owner")).rejects.toThrow("unresolved")
  await expect(controller.amend(created.runID, "ses_owner", definition)).rejects.toThrow("unresolved")
  expect(host.creates).toHaveLength(1)
  expect(host.prompts).toHaveLength(1)
  expect(host.pending.get(done.nodes[0]!.execution!.sessionID)).toEqual([expect.objectContaining({ id: "msg_hidden_requirement" })])
})

test("a coalesced no-work host wake cannot erase the last provider failure after confirmed steering", async () => {
  const host = fixture()
  const source = await run(host.runner.start(host.input))
  await run(host.runner.admit!(source))
  const requests: DagSteerRequest[] = []
  for (const revision of [1, 2]) {
    const request: DagSteerRequest = { runID: "run", nodeID: "work", requestID: `steer-${revision}`, text: `requirement ${revision}`, execution: source, generation: 1, revision, messageID: `msg_steer${revision}`, state: "admitted", receipt: { messageID: `msg_steer${revision}` }, createdAt: revision }
    requests.push(request)
    await run(host.runner.steer!(source, request))
  }
  host.finish(source.sessionID)
  const history = host.histories.get(source.sessionID)!
  const assistant = history.at(-2)!
  if (assistant.type !== "assistant") throw new Error("missing assistant")
  history[history.length - 2] = { ...assistant, finish: "error", error: { type: "provider.auth", message: "provider unavailable" } }
  history.push(message({ id: "msg_nowork", type: "idle", outcome: "succeeded", time: { created: 7 } }))
  host.sessions.set(source.sessionID, { ...host.sessions.get(source.sessionID)!, outcome: "succeeded" })
  await expect(run(host.runner.wait(source, requests))).rejects.toMatchObject({ providerFailure: "provider.auth", deliveredRequests: ["steer-1", "steer-2"] })
  const handoff = await run(host.runner.checkpoint!({ ref: source, requests }))
  expect(handoff.checkpoints[0]?.outcome).toBe("succeeded")
  expect(handoff.checkpoints[0]?.parts.filter((part) => part.type === "steer")).toHaveLength(2)
  await expect(run(host.runner.validateHandoff!(handoff, "test/owner"))).resolves.toBeUndefined()
})

test("no-work terminal normalization refuses intervening work and mismatched errors", () => {
  const assistant = message({ id: "msg_error", type: "assistant", agent: "quick", model: { providerID: "test", id: "A" }, content: [], finish: "error", error: { type: "provider.auth", message: "unavailable" }, time: { created: 1 } })
  const failed = message({ id: "msg_failed", type: "idle", outcome: "failed", error: { type: "provider.auth", message: "unavailable" }, time: { created: 2 } })
  const succeeded = message({ id: "msg_success", type: "idle", outcome: "succeeded", time: { created: 3 } })
  if (failed.type !== "idle" || succeeded.type !== "idle") throw new Error("missing idle fixtures")
  expect(recoveryTerminal([assistant, failed, succeeded])).toBe(failed)
  expect(recoveryTerminal([assistant, failed, message({ id: "msg_other", type: "user", text: "new task", time: { created: 3 } }), succeeded])).toBe(succeeded)
  expect(recoveryTerminal([failed, succeeded])).toBeUndefined()
  expect(recoveryTerminal([assistant, message({ id: "msg_unknown", type: "idle", outcome: "failed", error: { type: "provider.unknown", message: "unknown" }, time: { created: 2 } }), succeeded])).toBeUndefined()
  expect(recoveryTerminal([assistant, failed, message({ id: "msg_interrupted", type: "idle", outcome: "interrupted", time: { created: 3 } })])).toBeUndefined()
})
