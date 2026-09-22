import type { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import type { Runtime } from "./contracts"
import { terminal, WorkflowError, WorkflowRecord, type WorkflowID } from "./types"
import { isTerminal } from "../../orchestration/execution/types"

export const save = Effect.fn("workflow.save")(function* (runtime: Runtime, record: WorkflowRecord) {
  yield* runtime.storage.set(runtime.prefix + record.id, Schema.encodeSync(WorkflowRecord)(record))
  const entry = runtime.entries.get(record.id)
  if (entry) entry.record = record
})

export const read = Effect.fn("workflow.read")(function* (runtime: Runtime, id: WorkflowID) {
  const live = runtime.entries.get(id)
  if (live) return live.record
  const stored = yield* runtime.storage.get(runtime.prefix + id)
  if (stored === undefined) return undefined
  return yield* Schema.decodeUnknownEffect(WorkflowRecord)(stored).pipe(
    Effect.mapError(() => new WorkflowError({ code: "storage", message: `Invalid workflow record ${id}` })),
  )
})

export const owned = Effect.fn("workflow.owned")(function* (
  runtime: Runtime, lookup: { readonly id: WorkflowID; readonly caller: Session.ID },
) {
  const record = yield* read(runtime, lookup.id)
  if (!record) return yield* new WorkflowError({ code: "not-found", message: "Unknown workflow" })
  if (record.caller !== lookup.caller) return yield* new WorkflowError({ code: "forbidden", message: "Workflow belongs to another caller" })
  if (!runtime.entries.has(record.id) && !terminal(record)) {
    const nodes: WorkflowRecord["nodes"][number][] = []
    for (const node of record.nodes) {
      if (node.state.status !== "running") { nodes.push(node); continue }
      const result = yield* runtime.executor.snapshot(node.state.ref).pipe(
        Effect.mapError((error) => new WorkflowError({ code: "inactive", message: error.message })),
      )
      if (!isTerminal(result)) return yield* new WorkflowError({ code: "inactive", message: "Saved workflow execution is still active; refusing takeover" })
      nodes.push({ ...node, state: result.status === "completed"
        ? { status: "completed", ref: result.ref, output: result.output }
        : { status: "failed", ref: result.ref, reason: result.reason ?? `Recovered ${result.status} execution; explicit retry required` } })
    }
    const recovered: WorkflowRecord = { ...record, nodes,
      status: nodes.every((node) => node.state.status === "completed") ? "completed" : "failed" }
    yield* save(runtime, recovered)
    return recovered
  }
  return record
})
