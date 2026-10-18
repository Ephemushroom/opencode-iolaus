import { Effect } from "effect"
import type { Tool } from "@opencode/schema/tool"
import type { DagController } from "./controller"
import type { DagDefinition } from "./types"
import { DAG_TEMPLATE_NAMES, expandTemplate } from "./templates"

/**
 * The model-facing name. Specialist deny lists, the Atlas and planner guards and their tests use this constant, so a
 * rename cannot leave one of them checking a name the host no longer offers.
 */
export const FLOW_TOOL_NAME = "iolaus_flow"

type DagInput = {
  readonly action?: unknown
  readonly run_id?: unknown
  readonly node_id?: unknown
  readonly note?: unknown
  readonly text?: unknown
  readonly request_id?: unknown
  readonly definition?: unknown
  readonly template?: unknown
}

const inputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["create", "template", "snapshot", "node", "wait", "cancel", "retry", "resume", "approve", "reject", "amend", "steer"] },
    run_id: { type: "string" },
    node_id: { type: "string" },
    note: { type: "string" },
    text: { type: "string", minLength: 1, description: "Supplemental task information for an active scheduled child; never changes its agent or model." },
    request_id: { type: "string", minLength: 1, description: "Required for steer. A stable unique request id; reuse only for the same node and text to inspect its durable delivery state without resending." },
    definition: { type: "object" },
    template: {
      type: "object",
      description: "For action \"template\" (expand only) or \"create\" without definition (expand and run). {template, task, name?, reviewer?, executor?, lead?, gate?, maxAttempts?, iterations?, members?}.",
      properties: {
        template: { type: "string", enum: [...DAG_TEMPLATE_NAMES] },
        task: { type: "string" }, name: { type: "string" }, reviewer: { type: "string" }, executor: { type: "string" }, lead: { type: "string" },
        gate: { type: "boolean" }, maxAttempts: { type: "integer", minimum: 1 },
        iterations: { type: "integer", minimum: 1, maximum: 10 }, members: { type: "array", items: { type: "string" }, minItems: 2 },
      },
      required: ["template", "task"],
      additionalProperties: false,
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("DAG input must be an object")
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}

function definition(value: unknown): DagDefinition {
  return asObject(value) as unknown as DagDefinition
}

function content(value: unknown): { content: string } {
  return { content: JSON.stringify(value) }
}

function errorText(cause: unknown): string {
  const squashed = (cause as { failures?: unknown; defects?: unknown })
  const first = Array.isArray((squashed as { reasons?: unknown[] }).reasons) ? (squashed as { reasons: { error?: unknown; defect?: unknown }[] }).reasons[0] : undefined
  const error = first?.error ?? first?.defect ?? cause
  return error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error)
}

export function createDagTool(controller: DagController): Tool.Info {
  return {
    name: FLOW_TOOL_NAME,
    // Model-facing text only. Runtime refusals (observed runs, steered nodes,
    // authorization, delivery state) come back as the JSON error envelope below,
    // where the model can read them in context instead of reading them here.
    description: "Create and operate a durable multi-agent flow: each node runs in a fresh child session on the agent lane you name and returns only its result, so the orchestrator holds conclusions instead of transcripts. Give every node a short title (one line, in the user's language); add dependsOn for ordering, inputs: [{node: \"*\"}] to fan upstream results in with provenance, when: {node, field, equals|includes|matches|exists} to skip a node conditionally, and kind: \"gate\" (prompt = the approver's question, no agent/model) to pause for a human decision. Create with a definition, or with a template: plan-review (Prometheus plans, Momus reviews, gate, executor), goal-review (executor works, Momus reviews, gate), ultrawork (ultrawork executor, review, gate), hyperplan (members analyse, cross-attack, defend, Metis distils, Prometheus plans, Momus reviews, gate), team (lead splits, members work in worktrees, lead integrates, Momus reviews, gate). Read snapshot or wait before you claim a node finished; retry and resume re-run a step without restating the task. A configured fallback continues the failed child session rather than replacing it: its model is switched and it is told to continue, so the task, delivered supplements and completed tool effects stay in its history; a judge or a child that never started retries fresh. deep-low may answer ESCALATE: deep-high. The global rescue.ownerModel opt-in adds one last continuation of the same session on the owner session's model after the model chain and attempts are spent; it is not settable per node or per flow, and a spent rescue never rearms on retry, reload or amend. Steered nodes are never rescued automatically. Inspect node.fallback, node.rescued, node.rescue-skipped and result provenance. Action steer takes run_id, node_id, text and a durable request_id: supplement an active scheduled child without changing its agent or model, and reuse request_id only with identical node and text to inspect delivery without resending. Steered executions are never retried or escalated automatically; start a new flow with the complete task instead. Identity drift and unresolved delivery are reported, never silently repaired or replayed.",
    input: inputSchema,
    options: { codemode: false },
    execute: (raw: unknown, context: Tool.Context) => {
      const sessionID = String(context.sessionID)
      const dispatch = Effect.suspend((): Effect.Effect<unknown, unknown> => {
        const input = asObject(raw) as DagInput
        const action = requiredString(input.action, "action")
        const runID = () => requiredString(input.run_id, "run_id")
        const nodeID = () => requiredString(input.node_id, "node_id")
        const note = typeof input.note === "string" ? input.note : undefined
        switch (action) {
          case "create": return controller.create(input.definition === undefined && input.template !== undefined ? expandTemplate(input.template) : definition(input.definition), sessionID)
          case "template": return Effect.succeed(expandTemplate(input.template))
          case "snapshot": return controller.snapshot(runID(), sessionID)
          case "node": return controller.node(runID(), sessionID, nodeID())
          case "wait": return controller.wait(runID(), sessionID)
          case "cancel": return controller.cancel(runID(), sessionID)
          case "retry": return controller.retry(runID(), sessionID, typeof input.node_id === "string" ? input.node_id : undefined)
          case "resume": return controller.resume(runID(), sessionID)
          case "approve": return controller.approve(runID(), sessionID, nodeID(), note)
          case "reject": return controller.reject(runID(), sessionID, nodeID(), note)
          case "amend": return controller.amend(runID(), sessionID, definition(input.definition))
          case "steer": return controller.steer(runID(), sessionID, nodeID(), requiredString(input.text, "text"), requiredString(input.request_id, "request_id"))
          default: return Effect.fail(new Error(`Unknown DAG action: ${action}`))
        }
      })
      // Every failure, including malformed input thrown synchronously, is returned to the model as a JSON error envelope.
      return dispatch.pipe(
        Effect.map(content),
        Effect.catchCause((cause) => Effect.succeed(content({ error: errorText(cause) }))),
      )
    },
  }
}
