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
    description: "Create and operate a durable Iolaus flow, a multi-Agent DAG stored in IOLAUS_HOME/iolaus.db. Create returns while work continues; remain available for the user. Inspect snapshot/node on demand; wait is optional and blocks until terminal, including across gates. Committed gate, rescue and terminal notices are queued to the owner without waking it. Give each node a short title in the user's language. Omit model to use the configured agent lane. Bind inputs: [{node: \"*\"}] for fan-in with provenance. Conditions use when: {node, field?, equals|includes|matches|exists} or all/any/not; false branches skip without blocking dependents. Gate nodes have kind: \"gate\" and a prompt for the user, no agent/model; only approve/reject on the user's decision. Templates (action template expands, create runs): plan-review, goal-review, ultrawork, hyperplan, team. Team members run in their own worktrees, then the lead integrates and Momus reviews. A node's worktree:true creates an isolated branch; run directory must be an absolute worktree of this repository. Primary tier restrictions apply to all expanded nodes; Atlas requires top-level /start-work authorization. Missing lane models fail closed. Configured model fallbacks and remaining attempts continue the failed child session: its model is switched and it is told to continue, so the task, delivered supplements and completed tool effects stay in its history; a judge or a child that never started retries fresh. deep-low may answer ESCALATE: deep-high. Action steer takes run_id, node_id, text and a durable request_id: supplement an active scheduled child without changing its agent/model. Reuse request_id only with identical node/text to inspect delivery without resending. V1 refuses pre-initial-admission, pending, settled, observed, judge, gate, planning, legacy unpinned and Atlas/authorized-plan targets. Identity drift and unresolved delivery are reported, never silently repaired or replayed. An explicit retry of a steered node is refused; use a new flow with the complete task. The global rescue.ownerModel opt-in adds one last continuation of the same session on the owner session's model after the chain and attempts are spent; there is no per-node or per-flow rescue option, and a spent rescue never rearms on retry, reload or amend. Inspect node.fallback, node.rescued, node.rescue-skipped and result provenance. Amend refuses live executions or unresolved steering. No exactly-once guarantee across the host and Flow stores.",
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
