import type { TodoItem } from "./types"

interface SystemPartLike {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

const TODO_STATE_TAG = "<todo-state>"

/**
 * Injects the current todo list as a system part. Replaces any existing
 * todo-state part. Returns the array unchanged when the list is empty so
 * no noise is added to sessions that never used the tool.
 */
export function injectTodoStateSystemPart(
  system: readonly SystemPartLike[],
  items: readonly TodoItem[],
): SystemPartLike[] {
  const retained = system.filter((part) => !part.text?.includes(TODO_STATE_TAG))
  if (items.length === 0) return retained

  const active = items.filter((item) => item.status !== "completed")
  const lines = items.map((item) => {
    const marker = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]"
    return `${marker} ${item.id}: ${item.content} (${item.priority})`
  })

  const summary = `${active.length} active, ${items.length - active.length} completed`
  return [
    ...retained,
    {
      type: "text",
      text: `${TODO_STATE_TAG}\n${summary}\n${lines.join("\n")}\n</todo-state>`,
    },
  ]
}
