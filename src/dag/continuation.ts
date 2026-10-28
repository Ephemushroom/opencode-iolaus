import { Effect, type Scope } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import type { DagController } from "./controller"

export function registerFlowContinuationGuard(ctx: Context, controller: DagController): Effect.Effect<void, never, Scope.Scope> {
  return ctx.tool.hook("execute.before", (event) => Effect.gen(function* () {
    if (event.tool !== "subagent") return
    const input = event.input as { sessionID?: unknown }
    if (typeof input.sessionID !== "string") return
    const session = yield* ctx.session.get({ sessionID: input.sessionID as never }).pipe(Effect.mapError(() => new Tool.Error({ message: "[iolaus subagent] Continuation target is unavailable. Use an existing direct child session returned by your native subagent call, or start a new subagent with complete context." })))
    const metadata = session.metadata as Record<string, unknown> | undefined
    const run = typeof metadata?.iolaus_dag_run === "string" && typeof metadata.iolaus_dag_node === "string"
      ? yield* controller.lineage(metadata.iolaus_dag_run, metadata.iolaus_dag_node, input.sessionID) : undefined
    if (!run) {
      if (session.parentID === event.sessionID) return
      return yield* Effect.fail(new Tool.Error({ message: "[iolaus subagent] Continuation requires a direct native child of this calling session. Use the sessionID returned by your own native subagent call, inspect a Flow through its owning session with iolaus_flow, or start a new subagent with complete context. This call was not recorded or replayed." }))
    }
    const node = run.nodes.find((candidate) => candidate.definition.id === metadata?.iolaus_dag_node)!
    const owner = String(event.sessionID) === run.ownerSessionID
    const snapshot = owner ? yield* controller.snapshot(run.runID, run.ownerSessionID).pipe(Effect.mapError((error) => new Tool.Error({ message: error.message }))) : undefined
    const steered = snapshot?.steering?.some((request) => request.nodeID === node.definition.id) === true
    const target = `run_id: "${run.runID}", node_id: "${node.definition.id}"`
    const next = !owner ? "Ask the owning Flow session to inspect its node and choose the supported action."
      : node.status === "running" && node.runtime?.initial === "admitted" && node.execution?.identity && !run.authorizedPlan
        ? `Use iolaus_flow action: "steer", ${target}, text and a unique request_id to supplement the active task, subject to steering permissions and eligibility.`
        : ["failed", "interrupted", "needs_retry"].includes(node.status) && !steered && node.runtime?.initial !== "unresolved"
          ? `Use iolaus_flow action: "retry", ${target} to rerun the task in a fresh session, subject to retry eligibility; this is not conversational continuation.`
          : "For additional work, create a new Flow or native subagent with the complete context. Inspect the existing node with iolaus_flow first; completed nodes are not conversation continuations."
    return yield* Effect.fail(new Tool.Error({ message: `[iolaus flow] This session is scheduler-owned, not a native subagent child. subagent({sessionID}) cannot continue it.${owner ? ` Flow target: ${target}.` : ""} ${next}` }))
  }))
}
