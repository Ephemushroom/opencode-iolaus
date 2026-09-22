import { createIdleInjector } from "../../orchestration/idle-injector"
import type { IdleInjectorEvent, IdleInjectorTrace } from "../../orchestration/idle-injector"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import type { TodoItem } from "../../orchestration/todo-store"
import { buildTodoContinuationPrompt } from "./prompt"

export const DEFAULT_MAX_CONSECUTIVE = 12

export type TodoContinuationEvent = IdleInjectorEvent

export type TodoContinuationRuntimeDependencies = {
  readonly getTodos: (sessionID: string) => readonly TodoItem[]
  readonly sessionExists: (sessionID: string) => Promise<boolean>
  readonly dispatchContinuation: (sessionID: string, prompt: string) => Promise<void>
  readonly settle: () => Promise<void>
  // The plugin-wide instance, shared with every other idle injector.
  readonly gate: SessionDispatchGate
  readonly maxConsecutive?: number
  readonly trace?: IdleInjectorTrace
}

export type TodoContinuationRuntime = ReturnType<typeof createTodoContinuationRuntime>

type Progress = {
  consecutive: number
  lastRemaining: number
}

export function createTodoContinuationRuntime(dependencies: TodoContinuationRuntimeDependencies) {
  const {
    dispatchContinuation,
    gate,
    getTodos,
    maxConsecutive = DEFAULT_MAX_CONSECUTIVE,
    sessionExists,
    settle,
    trace,
  } = dependencies
  const progress = new Map<string, Progress>()

  const remainingFor = (sessionID: string): readonly TodoItem[] =>
    getTodos(sessionID).filter((item) => item.status !== "completed")

  return createIdleInjector({
    name: "omo.todo",
    gate,
    sessionExists,
    settle,
    // The bound is counted here, not in resolve, because resolve runs twice per
    // idle edge (cheap filter, then authoritative re-check) while this runs
    // exactly once per real injection. Counting in resolve would double-count.
    dispatch: async (sessionID, prompt) => {
      const remaining = remainingFor(sessionID).length
      const seen = progress.get(sessionID)
      // Any drop in the remaining count is real progress, so the budget resets
      // and a long but productive run is never cut off. The budget only bites
      // when the model keeps going idle without finishing anything.
      const consecutive = seen === undefined || remaining < seen.lastRemaining ? 1 : seen.consecutive + 1
      progress.set(sessionID, { consecutive, lastRemaining: remaining })
      await dispatchContinuation(sessionID, prompt)
    },
    resolve: (sessionID) => {
      const remaining = remainingFor(sessionID)
      if (remaining.length === 0) return null

      const seen = progress.get(sessionID)
      if (seen !== undefined && seen.consecutive >= maxConsecutive && remaining.length >= seen.lastRemaining) {
        trace?.("omo.todo.budget-exhausted", {
          sessionID,
          consecutive: seen.consecutive,
          remaining: remaining.length,
        })
        return null
      }

      return {
        prompt: buildTodoContinuationPrompt(remaining),
        detail: { remaining: remaining.length, consecutive: (seen?.consecutive ?? 0) + 1 },
      }
    },
    onSessionDeleted: (sessionID) => progress.delete(sessionID),
    trace,
  })
}
