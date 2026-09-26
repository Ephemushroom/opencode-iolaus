import { Effect } from "effect"
import type { Tool } from "@opencode/schema/tool"
import type { DagController } from "./controller"
import type { DagDefinition } from "./types"
import { DAG_TEMPLATE_NAMES, expandTemplate } from "./templates"

type DagInput = {
  readonly action?: unknown
  readonly run_id?: unknown
  readonly node_id?: unknown
  readonly note?: unknown
  readonly definition?: unknown
  readonly template?: unknown
}

const inputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["create", "template", "snapshot", "node", "wait", "cancel", "retry", "resume", "approve", "reject", "amend"] },
    run_id: { type: "string" },
    node_id: { type: "string" },
    note: { type: "string" },
    definition: { type: "object" },
    template: {
      type: "object",
      description: "For action \"template\" (expand only) or \"create\" without definition (expand and run). {template: \"plan-review\" | \"goal-review\", task, name?, reviewer?, executor?, gate?, maxAttempts?}.",
      properties: {
        template: { type: "string", enum: [...DAG_TEMPLATE_NAMES] },
        task: { type: "string" }, name: { type: "string" }, reviewer: { type: "string" }, executor: { type: "string" },
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
    name: "iolaus_dag",
    description: "Create and operate a durable Iolaus multi-Agent DAG. State lives under .iolaus and node results are retryable by generation. Bind upstream results into a node with inputs: [{node: \"*\"}] to fan in every dependency with provenance; use action \"node\" to inspect one node's full result, agent, model and child sessionID. model is optional: omitted, the node runs on the model configured for that agent or category lane (iolaus-<category>, e.g. iolaus-quick, iolaus-deep-low); set it only to override. Add when: {node, field?, equals|includes|matches|exists} (or all/any/not) to run a node only if an upstream result satisfies it; otherwise it is skipped and downstream still proceeds. Add kind: \"gate\" (prompt = message for the approver, no agent/model) to pause the run until a human approves or rejects; approve/reject take run_id, node_id and an optional note. Templates: action \"template\" with template: {template: \"plan-review\", task} returns a ready definition (Prometheus plans → Momus reviews → revise on FAIL → re-review → human gate → executor), and \"goal-review\" (executor works → Momus reviews → fix on FAIL → re-review → gate); \"ultrawork\" (executor works under the ultrawork prompt → Momus reviews → fix → re-review, up to iterations rounds → gate) and \"hyperplan\" (members analyse in parallel → cross-attack → defend → Metis distills → Prometheus plans → Momus reviews → gate); pass the same object as template to \"create\" to run it directly. Routing is fail-closed: a node whose lane has no configured model is rejected at create with model_unavailable.",
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
