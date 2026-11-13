import { afterEach, expect, test } from "bun:test"
import { DateTime, Effect, Queue, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { SessionStateStore } from "../src/database"
import { createDagController } from "../src/dag/controller"
import { registerSubagentObserver } from "../src/dag/observe"
import { createQuiescence } from "../src/dag/quiesce"
import { createOpenCodeDagRunner, runnerFromPromise } from "../src/dag/runner"
import { createGoalRuntime, readGoal, saveGoal, setGoal } from "../src/roles/goal"

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

const tick = () => new Promise((done) => setTimeout(done, 5))

/** A host whose sessions go busy and idle on command, as the 2.3.0 host reports them: `time.busy`, `time.idle`, `wait`. */
function host() {
  let clock = 1000
  const sessions = new Map<string, { parentID?: string; busy?: number; idle?: number; done?: () => void; pending?: Promise<void> }>()
  const order: string[] = []
  const end = (id: string) => { const s = sessions.get(id)!; s.idle = ++clock; const done = s.done; s.done = undefined; s.pending = undefined; done?.() }
  return {
    order,
    add: (id: string, parentID?: string) => { sessions.set(id, { ...(parentID ? { parentID } : {}) }) },
    start: (id: string) => { const s = sessions.get(id)!; s.busy = ++clock; s.pending = new Promise((done) => { s.done = done }) },
    end,
    session: {
      list: (input: { parentID?: string }) => Effect.sync(() => ({ cursor: {}, data: [...sessions].filter(([, s]) => s.parentID === input.parentID)
        .map(([id, s]) => ({ id, time: { ...(s.busy ? { busy: DateTime.makeUnsafe(s.busy) } : {}), ...(s.idle ? { idle: DateTime.makeUnsafe(s.idle) } : {}) } })) })),
      wait: (input: { sessionID: string }) => Effect.promise(async () => { while (sessions.get(input.sessionID)?.pending) await sessions.get(input.sessionID)!.pending }),
      interrupt: (input: { sessionID: string }) => Effect.sync(() => {
        const interrupted = Boolean(sessions.get(input.sessionID)?.pending)
        order.push(input.sessionID)
        if (interrupted) end(input.sessionID)
        return { interrupted }
      }),
    },
  }
}

test("a session is settled only when it and the subagents below it are idle and the report's turn has ended", async () => {
  const h = host()
  const quiescence = createQuiescence(h.session as never)
  h.add("node"); h.add("child", "node"); h.add("grandchild", "child")
  h.start("node"); h.end("node")
  expect(await Effect.runPromise(quiescence.busy("node"))).toBe(false)
  h.start("child"); h.start("grandchild")
  expect(await Effect.runPromise(quiescence.busy("node"))).toBe(true)
  let settled = false
  const done = Effect.runPromise(quiescence.settle("node")).then(() => { settled = true })
  await tick(); expect(settled).toBe(false)
  h.end("grandchild")
  await tick(); expect(settled).toBe(false)
  // The host admits a child's report, and so wakes the parent, before the child's wait returns.
  h.start("node"); h.end("child")
  await tick(); expect(settled).toBe(false)
  h.end("node")
  await done
  expect(settled).toBe(true)
  expect(await Effect.runPromise(quiescence.busy("node"))).toBe(false)
})

test("stopping a session stops its subagents first, deepest first, and the session last", async () => {
  const h = host()
  h.add("node"); h.add("child", "node"); h.add("grandchild", "child")
  h.start("child"); h.start("grandchild")
  await Effect.runPromise(createQuiescence(h.session as never).stop("node"))
  expect(h.order.slice(0, 3)).toEqual(["grandchild", "child", "node"])
  expect(await Effect.runPromise(createQuiescence(h.session as never).busy("node"))).toBe(false)
})

test("the native runner returns a node's reply after its subagents reported, and cancels them with the node", async () => {
  const h = host()
  h.add("ses_node"); h.add("ses_sub", "ses_node")
  let messages: unknown[] = [{ type: "user" }, { type: "assistant", content: [{ type: "text", text: "delegated, waiting" }] }]
  const runner = createOpenCodeDagRunner({
    location: { directory: "/p" },
    experimental: { generate: { text: () => Effect.succeed({ text: "" }) } },
    session: { ...h.session, create: () => Effect.succeed({ id: "ses_node" }), prompt: () => Effect.void, get: () => Effect.succeed({ outcome: "succeeded" }), context: () => Effect.succeed(messages) },
  } as never)
  h.start("ses_sub")
  const ref = { nodeID: "work", attempt: 1, sessionID: "ses_node" }
  let result: unknown
  const waiting = Effect.runPromise(runner.wait(ref)).then((value) => { result = value })
  await tick(); expect(result).toBeUndefined()
  h.start("ses_node")
  h.end("ses_sub")
  messages = [...messages, { type: "synthetic" }, { type: "assistant", content: [{ type: "text", text: "final with the subagent's answer" }] }]
  h.end("ses_node")
  await waiting
  expect(result).toEqual({ payload: { text: "final with the subagent's answer" } })

  h.start("ses_sub")
  await Effect.runPromise(runner.cancel(ref))
  // One pass stops the subagent before the node; a second pass confirms nothing below it started again.
  expect(h.order).toEqual(["ses_sub", "ses_node", "ses_sub", "ses_node"])
  expect(await Effect.runPromise(createQuiescence(h.session as never).busy("ses_node"))).toBe(false)
})

test("an observed call settles with its child's final answer and reopens when the child runs again", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-background-"))
  const controller = createDagController({ directory, databasePath: join(directory, "iolaus.db"), runner: runnerFromPromise({
    async start() { throw new Error("not scheduled") }, async wait() { throw new Error("not scheduled") }, async cancel() {},
  }) })
  const h = host()
  h.add("owner"); h.add("ses_child", "owner"); h.add("ses_grandchild", "ses_child")
  const hooks = new Map<string, (event: unknown) => Effect.Effect<unknown, unknown>>()
  const events = Effect.runSync(Queue.unbounded<{ type: string; data: Record<string, unknown> }>())
  let reply = "interim: delegated"
  const ctx = {
    tool: { hook: (name: string, hook: (event: unknown) => Effect.Effect<unknown, unknown>) => Effect.sync(() => { hooks.set(name, hook) }) },
    session: { ...h.session, get: () => Effect.succeed({}), context: (input: { sessionID: string }) => Effect.succeed(input.sessionID === "owner"
      ? [{ id: "request", type: "user" }, { id: "assistant", type: "assistant" }] : [{ type: "assistant", content: [{ type: "text", text: reply }] }]) },
    event: { subscribe: () => Stream.fromQueue(events) },
  } as unknown as Context
  const emit = async (type: string, data: Record<string, unknown>) => { Queue.offerUnsafe(events, { type, data }); await tick() }
  const node = async () => (await Effect.runPromise(controller.list("owner")))[0]!.nodes[0]!
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* registerSubagentObserver(ctx, controller, () => {})
      yield* hooks.get("execute.before")!({ id: "call", sessionID: "owner", messageID: "assistant", tool: "subagent", input: { agent: "metis", description: "Analyse", prompt: "go" } })
      // 2.3.0: the tool returns at once with the child running.
      yield* hooks.get("execute.after")!({ id: "call", sessionID: "owner", tool: "subagent", status: "completed", result: { output: { sessionID: "ses_child", status: "running", output: "The subagent is working in the background" } } })
      yield* Effect.promise(async () => {
        expect((await node()).status).toBe("running")
        // The child goes idle while its own subagent still works: not the answer yet.
        h.start("ses_grandchild")
        await emit("session.execution.succeeded", { sessionID: "ses_child" })
        expect((await node()).status).toBe("running")
        h.start("ses_child"); h.end("ses_grandchild")
        await emit("session.execution.started", { sessionID: "ses_child" })
        reply = "final: grandchild said 42"
        h.end("ses_child")
        await emit("session.execution.succeeded", { sessionID: "ses_child" })
        let settled = await node()
        expect([settled.status, settled.attempt, settled.result?.payload]).toEqual(["completed", 1, { text: "final: grandchild said 42" }])
        // Its own background work wakes a settled child: the node follows it.
        h.start("ses_child")
        await emit("session.execution.started", { sessionID: "ses_child" })
        expect((await node()).status).toBe("running")
        reply = "after the wake"
        h.end("ses_child")
        await emit("session.execution.succeeded", { sessionID: "ses_child" })
        settled = await node()
        expect([settled.status, settled.attempt, settled.result?.payload]).toEqual(["completed", 2, { text: "after the wake" }])
      })
    })))
  } finally {
    await Effect.runPromise(controller.close)
  }
})

test("the goal loop waits for running subagents and counts the delegating turn's tool calls", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-goal-wait-"))
  const state = new SessionStateStore(join(directory, "iolaus.db"))
  const dispatched: string[] = []
  let waiting = true
  const runtime = createGoalRuntime({
    read: (s) => readGoal(state, s), save: (g) => saveGoal(state, g), isGoalSession: async () => true,
    dispatch: async (s) => { dispatched.push(s) }, settle: async () => {}, waiting: async () => waiting,
  })
  setGoal(state, "s", "ship it")
  for (let round = 1; round <= 4; round++) {
    waiting = true
    await runtime.handle({ type: "session.execution.started", data: { sessionID: "s" } })
    runtime.toolCalled("s")
    await runtime.handle({ type: "session.execution.succeeded", data: { sessionID: "s" } })
    expect(dispatched).toHaveLength(round - 1)
    // The subagent's report starts a turn that only reads it.
    waiting = false
    await runtime.handle({ type: "session.execution.started", data: { sessionID: "s" } })
    await runtime.handle({ type: "session.execution.succeeded", data: { sessionID: "s" } })
    expect(dispatched).toHaveLength(round)
  }
  expect(readGoal(state, "s")).toMatchObject({ status: "active", continuations: 4, stagnant: 0 })
  state.close()
})
