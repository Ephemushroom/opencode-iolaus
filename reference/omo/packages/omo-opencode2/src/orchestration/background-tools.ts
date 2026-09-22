import type { Context } from "@opencode/plugin/promise/plugin"

import type { TaskRegistry } from "./task-registry"
import type { JsonSchemaLike } from "./task-tool"

export interface BackgroundToolsOptions {
  ctx: Context
  registry: TaskRegistry
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

/**
 * background_output: retrieves the result of a background task (or its current
 * partial output while still running).
 */
export function createBackgroundOutputTool(options: BackgroundToolsOptions): {
  name: string
  description: string
  input: JsonSchemaLike
  execute: (input: unknown) => Promise<{ content: string }>
} {
  const { registry } = options
  return {
    name: "background_output",
    description:
      "Retrieve the output of a background task started with task(run_in_background=true). Returns the aggregated text so far; if the task is still running, says so.",
    input: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task id returned by the task tool." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    execute: async (rawInput) => {
      const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>
      const taskId = readString(input, "task_id")
      if (!taskId) return { content: "Invalid arguments: task_id is required." }

      const task = registry.get(taskId)
      if (!task) return { content: `Unknown task id: ${taskId}.` }

      const output = registry.output(taskId) ?? ""
      switch (task.status) {
        case "completed":
          return { content: `Task ${taskId} (agent=${task.agent}) completed.\n${output || "(no output)"}` }
        case "failed":
          return { content: `Task ${taskId} (agent=${task.agent}) failed: ${task.error ?? "unknown error"}\n${output}` }
        case "cancelled":
          return { content: `Task ${taskId} (agent=${task.agent}) was cancelled.` }
        case "queued":
        case "running":
          return {
            content: `Task ${taskId} (agent=${task.agent}) is still ${task.status}.\n${output || "(no output yet)"}`,
          }
      }
    },
  }
}

/**
 * background_cancel: cancels a queued/running background task.
 */
export function createBackgroundCancelTool(options: BackgroundToolsOptions): {
  name: string
  description: string
  input: JsonSchemaLike
  execute: (input: unknown) => Promise<{ content: string }>
} {
  const { ctx, registry } = options
  return {
    name: "background_cancel",
    description:
      "Cancel a background task started with task(run_in_background=true). Interrupts the child session if it is still running.",
    input: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task id returned by the task tool." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    execute: async (rawInput) => {
      const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>
      const taskId = readString(input, "task_id")
      if (!taskId) return { content: "Invalid arguments: task_id is required." }

      const task = registry.get(taskId)
      if (!task) return { content: `Unknown task id: ${taskId}.` }
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        return { content: `Task ${taskId} is already ${task.status}.` }
      }

      registry.cancel(taskId)
      if (task.childSessionID) {
        await ctx.session.interrupt({ sessionID: task.childSessionID }).catch(() => undefined)
      }
      return { content: `Task ${taskId} cancelled.` }
    },
  }
}
