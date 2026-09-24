import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import type { DagController } from "./controller"
import type { DagDefinition } from "./types"

type DagInput = {
  readonly action?: unknown
  readonly run_id?: unknown
  readonly node_id?: unknown
  readonly definition?: unknown
}

const inputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["create", "snapshot", "wait", "cancel", "retry", "resume", "amend"] },
    run_id: { type: "string" },
    node_id: { type: "string" },
    definition: { type: "object" },
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
    description: "Create and operate a durable Iolaus multi-Agent DAG. State lives under .iolaus and node results are retryable by generation.",
    input: inputSchema,
    options: { codemode: false },
    async execute(raw: unknown, context: ToolContext) {
      try {
        const input = asObject(raw) as DagInput
        const action = requiredString(input.action, "action")
        switch (action) {
          case "create": return content(await controller.create(definition(input.definition), String(context.sessionID)))
          case "snapshot": return content(await controller.snapshot(requiredString(input.run_id, "run_id"), String(context.sessionID)))
          case "wait": return content(await controller.wait(requiredString(input.run_id, "run_id"), String(context.sessionID)))
          case "cancel": return content(await controller.cancel(requiredString(input.run_id, "run_id"), String(context.sessionID)))
          case "retry": return content(await controller.retry(requiredString(input.run_id, "run_id"), String(context.sessionID), typeof input.node_id === "string" ? input.node_id : undefined))
          case "resume": return content(await controller.resume(requiredString(input.run_id, "run_id"), String(context.sessionID)))
          case "amend": return content(await controller.amend(requiredString(input.run_id, "run_id"), String(context.sessionID), definition(input.definition)))
          default: throw new Error(`Unknown DAG action: ${action}`)
        }
      } catch (error) {
        return content({ error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
