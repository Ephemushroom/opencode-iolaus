import type { Context } from "@opencode/plugin/promise/plugin"
import type { DagController } from "./controller"
import { IOLAUS_DAG_RPC, type DagView } from "./rpc"

export async function dagView(controller: DagController, sessionID: string): Promise<DagView> {
  const runs = await controller.list(sessionID)
  return { runs: runs.slice(0, 50).map((run) => ({
    runID: run.runID, name: run.name, generation: run.generation,
    status: run.status, updatedAt: run.updatedAt,
    nodes: run.nodes.map((node) => ({
      id: node.definition.id, status: node.status, attempt: node.attempt,
      agent: node.definition.agent, model: node.definition.model,
      dependsOn: [...node.definition.dependsOn], error: node.error,
      sessionID: node.execution?.sessionID,
      result: node.result ? JSON.stringify(node.result.payload).slice(0, 16000) : undefined,
    })),
  })) }
}

export async function registerDagRpc(ctx: Pick<Context, "rpc">, controller: DagController) {
  return ctx.rpc.register(IOLAUS_DAG_RPC, {
    snapshot: ({ sessionID }) => dagView(controller, sessionID),
    action: async (input, call) => {
      try {
        if (input.action === "cancel") await controller.cancel(input.runID, input.sessionID, input.generation)
        else await controller.retry(input.runID, input.sessionID, input.nodeID, input.generation)
        return await dagView(controller, input.sessionID)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return call.error("rejected", reason, { reason })
      }
    },
  })
}
