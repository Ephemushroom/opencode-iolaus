import type { Context } from "@opencode/plugin/promise/plugin"

import type { TaskRegistry } from "./task-registry"
import { guideTaskResult } from "./task-result-guidance"

export interface ChildResult {
  ok: boolean
  text: string
}

export type Trace = (event: string, detail?: Record<string, unknown>) => void

interface ChildWaiter {
  texts: string[]
  resolve: (result: ChildResult) => void
}

export interface TaskEngineOptions {
  ctx: Context
  registry: TaskRegistry
  trace?: Trace
  /** Called when a child session for a background task reaches a terminal state. */
  onBackgroundTerminal?: (input: {
    taskID: string
    parentSessionID: string
    ok: boolean
    text: string
  }) => void
}

export interface TaskEngine {
  waiters: Map<string, ChildWaiter>
  dispose: () => void
}

/**
 * Always-on session-event pump powering the task engine.
 *
 * Routes child-session events three ways:
 *  - text.ended / reasoning.ended are aggregated into the matching waiter (sync
 *    mode) and the task record (background mode).
 *  - execution.succeeded/failed settle sync waiters and mark background tasks
 *    terminal (running the onBackgroundTerminal callback, which the plugin uses
 *    to send a synthetic wake to the parent session).
 *  - session.idle settles sync waiters when execution events are not observed.
 */
export function createTaskEngine(options: TaskEngineOptions): TaskEngine {
  const { ctx, registry, trace, onBackgroundTerminal } = options
  const waiters = new Map<string, ChildWaiter>()
  let disposed = false

  const pump = (async () => {
    for await (const event of ctx.event.subscribe()) {
      if (disposed) return
      const data = (event as { data?: Record<string, unknown> }).data ?? {}
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      trace?.("event", { type: event.type, sessionID })
      if (!sessionID) continue

      const waiter = waiters.get(sessionID)
      const task = [...registry.list()].find((record) => record.childSessionID === sessionID)

      if (event.type === "session.text.ended" || event.type === "session.reasoning.ended") {
        if (typeof data.text === "string") {
          waiter?.texts.push(data.text)
          if (task) registry.appendText(task.id, data.text)
        }
        continue
      }

      if (event.type === "session.execution.failed") {
        const message = `execution failed: ${JSON.stringify(data.error ?? null)}`
        if (task && task.status === "running") {
          registry.fail(task.id, message)
          if (task.background) {
            const guided = guideTaskResult(message, trace)
            if (guided.kind !== "usable") {
              registry.update(task.id, { texts: [guided.content] })
            }
            onBackgroundTerminal?.({
              taskID: task.id,
              parentSessionID: task.parentSessionID,
              ok: false,
              text: guided.content,
            })
          }
        }
        if (waiter) {
          waiters.delete(sessionID)
          waiter.resolve({ ok: false, text: message })
        }
        continue
      }

      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.interrupted" ||
        event.type === "session.idle"
      ) {
        const ok = event.type !== "session.execution.interrupted"
        const text = waiter?.texts.join("\n") ?? ""
        if (task && task.status === "running") {
          if (ok) registry.complete(task.id)
          else registry.fail(task.id, "interrupted")
          if (task.background) {
            const guided = guideTaskResult(text, trace)
            if (guided.kind !== "usable") {
              registry.update(task.id, { texts: [guided.content] })
            }
            onBackgroundTerminal?.({
              taskID: task.id,
              parentSessionID: task.parentSessionID,
              ok,
              text: guided.content,
            })
          }
        }
        if (waiter) {
          waiters.delete(sessionID)
          waiter.resolve({ ok, text })
        }
      }
    }
  })()
  pump.catch((error: unknown) => trace?.("event-pump.error", { message: String(error) }))

  return {
    waiters,
    dispose: () => {
      disposed = true
      for (const [sessionID, waiter] of waiters) {
        waiters.delete(sessionID)
        waiter.resolve({ ok: false, text: "plugin disposed" })
      }
    },
  }
}
