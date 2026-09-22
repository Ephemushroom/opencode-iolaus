import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"

import type { RawHashlineEdit } from "@oh-my-opencode/hashline-core"
import { executeHashlineEdit } from "./execute-hashline-edit"
import { HASHLINE_EDIT_DESCRIPTION } from "./tool-description"

type Trace = (event: string, detail?: Record<string, unknown>) => void

/** Structural stand-in for effect's JsonSchema (kept dependency-free). */
interface JsonSchemaLike {
  [key: string]: unknown
  type?: string
  properties?: Record<string, JsonSchemaLike>
  items?: JsonSchemaLike
  required?: string[]
  description?: string
  additionalProperties?: boolean
}

export const HASHLINE_EDIT_TOOL_NAME = "hashline_edit"

const HASHLINE_EDIT_INPUT: JsonSchemaLike = {
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description: "Absolute path to the file to edit.",
    },
    edits: {
      type: "array",
      description: "Edit operations to apply. Every anchor is validated against current file content.",
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            description: "One of replace, append, prepend.",
          },
          pos: {
            type: "string",
            description: "Primary anchor in LINE#ID format (copy exactly from read output).",
          },
          end: {
            type: "string",
            description: "Range end anchor in LINE#ID format (replace only).",
          },
          lines: {
            type: "string",
            description: "Replacement or inserted content. Use null with replace to delete the lines.",
          },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
  },
  required: ["filePath", "edits"],
  additionalProperties: false,
}

function readFilePath(input: Record<string, unknown>): string {
  const value = input.filePath
  return typeof value === "string" ? value : ""
}

function readEdits(input: Record<string, unknown>): RawHashlineEdit[] {
  const value = input.edits
  return Array.isArray(value) ? (value as RawHashlineEdit[]) : []
}

/**
 * Registers the `hashline_edit` tool via `ctx.tool.transform`.
 *
 * Registered under the DISTINCT name `hashline_edit` so it does NOT shadow the
 * v2 builtin `edit` tool (risk R7). `codemode: false` keeps it a direct tool
 * rather than a CodeMode-wrapped one. Reconciling the two edit entry points is
 * deliberately deferred to a later PR.
 */
export const registerHashlineEditTool = Effect.fn("omo.registerHashlineEditTool")(function* (ctx: Context, trace?: Trace) {
  yield* ctx.tool.transform((draft) => {
    draft.add({
      name: HASHLINE_EDIT_TOOL_NAME,
      description: HASHLINE_EDIT_DESCRIPTION,
      input: HASHLINE_EDIT_INPUT,
      options: { codemode: false },
      execute: (rawInput: unknown) => Effect.tryPromise({ try: async () => {
        const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<
          string,
          unknown
        >
        const filePath = readFilePath(input)
        const edits = readEdits(input)
        if (!filePath) {
          return { content: "Error: filePath is required." }
        }
        const result = await executeHashlineEdit({ filePath, edits })
        if (result.rejected) {
          trace?.("omo.hashline.edit-rejected", { filePath })
          return { content: `Error: ${result.message}` }
        }
        trace?.("omo.hashline.edit-accepted", { filePath })
        return { content: result.message }
      }, catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }) }),
    })
  })
  trace?.("omo.hashline.tool-registered", { tool: HASHLINE_EDIT_TOOL_NAME })
})
