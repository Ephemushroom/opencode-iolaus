import { Deferred, Effect, Semaphore } from "effect"
import { assertNever, type TerminalRecord } from "../../orchestration/execution/types"
import type { Entry, Runtime } from "./contracts"
import { save } from "./records"
import { WorkflowError, type NodeState, type WorkflowRecord } from "./types"

function settled(result: TerminalRecord): NodeState {
  switch (result.status) {
    case "completed": return { status: "completed", ref: result.ref, output: result.output }
    case "failed": case "interrupted": return { status: "failed", ref: result.ref, reason: result.reason ?? result.status }
    case "cancelled": return { status: "cancelled", ref: result.ref, reason: result.reason ?? "Cancelled" }
    default: return assertNever(result.status)
  }
}

function readiness(dependencies: readonly NodeState[]): "ready" | "blocked" | "waiting" {
  let waiting = false
  for (const state of dependencies) {
    switch (state.status) {
      case "pending": case "running": waiting = true; break
      case "completed": break
      case "failed": case "cancelled": case "blocked": return "blocked"
      default: return assertNever(state)
    }
  }
  return waiting ? "waiting" : "ready"
}

export const advance: (runtime: Runtime, entry: Entry) => Effect.Effect<void> = Effect.fn("workflow.advance")(function* (runtime: Runtime, entry: Entry) {
  let changed = true
  while (changed && entry.record.status === "running") {
    changed = false
    for (const node of entry.record.nodes) {
      if (node.state.status !== "pending") continue
      const dependencies = entry.record.nodes.filter((item) => node.definition.dependsOn.includes(item.definition.id))
      const state = readiness(dependencies.map((item) => item.state))
      let next: NodeState
      switch (state) {
        case "waiting": continue
        case "blocked": next = { status: "blocked", reason: "A dependency did not complete successfully" }; break
        case "ready": {
          const submission = yield* Effect.result(runtime.executor.submit({
            kind: "fresh", agent: node.definition.agent, model: node.definition.model,
            text: node.definition.prompt,
            description: node.definition.id, background: false,
            owner: { kind: "workflow", callerSessionID: entry.record.caller, rootSessionID: entry.record.caller,
              workflowID: entry.record.id, nodeID: node.definition.id },
          }))
          switch (submission._tag) {
            case "Failure": next = { status: "failed", reason: submission.failure.message }; break
            case "Success": {
              const ref = submission.success
              next = { status: "running", ref }
              const watcher = Effect.gen(function* () {
                const result = yield* runtime.executor.wait(ref).pipe(Effect.mapError((error) => new WorkflowError({ code: "execution", message: error.message })))
                yield* Semaphore.withPermit(runtime.mutex)(Effect.gen(function* () {
                  yield* save(runtime, { ...entry.record, nodes: entry.record.nodes.map((item) =>
                    item.definition.id === node.definition.id ? { ...item, state: settled(result) } : item) })
                  yield* advance(runtime, entry)
                }).pipe(Effect.uninterruptible))
              }).pipe(Effect.catch((error) => Deferred.fail(entry.done, error)))
              yield* Effect.forkIn(watcher, runtime.scope)
              break
            }
            default: return assertNever(submission)
          }
          break
        }
        default: return assertNever(state)
      }
      yield* save(runtime, { ...entry.record, nodes: entry.record.nodes.map((item) =>
        item.definition.id === node.definition.id ? { ...item, state: next } : item) })
      changed = true
    }
  }
  if (entry.record.nodes.some((node) => node.state.status === "running" || node.state.status === "pending")) return
  const status: WorkflowRecord["status"] = entry.record.status === "cancelling" ? "cancelled"
    : entry.record.nodes.every((node) => node.state.status === "completed") ? "completed" : "failed"
  yield* save(runtime, { ...entry.record, status })
  yield* Deferred.succeed(entry.done, entry.record)
})
