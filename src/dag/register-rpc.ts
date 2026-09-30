import { Effect } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { DagController } from "./controller"
import type { DagNodeStatus, DagRunStatus } from "./types"
import { IOLAUS_DAG_RPC, type DagView } from "./rpc"

const SETTLED_RUN: readonly DagRunStatus[] = ["completed", "failed", "cancelled", "interrupted"]
const IN_FLIGHT: readonly DagNodeStatus[] = ["ready", "starting", "running", "cancel_requested"]

/** A finished run has no work in flight; rows written before cancel settled every node show how the run ended instead. */
export function viewNodeStatus(run: DagRunStatus, node: DagNodeStatus): DagNodeStatus {
  if (!SETTLED_RUN.includes(run) || !IN_FLIGHT.includes(node)) return node
  return run === "cancelled" ? "cancelled" : "interrupted"
}

/** The node's title, else the first line of its prompt that is not a marker or a section label. */
export function nodeSummary(title: string | undefined, prompt: string): string | undefined {
  if (title?.trim()) return title.trim().slice(0, 160)
  for (const raw of prompt.split("\n")) {
    const line = raw.replace(/<\/?iolaus-[^>]*>/g, "").replace(/^\s*(TASK|GOAL|REQUEST)\s*:\s*/i, "").trim()
    if (line) return line.length > 160 ? `${line.slice(0, 159)}…` : line
  }
  return undefined
}

export function dagView(controller: DagController, sessionID: string): Effect.Effect<DagView> {
  return controller.list(sessionID).pipe(Effect.map((runs) => ({ runs: runs.slice(0, 50).map((run) => ({
    runID: run.runID, name: run.name, generation: run.generation,
    status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
    // The host validates RPC output as JSON before the zod schema; undefined is not JSON, so optional fields are omitted.
    nodes: run.nodes.map((node) => {
      // A gate's prompt is shown in full as the approval request, so it is not summarised.
      const title = node.definition.kind === "gate" ? node.definition.title : nodeSummary(node.definition.title, node.definition.prompt)
      return {
      id: node.definition.id, status: viewNodeStatus(run.status, node.status), attempt: node.attempt,
      ...(title ? { title } : {}),
      kind: node.definition.kind ?? "agent",
      agent: node.definition.agent ?? "", model: node.definition.model ?? "",
      dependsOn: [...node.definition.dependsOn],
      ...(node.definition.kind === "gate" ? { prompt: node.definition.prompt } : {}),
      ...(node.error !== undefined ? { error: node.error } : {}),
      ...(node.execution?.sessionID !== undefined ? { sessionID: node.execution.sessionID } : {}),
      ...(node.result ? { result: JSON.stringify(node.result.payload).slice(0, 16000), resultAttempt: node.result.attempt } : {}),
      }
    }),
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
