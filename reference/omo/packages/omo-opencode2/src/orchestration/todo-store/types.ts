export type TodoStatus = "pending" | "in_progress" | "completed"

export type TodoPriority = "high" | "medium" | "low"

export interface TodoItem {
  readonly id: string
  readonly content: string
  readonly status: TodoStatus
  readonly priority: TodoPriority
}
