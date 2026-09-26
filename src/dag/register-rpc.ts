import { Effect } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { DagController } from "./controller"
import { IOLAUS_DAG_RPC, type DagView } from "./rpc"

export function dagView(controller: DagController, sessionID: string): Effect.Effect<DagView> {
  return controller.list(sessionID).pipe(Effect.map((runs) => ({ runs: runs.slice(0, 50).map((run) => ({
    runID: run.runID, name: run.name, generation: run.generation,
    status: run.status, updatedAt: run.updatedAt,
    // The host validates RPC output as JSON before the zod schema; undefined is not JSON, so optional fields are omitted.
    nodes: run.nodes.map((node) => ({
      id: node.definition.id, status: node.status, attempt: node.attempt,
      kind: node.definition.kind ?? "agent",
      agent: node.definition.agent ?? "", model: node.definition.model ?? "",
      dependsOn: [...node.definition.dependsOn],
      ...(node.definition.kind === "gate" ? { prompt: node.definition.prompt } : {}),
      ...(node.error !== undefined ? { error: node.error } : {}),
      ...(node.execution?.sessionID !== undefined ? { sessionID: node.execution.sessionID } : {}),
      ...(node.result ? { result: JSON.stringify(node.result.payload).slice(0, 16000) } : {}),
    })),
  })) })))
}

export function registerDagRpc(ctx: Pick<Context, "rpc">, controller: DagController) {
  return ctx.rpc.register(IOLAUS_DAG_RPC, {
    snapshot: ({ sessionID }) => dagView(controller, sessionID),
    action: (input, call) => {
      const nodeID = input.nodeID
      const act = input.action === "cancel" ? controller.cancel(input.runID, input.sessionID, input.generation)
        : input.action === "approve" ? (nodeID ? controller.approve(input.runID, input.sessionID, nodeID, input.note, input.generation) : Effect.fail(new Error("nodeID is required for gate decisions")))
        : input.action === "reject" ? (nodeID ? controller.reject(input.runID, input.sessionID, nodeID, input.note, input.generation) : Effect.fail(new Error("nodeID is required for gate decisions")))
        : controller.retry(input.runID, input.sessionID, nodeID, input.generation)
      return act.pipe(
        Effect.flatMap(() => dagView(controller, input.sessionID)),
        Effect.catch((error) => { const reason = error instanceof Error ? error.message : String(error); return Effect.fail(call.error("rejected", reason, { reason })) }),
      )
    },
  })
}
