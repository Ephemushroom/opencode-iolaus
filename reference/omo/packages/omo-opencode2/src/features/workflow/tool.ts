import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { assertNever } from "../../orchestration/execution/types"
import type { Workflow } from "./contracts"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { NodeID, WorkflowError, WorkflowID, WorkflowRecord, type Start } from "./types"

const RawNode = Schema.Struct({ id: Schema.String, prompt: Schema.String, agent: Schema.String, model: Schema.String, dependsOn: Schema.Array(Schema.String) })
const RawStart = Schema.Struct({ key: Schema.String, nodes: Schema.Array(RawNode) })
export const WorkflowInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("start"), ...RawStart.fields }),
  Schema.Struct({ action: Schema.Literals(["snapshot", "wait", "cancel"]), id: Schema.String }),
  Schema.Struct({ action: Schema.Literal("retry"), id: Schema.String, expected_generation: Schema.Number, retry_key: Schema.String }),
])

function normalizeStart(input: Schema.Schema.Type<typeof RawStart>): Start {
  return { key: input.key, nodes: input.nodes.map((node) => ({ id: NodeID.make(node.id), prompt: node.prompt,
    agent: Agent.ID.make(node.agent), model: Model.Ref.parse(node.model), dependsOn: node.dependsOn.map((id) => NodeID.make(id)) })) }
}

export function createWorkflowTool(workflow: Workflow): Tool.Info<typeof WorkflowInput> {
  return {
    name: "workflow",
    description: "Start a keyed acyclic graph of executor tasks, inspect or wait for it, cancel it, or explicitly retry unsuccessful nodes. Each node declares id, prompt, agent, model reference and dependsOn. Retry retains successful nodes. No automatic restart recovery.",
    input: WorkflowInput,
    options: { codemode: false },
    execute: (input, context) => Effect.gen(function* () {
      switch (input.action) {
        case "start": {
           const start = yield* Effect.try({ try: () => normalizeStart(input),
             catch: (error) => new WorkflowError({ code: "conflict", message: error instanceof Error ? error.message : String(error) }) })
           return yield* workflow.start(start, context.sessionID)
        }
        case "snapshot": case "wait": case "cancel": {
          const id = WorkflowID.make(input.id)
          if (input.action === "snapshot") return yield* workflow.snapshot(id, context.sessionID)
          if (input.action === "wait") return yield* workflow.wait(id, context.sessionID)
          if (input.action === "cancel") return yield* workflow.cancel(id, context.sessionID)
           return yield* workflow.cancel(id, context.sessionID)
        }
        case "retry": return yield* workflow.retry(WorkflowID.make(input.id), context.sessionID,
          { expectedGeneration: input.expected_generation, key: input.retry_key })
        default: return assertNever(input)
      }
    }).pipe(Effect.map((record) => ({ content: JSON.stringify(record) })),
      Effect.mapError((error) => new Tool.Error({ message: error.message, error: { code: error.code } }))),
  }
}
