import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
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

export function createDagTool(controller: DagController): Info {
  return {
    name: "iolaus_dag",
    description: "Create and operate a durable Iolaus multi-Agent DAG. State lives under .iolaus and node results are retryable by generation. Bind upstream results into a node with inputs: [{node: \"*\"}] to fan in every dependency with provenance; use action \"node\" to inspect one node's full result, agent, model and child sessionID. model is optional: omitted, the node runs on the model configured for that agent or category lane (iolaus-<category>, e.g. iolaus-quick, iolaus-deep-low); set it only to override. Add when: {node, field?, equals|includes|matches|exists} (or all/any/not) to run a node only if an upstream result satisfies it; otherwise it is skipped and downstream still proceeds. Add kind: \"gate\" (prompt = message for the approver, no agent/model) to pause the run until a human approves or rejects; approve/reject take run_id, node_id and an optional note. Templates: action \"template\" with template: {template: \"plan-review\", task} returns a ready definition (Prometheus plans → Momus reviews → revise on FAIL → re-review → human gate → executor), and \"goal-review\" (executor works → Momus reviews → fix on FAIL → re-review → gate); \"ultrawork\" (executor works under the ultrawork prompt → Momus reviews → fix → re-review, up to iterations rounds → gate) and \"hyperplan\" (members analyse in parallel → cross-attack → defend → Metis distills → Prometheus plans → Momus reviews → gate); pass the same object as template to \"create\" to run it directly. Routing is fail-closed: a node whose lane has no configured model is rejected at create with model_unavailable.",
    input: inputSchema,
    options: { codemode: false },
    async execute(raw: unknown, context: ToolContext) {
      try {
        const input = asObject(raw) as DagInput
        const action = requiredString(input.action, "action")
        switch (action) {
          case "create": return content(await controller.create(input.definition === undefined && input.template !== undefined ? expandTemplate(input.template) : definition(input.definition), String(context.sessionID)))
          case "template": return content(expandTemplate(input.template))
          case "snapshot": return content(await controller.snapshot(requiredString(input.run_id, "run_id"), String(context.sessionID)))
          case "node": return content(await controller.node(requiredString(input.run_id, "run_id"), String(context.sessionID), requiredString(input.node_id, "node_id")))
          case "wait": return content(await controller.wait(requiredString(input.run_id, "run_id"), String(context.sessionID)))
          case "cancel": return content(await controller.cancel(requiredString(input.run_id, "run_id"), String(context.sessionID)))
          case "retry": return content(await controller.retry(requiredString(input.run_id, "run_id"), String(context.sessionID), typeof input.node_id === "string" ? input.node_id : undefined))
          case "resume": return content(await controller.resume(requiredString(input.run_id, "run_id"), String(context.sessionID)))
          case "approve": return content(await controller.approve(requiredString(input.run_id, "run_id"), String(context.sessionID), requiredString(input.node_id, "node_id"), typeof input.note === "string" ? input.note : undefined))
          case "reject": return content(await controller.reject(requiredString(input.run_id, "run_id"), String(context.sessionID), requiredString(input.node_id, "node_id"), typeof input.note === "string" ? input.note : undefined))
          case "amend": return content(await controller.amend(requiredString(input.run_id, "run_id"), String(context.sessionID), definition(input.definition)))
          default: throw new Error(`Unknown DAG action: ${action}`)
        }
      } catch (error) {
        return content({ error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
