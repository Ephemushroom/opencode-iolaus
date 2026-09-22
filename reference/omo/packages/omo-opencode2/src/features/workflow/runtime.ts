import { createHash } from "node:crypto"
import { Deferred, Effect, Exit, Scope, Semaphore } from "effect"
import type { Entry, Runtime, Workflow, WorkflowOptions } from "./contracts"
import type { RunRef } from "../../orchestration/execution/types"
import { validateGraph } from "./graph"
import { owned, read, save } from "./records"
import { advance } from "./scheduler"
import { terminal, WorkflowError, WorkflowID, type WorkflowRecord } from "./types"

export const createWorkflow = Effect.fn("workflow.create")(function* (options: WorkflowOptions) {
  const runtime: Runtime = { ...options, entries: new Map(), closed: false,
    mutex: yield* Semaphore.make(1), scope: yield* Scope.make() }
  const locked = Semaphore.withPermit(runtime.mutex)
  const cancelEntries = Effect.fn("workflow.cancelEntries")(function* (entries: readonly Entry[]) {
    const refs: RunRef[] = []
    for (const entry of entries) {
      yield* save(runtime, { ...entry.record, status: "cancelling", nodes: entry.record.nodes.map((node) => node.state.status === "pending"
        ? { ...node, state: { status: "cancelled", reason: "Workflow cancelled before submission" } } : node) })
      for (const node of entry.record.nodes) if (node.state.status === "running") refs.push(node.state.ref)
    }
    yield* runtime.executor.cancelMany(refs).pipe(Effect.mapError((error) => new WorkflowError({ code: "execution", message: error.message })))
    for (const entry of entries) yield* advance(runtime, entry)
  })
  const workflow: Workflow = {
  start: (input, caller) => Effect.gen(function* () {
      if (yield* runtime.executor.managed(caller)) return yield* new WorkflowError({ code: "forbidden", message: "Nested workflows are not supported" })
      if (input.key.trim().length === 0) return yield* new WorkflowError({ code: "empty", message: "Workflow key must be nonempty" })
      yield* validateGraph(input.nodes)
      return yield* locked(Effect.gen(function* () {
        if (runtime.closed) return yield* new WorkflowError({ code: "inactive", message: "Workflow runtime is closed" })
        const id = WorkflowID.make(createHash("sha256").update(JSON.stringify([caller, input.key])).digest("hex"))
        const existing = yield* read(runtime, id)
        if (existing) {
          if (JSON.stringify(existing.nodes.map((node) => node.definition)) !== JSON.stringify(input.nodes)) {
            return yield* new WorkflowError({ code: "conflict", message: "Idempotency key already names a different graph" })
          }
          return yield* owned(runtime, { id, caller })
        }
        for (const node of input.nodes) {
          if (!runtime.agents.has(node.agent)) return yield* new WorkflowError({ code: "forbidden", message: `Unknown workflow agent: ${node.agent}` })
        }
        const record: WorkflowRecord = { version: 1, id, caller, key: input.key, generation: 1,
          status: "running", nodes: input.nodes.map((definition) => ({ definition, state: { status: "pending" } })) }
        const entry = { record, done: yield* Deferred.make<WorkflowRecord, WorkflowError>() }
        runtime.entries.set(id, entry)
        yield* save(runtime, record)
        yield* advance(runtime, entry)
        return entry.record
      }).pipe(Effect.uninterruptible))
    }),
    snapshot: (id, caller) => locked(owned(runtime, { id, caller })),
    wait: (id, caller) => Effect.gen(function* () {
      const current = yield* locked(Effect.gen(function* () {
        const record = yield* owned(runtime, { id, caller })
        return { record, done: runtime.entries.get(id)?.done }
      }))
      if (terminal(current.record)) return current.record
      if (!current.done) return yield* new WorkflowError({ code: "inactive", message: "Unfinished workflow has no live owner; automatic recovery is unsupported" })
      return yield* Deferred.await(current.done)
    }),
    cancel: (id, caller) => locked(Effect.gen(function* () {
      const record = yield* owned(runtime, { id, caller })
      if (terminal(record)) return record
      const entry = runtime.entries.get(id)
      if (!entry) return yield* new WorkflowError({ code: "inactive", message: "Workflow has no live owner" })
      yield* cancelEntries([entry])
      return entry.record
    }).pipe(Effect.uninterruptible)),
    retry: (id, caller, request) => locked(Effect.gen(function* () {
      const record = yield* owned(runtime, { id, caller })
      if (runtime.closed) return yield* new WorkflowError({ code: "inactive", message: "Workflow runtime is closed" })
      if (request.key.trim().length === 0 || !Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 1) {
        return yield* new WorkflowError({ code: "conflict", message: "Retry requires a nonempty key and positive expected generation" })
      }
      if (Object.hasOwn(record.retryKeys ?? {}, request.key)) {
        if (record.retryKeys?.[request.key] === request.expectedGeneration) return record
        return yield* new WorkflowError({ code: "conflict", message: "Retry key already names another generation" })
      }
      if (record.generation !== request.expectedGeneration) return yield* new WorkflowError({ code: "conflict", message: "Workflow generation has changed" })
      if (record.status !== "failed" && record.status !== "cancelled") {
        return yield* new WorkflowError({ code: "conflict", message: "Retry requires a failed or cancelled terminal workflow" })
      }
      const entry = { record, done: yield* Deferred.make<WorkflowRecord, WorkflowError>() }
      runtime.entries.set(id, entry)
      yield* save(runtime, { ...record, status: "running", generation: record.generation + 1,
        retryKeys: { ...record.retryKeys, [request.key]: request.expectedGeneration },
        nodes: record.nodes.map((node) => node.state.status === "completed" ? node : { ...node, state: { status: "pending" } }) })
      yield* advance(runtime, entry)
      return entry.record
    }).pipe(Effect.uninterruptible)),
  }
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    runtime.closed = true
    yield* locked(cancelEntries([...runtime.entries.values()].filter((entry) => !terminal(entry.record))))
    for (const entry of runtime.entries.values()) {
      if (!terminal(entry.record)) yield* Deferred.await(entry.done)
    }
  }).pipe(Effect.ensuring(Scope.close(runtime.scope, Exit.void)), Effect.orDie))
  return workflow
})
