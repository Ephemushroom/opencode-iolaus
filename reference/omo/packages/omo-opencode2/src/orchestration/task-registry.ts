/**
 * Background task registry for the omo task engine.
 *
 * Tracks every delegated child session the plugin has spawned: its parent
 * session, the child session id, the resolved agent/model, status, and the
 * aggregated output text. The event pump updates records as child-session
 * events arrive; background_output / background_cancel / task tools read and
 * mutate them.
 */

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export interface TaskRecord {
  /** Plugin-side task id (stable, independent of the v2 session id). */
  readonly id: string
  /** The parent session that spawned this task. */
  readonly parentSessionID: string
  /** The v2 child session id, once created. */
  childSessionID?: string
  /** The agent the child runs as. */
  readonly agent: string
  /** The resolved model the child runs on ("<provider>/<model>"). */
  readonly model: string
  /** Human-readable task description (used as the child session title). */
  readonly description: string
  /** Whether this task runs in the background (vs awaited synchronously). */
  readonly background: boolean
  status: TaskStatus
  /** Aggregated output text from the child session event stream. */
  texts: string[]
  /** Error message when status is failed/cancelled. */
  error?: string
  readonly createdAt: number
  completedAt?: number
}

let nextTaskId = 1

function createTaskId(): string {
  return `task_${Date.now().toString(36)}_${(nextTaskId++).toString(36)}`
}

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>()

  create(input: {
    parentSessionID: string
    agent: string
    model: string
    description: string
    background: boolean
  }): TaskRecord {
    const record: TaskRecord = {
      id: createTaskId(),
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      model: input.model,
      description: input.description,
      background: input.background,
      status: "queued",
      texts: [],
      createdAt: Date.now(),
    }
    this.tasks.set(record.id, record)
    return record
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  list(): readonly TaskRecord[] {
    return [...this.tasks.values()].toSorted((a, b) => a.createdAt - b.createdAt)
  }

  listByParent(parentSessionID: string): readonly TaskRecord[] {
    return this.list().filter((record) => record.parentSessionID === parentSessionID)
  }

  update(taskId: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
    const record = this.tasks.get(taskId)
    if (!record) return undefined
    Object.assign(record, patch)
    return record
  }

  appendText(taskId: string, text: string): void {
    const record = this.tasks.get(taskId)
    if (record) record.texts.push(text)
  }

  complete(taskId: string): void {
    this.update(taskId, { status: "completed", completedAt: Date.now() })
  }

  fail(taskId: string, error: string): void {
    this.update(taskId, { status: "failed", error, completedAt: Date.now() })
  }

  cancel(taskId: string): void {
    this.update(taskId, { status: "cancelled", error: "cancelled", completedAt: Date.now() })
  }

  output(taskId: string): string | undefined {
    const record = this.tasks.get(taskId)
    if (!record) return undefined
    return record.texts.join("\n")
  }
}
