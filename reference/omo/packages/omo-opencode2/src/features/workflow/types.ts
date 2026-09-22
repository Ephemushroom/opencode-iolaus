import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Data, Schema } from "effect"
import { RunRef } from "../../orchestration/execution/types"

export const WorkflowID = Schema.String.pipe(Schema.brand("Omo.WorkflowID"))
export type WorkflowID = typeof WorkflowID.Type
export const NodeID = Schema.String.pipe(Schema.brand("Omo.WorkflowNodeID"))
export const Node = Schema.Struct({
  id: NodeID, prompt: Schema.String, agent: Agent.ID, model: Model.Ref,
  dependsOn: Schema.Array(NodeID),
})
export type Node = typeof Node.Type
export const Start = Schema.Struct({ key: Schema.String, nodes: Schema.Array(Node) })
export type Start = typeof Start.Type
export const NodeState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("running"), ref: RunRef }),
  Schema.Struct({ status: Schema.Literal("completed"), ref: RunRef, output: Schema.String }),
  Schema.Struct({ status: Schema.Literals(["failed", "cancelled", "blocked"]), ref: Schema.optional(RunRef), reason: Schema.String }),
])
export type NodeState = typeof NodeState.Type
export const WorkflowRecord = Schema.Struct({
  version: Schema.Literal(1), id: WorkflowID, caller: Session.ID, key: Schema.String,
  generation: Schema.Number, status: Schema.Literals(["running", "cancelling", "completed", "failed", "cancelled"]),
  nodes: Schema.Array(Schema.Struct({ definition: Node, state: NodeState })),
  retryKeys: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
})
export type WorkflowRecord = typeof WorkflowRecord.Type

export class WorkflowError extends Data.TaggedError("WorkflowError")<{
  readonly code: "empty" | "duplicate" | "unknown-dependency" | "self-dependency" | "cycle" | "conflict" | "not-found" | "forbidden" | "inactive" | "storage" | "execution"
  readonly message: string
}> {}

export function terminal(record: WorkflowRecord): boolean {
  return record.status === "completed" || record.status === "failed" || record.status === "cancelled"
}
