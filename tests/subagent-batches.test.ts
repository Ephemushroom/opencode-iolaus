import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { createDagController } from "../src/dag/controller"
import { registerSubagentObserver } from "../src/dag/observe"
import { runnerFromPromise } from "../src/dag/runner"
import { DagStore } from "../src/dag/store"
import { dagView } from "../src/dag/register-rpc"
import { orderNodes, runLabel } from "../src/tui/view"
import type { DagRunRecord } from "../src/dag/types"

test("real observer groups parallel and sequential calls by delivered user request, not owner or assistant", async () => {
  const directory = mkdtempSync(join(tmpdir(), "iolaus-batches-"))
  const controller = createDagController({ directory, databasePath: join(directory, "iolaus.db"), runner: runnerFromPromise({
    async start() { throw new Error("not scheduled") }, async wait() { throw new Error("not scheduled") }, async cancel() {},
  }) })
  const hooks = new Map<string, (event: unknown) => Effect.Effect<unknown, unknown>>()
  let messages: unknown[] = [{ id: "request-one", type: "user" }, { id: "assistant-one", type: "assistant" }]
  const ctx = {
    tool: { hook: (name: string, hook: (event: unknown) => Effect.Effect<unknown, unknown>) => Effect.sync(() => { hooks.set(name, hook) }) },
    session: { get: () => Effect.succeed({}), context: () => Effect.succeed(messages) },
    event: { subscribe: () => Stream.empty },
  } as unknown as Context
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* registerSubagentObserver(ctx, controller, () => {})
      const call = (index: number, messageID: string) => hooks.get("execute.before")!({ id: `call-${index}`, sessionID: "owner", messageID, tool: "subagent", input: { agent: "quick", description: `Work ${index}`, prompt: "work" } })
      yield* Effect.all([call(1, "assistant-one"), call(2, "assistant-one")], { concurrency: "unbounded" })
      messages.push({ id: "notice", type: "synthetic" }, { id: "assistant-two", type: "assistant" })
      for (let index = 3; index <= 12; index++) yield* call(index, "assistant-two")
      const first = (yield* controller.list("owner"))[0]!
      expect(first.nodes.map((node) => node.definition.id)).toEqual(Array.from({ length: 12 }, (_, index) => `${index + 1}-work-${index + 1}`))
      for (const node of first.nodes) yield* controller.observed(first.runID, node.definition.id, { status: "failed", error: "old failure" })
      messages.push({ id: "request-two", type: "user" }, { id: "assistant-three", type: "assistant" }, { id: "later-steer", type: "user" })
      yield* call(13, "assistant-three")
      const groups = yield* controller.list("owner")
      expect(groups).toHaveLength(2)
      const fresh = groups.find((group) => group.runID !== first.runID)!
      expect(fresh.status).toBe("running")
      expect(fresh.definition.observedBatch).toEqual({ kind: "request", id: "request-two" })
      expect(fresh.nodes.map((node) => node.definition.id)).toEqual(["1-work-13"])
      expect(fresh.createdAt).toBeGreaterThanOrEqual(first.updatedAt)
      expect((yield* controller.snapshot(first.runID, "owner")).run.status).toBe("failed")
      yield* call(14, "missing-assistant")
      yield* call(14, "missing-assistant")
      expect(yield* controller.list("owner")).toHaveLength(4)
      messages = [{ id: "compacted-assistant", type: "assistant" }]
      yield* call(16, "compacted-assistant")
      yield* call(17, "compacted-assistant")
      expect(yield* controller.list("owner")).toHaveLength(6)
    })))
  } finally {
    await Effect.runPromise(controller.close)
    rmSync(directory, { recursive: true, force: true })
  }
})

test("source flows, nested lineage, later followups, reload and historical records retain exact provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "iolaus-batch-lineage-"))
  const databasePath = join(directory, "iolaus.db")
  const runner = runnerFromPromise({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: `scheduled-${input.runID}` } },
    async wait() { return { payload: { text: "done" } } }, async cancel() {},
  })
  let controller = createDagController({ directory, databasePath, runner })
  const metadata = new Map<string, unknown>()
  const hooks = new Map<string, (event: unknown) => Effect.Effect<unknown, unknown>>()
  const ctx = {
    tool: { hook: (name: string, hook: (event: unknown) => Effect.Effect<unknown, unknown>) => Effect.sync(() => { hooks.set(name, hook) }) },
    session: {
      get: ({ sessionID }: { sessionID: string }) => Effect.succeed({ metadata: metadata.get(sessionID) }),
      context: () => Effect.succeed([{ id: "later-request", type: "user" }, { id: "assistant", type: "assistant" }]),
    },
    event: { subscribe: () => Stream.empty },
  } as unknown as Context
  const call = (id: string, caller: string, child: string, followed = false) => Effect.gen(function* () {
    yield* hooks.get("execute.before")!({ id, sessionID: caller, messageID: "assistant", tool: "subagent", input: { agent: "quick", description: id, prompt: "work", ...(followed ? { sessionID: child } : {}) } })
    yield* hooks.get("execute.after")!({ id, sessionID: caller, tool: "subagent", status: "success", result: { output: { sessionID: child, status: "completed", output: "done" } } })
  })
  try {
    const sources: DagRunRecord[] = []
    for (const name of ["first", "second"]) {
      const created = await Effect.runPromise(controller.create({ schemaVersion: 1, name, nodes: [{ id: "work", agent: "quick", model: "mock/model", prompt: "go", dependsOn: [] }] }, "owner"))
      const settled = await Effect.runPromise(controller.wait(created.runID, "owner"))
      sources.push(settled)
      metadata.set(settled.nodes[0]!.execution!.sessionID, { iolaus_dag_run: created.runID, iolaus_dag_node: "work" })
    }
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* registerSubagentObserver(ctx, controller, () => {})
      for (const source of sources) {
        yield* call(source.name, source.nodes[0]!.execution!.sessionID, `child-${source.name}`)
        yield* call(`nested-${source.name}`, `child-${source.name}`, `grandchild-${source.name}`)
        expect((yield* controller.snapshot(source.runID, "owner")).run.definition).toEqual(source.definition)
      }
    })))
    const batches = (await Effect.runPromise(controller.list("owner"))).filter((run) => run.definition.observed)
    expect(batches).toHaveLength(2)
    for (const batch of batches) {
      expect(batch.definition.observedBatch?.kind).toBe("flow")
      expect(batch.nodes).toHaveLength(2)
      expect(batch.nodes[1]!.definition.dependsOn).toEqual([batch.nodes[0]!.definition.id])
    }
    const original = batches.find((run) => run.definition.observedBatch?.id === sources[0]!.runID)!
    await Effect.runPromise(controller.close)
    const store = new DagStore(databasePath, directory)
    const { observedBatch: _, ...legacyDefinition } = original.definition
    store.createRun({ ...original, runID: "legacy", definition: legacyDefinition, createdAt: 1, updatedAt: 2, nodes: original.nodes.map((node) => ({ ...node, execution: undefined })) })
    const legacy = store.getRun("legacy")
    store.close()
    controller = createDagController({ directory, databasePath, runner })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* registerSubagentObserver(ctx, controller, () => {})
      yield* call("followup", "owner", "child-first", true)
      yield* call("after-reload", "child-first", "new-grandchild")
      yield* call("new-request", "owner", "new-child")
      const kept = (yield* controller.snapshot(original.runID, "owner")).run
      expect(kept.nodes[0]!.attempt).toBe(2)
      expect(kept.nodes).toHaveLength(3)
      expect(kept.nodes[2]!.definition.dependsOn).toEqual([kept.nodes[0]!.definition.id])
      expect((yield* controller.snapshot("legacy", "owner")).run).toEqual(legacy!)
      const view = yield* dagView(controller, "owner")
      expect(runLabel(view.runs.find((run) => run.runID === "legacy")!)).toBe("Calls · historical aggregate")
      expect(view.runs.filter((run) => run.observed)).toHaveLength(4)
      expect(runLabel(view.runs.find((run) => !run.observed)!)).toStartWith("Flow · ")
      const batchView = view.runs.find((run) => run.runID === original.runID)!
      expect(orderNodes(batchView).map((node) => node.id)).toEqual(kept.nodes.map((node) => node.definition.id))
      const invalid = yield* Effect.exit(controller.observe({ ownerSessionID: "owner", batch: { kind: "request", id: "other-request" }, agent: "quick", title: "invalid", prompt: "", parentNodeID: kept.nodes[0]!.definition.id }))
      expect(invalid._tag).toBe("Failure")
      metadata.set("forged", { iolaus_dag_run: sources[0]!.runID, iolaus_dag_node: "work" })
      yield* call("forged", "forged", "forged-child")
      expect((yield* controller.list("forged"))[0]!.definition.observedBatch?.kind).toBe("request")
    })))
    await Effect.runPromise(controller.close)
    controller = createDagController({ directory, databasePath, runner })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* registerSubagentObserver(ctx, controller, () => {})
      yield* call("continued-request", "owner", "continued-child")
      const requests = (yield* controller.list("owner")).filter((run) => run.definition.observedBatch?.kind === "request")
      expect(requests).toHaveLength(1)
      expect(requests[0]!.nodes.map((node) => node.definition.title)).toEqual(["new-request", "continued-request"])
    })))
  } finally {
    await Effect.runPromise(controller.close)
    rmSync(directory, { recursive: true, force: true })
  }
})
