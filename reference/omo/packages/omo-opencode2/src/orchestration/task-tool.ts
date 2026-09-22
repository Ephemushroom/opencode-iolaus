import type { Context } from "@opencode/plugin/promise/plugin"

import type { TaskRegistry } from "./task-registry"
import type { ConcurrencyLimiter } from "./concurrency"
import type { ChildSessionDeps } from "./child-session"
import { runChildSession } from "./child-session"
import { guideTaskResult } from "./task-result-guidance"

/** Structural stand-in for effect's JsonSchema (kept dependency-free). */
export interface JsonSchemaLike {
  [key: string]: unknown
  type?: string
  properties?: Record<string, JsonSchemaLike>
  items?: JsonSchemaLike
  required?: string[]
  description?: string
  additionalProperties?: boolean
}

export interface TaskToolOptions {
  ctx: Context
  registry: TaskRegistry
  limiter: ConcurrencyLimiter
  deps: ChildSessionDeps
  /** Agents eligible for direct subagent_type dispatch (registered subagents). */
  availableSubagents: readonly string[]
  /** Categories registered as dispatchable subagents. */
  availableCategories: readonly string[]
  /** Map of category name -> fallback model string (used for routing). */
  categoryModels: ReadonlyMap<string, string>
  trace?: (event: string, detail?: Record<string, unknown>) => void
}

export interface TaskToolInput {
  prompt: string
  description?: string
  category?: string
  subagent_type?: string
  model?: string
  load_skills?: string[]
  run_in_background?: boolean
  task_id?: string
  command?: string
}

const TASK_TOOL_INPUT: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "The task prompt for the delegated agent. Include context, goal, constraints, and expected output format.",
    },
    description: {
      type: "string",
      description: "Short human-readable description of the task (used as the child session title).",
    },
    category: {
      type: "string",
      description:
        "Delegation category (e.g. 'explore', 'deep', 'quick', 'ultrabrain', 'visual-engineering'). Use ONLY one of category or subagent_type.",
    },
    subagent_type: {
      type: "string",
      description:
        "Direct subagent name (e.g. 'oracle', 'explore', 'librarian'). Use ONLY one of category or subagent_type.",
    },
    model: {
      type: "string",
      description:
        "IMPORTANT: the task tool DOES accept this model parameter ('<provider>/<model>', e.g. 'zhipuai/glm-4.7'). Always pass model together with subagent_type or category so the child session runs on that model. When omitted the agent's fallback chain is used.",
    },
    load_skills: {
      type: "array",
      items: { type: "string" },
      description: "Skill names to load into the delegated agent's context.",
    },
    run_in_background: {
      type: "boolean",
      description:
        "When true, start the task in the background and return immediately; poll with background_output.",
    },
    task_id: {
      type: "string",
      description:
        "Existing task id to CONTINUE (append a prompt to that child session) instead of starting a new task.",
    },
    command: {
      type: "string",
      description: "Optional slash-command to run in the child session.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function readBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key]
  return typeof value === "boolean" ? value : undefined
}

function readStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined
}

export interface CreateTaskToolOptions extends TaskToolOptions {
  /** Resolves a category to { agent, model } using model-core; returns undefined if unknown. */
  resolveCategory: (category: string) => { agent: string; model: string } | undefined
}

/**
 * The omo `task` delegation tool.
 *
 * Use this when you need category routing, background concurrency management,
 * task continuation, or load_skills — the native v2 `subagent` tool covers
 * plain by-name dispatch.
 */
export function createTaskTool(options: CreateTaskToolOptions): {
  name: string
  description: string
  input: JsonSchemaLike
  execute: (input: unknown, toolCtx: { sessionID: string }) => Promise<{ content: string }>
} {
  const { ctx, registry, limiter, deps, availableSubagents, availableCategories, categoryModels, trace } = options
  const respond = (content: string): { content: string } => ({
    content: guideTaskResult(content, trace).content,
  })

  return {
    name: "task",
    description:
      "Delegate work to an omo subagent or category. Use this when you need category routing, background tasks (run_in_background=true, poll with background_output), task continuation (task_id), or load_skills. For a simple by-name subagent dispatch the native 'subagent' tool suffices. Available subagents: " +
      availableSubagents.join(", ") +
      ". Available categories: " +
      availableCategories.join(", "),
    input: TASK_TOOL_INPUT,
    execute: async (rawInput, toolCtx) => {
      const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>
      const prompt = readString(input, "prompt") ?? ""
      const description = readString(input, "description") ?? prompt.slice(0, 60)
      const category = readString(input, "category")
      const subagentType = readString(input, "subagent_type")
      const modelOverride = readString(input, "model")
      const loadSkills = readStringArray(input, "load_skills") ?? []
      const runInBackground = readBoolean(input, "run_in_background") ?? false
      const taskId = readString(input, "task_id")
      const command = readString(input, "command")

      if (!prompt && !command) {
        return respond("Invalid arguments: prompt (or command) is required.")
      }
      if (category !== undefined && subagentType !== undefined) {
        return respond(
          "[ERROR] Invalid arguments: category OR subagent_type are mutually exclusive. Provide ONLY one.",
        )
      }
      if (taskId !== undefined && (category !== undefined || subagentType !== undefined)) {
        return respond(
          "Invalid arguments: task_id continuation cannot be combined with category/subagent_type.",
        )
      }

      // Continuation path: append a prompt to an existing child session.
      if (taskId !== undefined) {
        const result = await runChildSession({
          ctx,
          registry,
          limiter,
          deps,
          parentSessionID: toolCtx.sessionID,
          agent: registry.get(taskId)?.agent ?? "oracle",
          model: registry.get(taskId)?.model ?? "",
          prompt,
          description: `continue ${taskId}`,
          background: false,
          continuationTaskID: taskId,
        })
        return respond(formatResult(result.ok, result.text, result.taskID))
      }

      // Route: subagent_type direct, or category via model-core.
      let agent: string
      let model: string
      if (subagentType !== undefined) {
        if (!availableSubagents.includes(subagentType)) {
          return respond(
            `[ERROR] Unknown agent: ${subagentType}. Available subagents: ${availableSubagents.join(", ")}.`,
          )
        }
        agent = subagentType
        model = modelOverride ?? categoryModels.get(subagentType) ?? ""
      } else if (category !== undefined) {
        const resolved = options.resolveCategory(category)
        if (!resolved) {
          return respond(
            `[ERROR] Unknown category: ${category}. Available categories: ${availableCategories.join(", ")}.`,
          )
        }
        agent = resolved.agent
        model = modelOverride ?? resolved.model
      } else {
        return respond(
          "[ERROR] Invalid arguments: Must provide either category or subagent_type. Available subagents: " +
            availableSubagents.join(", ") +
            ". Available categories: " +
            availableCategories.join(", ") +
            ".",
        )
      }

      const promptWithSkills = loadSkills.length > 0
        ? `${prompt}\n\n[Loaded skills for this task: ${loadSkills.join(", ")}]`
        : prompt

      trace?.("omo.task.start", {
        agent,
        model,
        background: runInBackground,
        parent: toolCtx.sessionID,
        hasSkills: loadSkills.length > 0,
      })

      const result = await runChildSession({
        ctx,
        registry,
        limiter,
        deps,
        parentSessionID: toolCtx.sessionID,
        agent,
        model,
        prompt: promptWithSkills,
        description,
        background: runInBackground,
      })

      trace?.("omo.task.finished", {
        taskID: result.taskID,
        ok: result.ok,
        background: runInBackground,
        length: result.text.length,
      })

      if (runInBackground) {
        return respond(
          `Background task ${result.taskID} started (agent=${agent}). Use background_output with task_id="${result.taskID}" to retrieve the result.`,
        )
      }
      return respond(formatResult(result.ok, result.text, result.taskID))
    },
  }
}

function formatResult(ok: boolean, text: string, taskID: string): string {
  if (text.trim() === "") return ""
  return ok
    ? `Task ${taskID} result:\n${text}`
    : `Task ${taskID} failed:\n${text}`
}
