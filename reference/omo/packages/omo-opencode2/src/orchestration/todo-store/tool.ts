import type { TodoItem, TodoPriority, TodoStatus } from "./types"
import type { TodoStore } from "./store"

/** Structural stand-in for effect's JsonSchema (kept dependency-free). */
interface JsonSchemaLike {
  [key: string]: unknown
  type?: string
  properties?: Record<string, JsonSchemaLike>
  items?: JsonSchemaLike
  required?: string[]
  description?: string
  additionalProperties?: boolean
  enum?: readonly string[]
}

export interface TodoWriteToolOptions {
  store: TodoStore
  trace?: (event: string, detail?: Record<string, unknown>) => void
}

const TODO_ITEM_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable identifier for this todo item." },
    content: { type: "string", description: "What needs to be done." },
    status: {
      type: "string",
      enum: ["pending", "in_progress", "completed"],
      description: "Current status of this item.",
    },
    priority: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "Priority of this item.",
    },
  },
  required: ["id", "content", "status", "priority"],
  additionalProperties: false,
}

const TODO_WRITE_INPUT: JsonSchemaLike = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      items: TODO_ITEM_SCHEMA,
      description:
        "The complete todo list for this session. Replaces the previous list entirely. Omit completed items you no longer need to track.",
    },
  },
  required: ["todos"],
  additionalProperties: false,
}

function isValidStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed"
}

function isValidPriority(value: unknown): value is TodoPriority {
  return value === "high" || value === "medium" || value === "low"
}

function extractArray(input: unknown): unknown[] | undefined {
  if (Array.isArray(input)) return input
  if (typeof input !== "object" || input === null) return undefined
  const todos = (input as Record<string, unknown>).todos
  if (Array.isArray(todos)) return todos
  if (typeof todos === "string") {
    try {
      const parsed: unknown = JSON.parse(todos)
      return Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function parseTodoItems(input: unknown): TodoItem[] | undefined {
  const raw = extractArray(input)
  if (raw === undefined) return undefined
  const items: TodoItem[] = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined
    const record = entry as Record<string, unknown>
    if (typeof record.id !== "string" || record.id.length === 0) return undefined
    if (typeof record.content !== "string") return undefined
    if (!isValidStatus(record.status)) return undefined
    if (!isValidPriority(record.priority)) return undefined
    items.push({
      id: record.id,
      content: record.content,
      status: record.status,
      priority: record.priority,
    })
  }
  return items
}

/**
 * The `todowrite` tool. Accepts the full todo list and replaces the
 * session's current list. opencode2 ships no todo tool; this fills the gap
 * so OMO prompts that instruct `TodoWrite([...])` work.
 */
export function createTodoWriteTool(options: TodoWriteToolOptions): {
  name: string
  description: string
  input: JsonSchemaLike
  execute: (input: unknown, toolCtx: { sessionID: string }) => Promise<{ content: string }>
} {
  const { store, trace } = options

  return {
    name: "todowrite",
    description:
      "Manage the session todo list. Accepts the complete list and replaces the previous one. Use for planning and tracking multi-step work.",
    input: TODO_WRITE_INPUT,
    execute: async (input, toolCtx) => {
      const items = parseTodoItems(input)
      if (items === undefined) {
        return { content: "Error: invalid input. Expected { todos: [{ id, content, status, priority }] }." }
      }
      store.set(toolCtx.sessionID, items)
      trace?.("omo.todo.write", { sessionID: toolCtx.sessionID, count: items.length })
      const active = items.filter((item) => item.status !== "completed").length
      return {
        content: `Todo list updated: ${items.length} item${items.length === 1 ? "" : "s"} (${active} active).`,
      }
    },
  }
}
