import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { createDagController, type DagController } from "../src/dag/controller"
import { runnerFromPromise } from "../src/dag/runner"
import { DagRunnerError } from "../src/dag/errors"
import type { DagRunRecord } from "../src/dag/types"
import { registerFlowContinuationGuard } from "../src/dag/continuation"
import { registerSubagentObserver } from "../src/dag/observe"
import { openNodeSession, sessionUnavailable } from "../src/tui/navigation"
import type { DagViewNode } from "../src/tui/view"

test("continuation preflight refuses scheduled sessions before creating or reopening observed nodes", async () => {
  const hooks: ((event: unknown) => Effect.Effect<unknown, unknown>)[] = []
  let created = 0, reopened = 0
  let steered = false
  const node = { definition: { id: "work", agent: "quick" }, status: "completed", runtime: { initial: "admitted", inputRevision: 0 }, execution: { identity: { token: "token", agent: "quick", model: "mock/model" } } }
  const run = { runID: "flow", ownerSessionID: "owner", nodes: [node] } as unknown as DagRunRecord
  const ctx = {
    tool: { hook: (name: string, hook: (event: unknown) => Effect.Effect<unknown, unknown>) => Effect.sync(() => { if (name === "execute.before") hooks.push(hook) }) },
    session: { get: ({ sessionID }: { sessionID: string }) => ["missing", "unreadable"].includes(sessionID) ? Effect.fail(new Error("unavailable")) : Effect.succeed({ parentID: ["native", "forged", "unknown-child"].includes(sessionID) ? "owner" : sessionID === "unrelated" ? "other" : undefined, metadata: sessionID === "native" || sessionID === "unrelated" ? {} : { iolaus_dag_run: sessionID === "unknown-child" ? "unknown" : "flow", iolaus_dag_node: "work" } }) },
    event: { subscribe: () => Stream.empty },
  } as unknown as Context
  const controller = {
    lineage: (_run: string, _node: string, session: string) => Effect.succeed(session === "scheduled" ? run : undefined),
    snapshot: () => Effect.succeed({ steering: steered ? [{ nodeID: "work" }] : [] }),
    observedChild: (session: string) => Effect.succeed(session === "native" || session === "scheduled" ? { runID: "observed", nodeID: "old", owner: "owner" } : undefined),
    observe: () => Effect.sync(() => { created++; return { runID: "observed", nodeID: "new" } }),
    observed: () => Effect.sync(() => { reopened++ }),
  } as unknown as DagController
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* registerFlowContinuationGuard(ctx, controller)
    yield* registerSubagentObserver(ctx, controller, () => {})
    const call = (sessionID: string, caller = "owner") => Effect.gen(function* () {
      for (const hook of hooks) yield* hook({ id: sessionID, tool: "subagent", sessionID: caller, input: { sessionID, agent: "quick", prompt: "follow up" } })
    })
    const refused = yield* Effect.exit(call("scheduled"))
    expect(refused._tag).toBe("Failure")
    expect(created).toBe(0)
    expect(reopened).toBe(0)
    for (const target of ["unrelated", "forged-nonchild", "missing", "unreadable"]) {
      const invalid = yield* Effect.exit(call(target))
      expect(Exit.isFailure(invalid)).toBe(true)
      expect(Exit.isFailure(invalid) && Cause.pretty(invalid.cause)).not.toContain("scheduler-owned")
    }
    expect(created).toBe(0)
    expect(reopened).toBe(0)
    for (const [status, action] of [["running", 'action: "steer"'], ["failed", 'action: "retry"'], ["interrupted", 'action: "retry"']]) {
      node.status = status!
      const result = yield* Effect.exit(call("scheduled"))
      expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain(action!)
    }
    const foreign = yield* Effect.exit(call("scheduled", "foreign"))
    expect(Exit.isFailure(foreign) && Cause.pretty(foreign.cause)).not.toContain('action: "retry"')
    steered = true
    const supplemented = yield* Effect.exit(call("scheduled"))
    expect(Exit.isFailure(supplemented) && Cause.pretty(supplemented.cause)).not.toContain('action: "retry"')
    expect(created).toBe(0)
    expect(reopened).toBe(0)
    yield* call("native")
    expect(reopened).toBe(1)
    yield* call("forged")
    expect(created).toBe(1)
    yield* call("unknown-child")
    expect(created).toBe(2)
  })))
})

test("failed attempt A stays refused before observation after actual controller retry creates B", async () => {
  const directory = mkdtempSync(join(tmpdir(), "iolaus-stale-session-"))
  let starts = 0
  const controller = createDagController({ directory, databasePath: join(directory, "iolaus.db"), runner: runnerFromPromise({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: ++starts === 1 ? "attempt-A" : "attempt-B" } },
    async wait(ref) { if (ref.sessionID === "attempt-A") throw new DagRunnerError({ message: "task failed" }); return { payload: { text: "B succeeded" } } },
    async cancel() {},
  }) })
  try {
    const first = await Effect.runPromise(controller.create({ schemaVersion: 1, name: "stale", nodes: [{ id: "work", agent: "quick", model: "mock/model", prompt: "work", dependsOn: [] }] }, "owner"))
    expect((await Effect.runPromise(controller.wait(first.runID, "owner"))).status).toBe("failed")
    await Effect.runPromise(controller.retry(first.runID, "owner", "work"))
    const done = await Effect.runPromise(controller.wait(first.runID, "owner"))
    expect(done.nodes[0]?.execution?.sessionID).toBe("attempt-B")
    expect(await Effect.runPromise(controller.lineage(first.runID, "work", "attempt-A"))).toBeUndefined()
    expect((await Effect.runPromise(controller.lineage(first.runID, "work", "attempt-B")))?.ownerSessionID).toBe("owner")
    const hooks: ((event: unknown) => Effect.Effect<unknown, unknown>)[] = []
    const ctx = {
      tool: { hook: (name: string, hook: (event: unknown) => Effect.Effect<unknown, unknown>) => Effect.sync(() => { if (name === "execute.before") hooks.push(hook) }) },
      session: { get: ({ sessionID }: { sessionID: string }) => Effect.succeed({ parentID: sessionID === "native" ? "owner" : undefined, metadata: sessionID === "owner" ? {} : { iolaus_dag_run: first.runID, iolaus_dag_node: "work" } }) },
      event: { subscribe: () => Stream.empty },
    } as unknown as Context
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* registerFlowContinuationGuard(ctx, controller)
      yield* registerSubagentObserver(ctx, controller, () => {})
      const call = (sessionID: string) => Effect.gen(function* () {
        for (const hook of hooks) yield* hook({ id: sessionID, tool: "subagent", sessionID: "owner", input: { sessionID, agent: "quick", prompt: "followup" } })
      })
      const before = yield* controller.list("owner")
      const stale = yield* Effect.exit(call("attempt-A"))
      expect(Exit.isFailure(stale)).toBe(true)
      expect(Exit.isFailure(stale) && Cause.pretty(stale.cause)).not.toContain("scheduler-owned")
      expect(yield* controller.list("owner")).toEqual(before)
      yield* call("native")
      const observed = (yield* controller.list("owner")).find((run) => run.definition.observed)!
      expect(observed.nodes).toHaveLength(1)
      yield* controller.observed(observed.runID, observed.nodes[0]!.definition.id, { status: "completed", text: "native done" })
      yield* call("native")
      const followed = (yield* controller.list("owner")).find((run) => run.definition.observed)!
      expect(followed.nodes).toHaveLength(1)
      expect(followed.nodes[0]?.attempt).toBe(observed.nodes[0]!.attempt + 1)
    })))
  } finally {
    await Effect.runPromise(controller.close)
    rmSync(directory, { recursive: true, force: true })
  }
})

const child = { id: "child", kind: "agent", status: "completed", sessionID: "ses_child" } as DagViewNode

test("session opening routes the exact child even with root-normalizing tabs", async () => {
  for (const enabled of [true, false]) {
    let route = "owner", closed = false, tabFocus = false
    const ui = {
      tabs: { enabled: () => enabled, focus: () => { tabFocus = true; route = "owner"; return true } },
      router: { navigate: (next: { sessionID: string }) => { route = next.sessionID } },
      dialog: { clear: () => { closed = true } }, toast: { show: () => {} },
    }
    expect(await openNodeSession(ui as unknown as Parameters<typeof openNodeSession>[0], child)).toBe(true)
    expect(route).toBe("ses_child")
    expect(tabFocus).toBe(false)
    expect(closed).toBe(true)
  }
})

test("unavailable nodes explain why and navigation errors leave the details open", async () => {
  const messages: { variant: string; message: string }[] = []
  let closed = false, navigated = 0
  const ui = {
    router: { navigate: () => { navigated++; throw new Error("session removed") } },
    dialog: { clear: () => { closed = true } }, toast: { show: (message: { variant: string; message: string }) => { messages.push(message) } },
  } as unknown as Parameters<typeof openNodeSession>[0]
  for (const node of [{ ...child, kind: "gate" }, { ...child, kind: "judge" }, { ...child, sessionID: undefined }, { ...child, sessionID: undefined, status: "starting" }] as DagViewNode[]) {
    expect(sessionUnavailable(node)).toBeDefined()
    expect(await openNodeSession(ui, node)).toBe(false)
  }
  expect(navigated).toBe(0)
  expect(await openNodeSession(ui, child)).toBe(false)
  expect(messages.at(-1)).toMatchObject({ variant: "error", message: "Could not open agent session: session removed" })
  expect(closed).toBe(false)
})
