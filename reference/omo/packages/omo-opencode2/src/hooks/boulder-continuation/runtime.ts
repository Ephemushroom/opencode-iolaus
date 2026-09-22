import { createIdleInjector } from "../../orchestration/idle-injector"
import type { IdleInjectorEvent, IdleInjectorTrace } from "../../orchestration/idle-injector"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { buildBoulderContinuationPrompt } from "./prompt"
import { readBoulderContinuationState } from "./state"
import type { BoulderContinuationState } from "./state"

export type BoulderContinuationEvent = IdleInjectorEvent

export type BoulderContinuationRuntimeDependencies = {
  readonly directory: string
  readonly sessionExists: (sessionID: string) => Promise<boolean>
  readonly dispatchContinuation: (sessionID: string, prompt: string) => Promise<void>
  readonly settle: () => Promise<void>
  // The plugin-wide instance, shared with goal and the todo enforcer so no two
  // idle injectors can both fire into the same turn.
  readonly gate: SessionDispatchGate
  // Injectable for tests; production reads the real boulder state off disk.
  readonly readState?: (directory: string, sessionID: string) => BoulderContinuationState | null
  readonly trace?: IdleInjectorTrace
}

export type BoulderContinuationRuntime = ReturnType<typeof createBoulderContinuationRuntime>

export function createBoulderContinuationRuntime(dependencies: BoulderContinuationRuntimeDependencies) {
  const {
    directory,
    dispatchContinuation,
    gate,
    readState = readBoulderContinuationState,
    sessionExists,
    settle,
    trace,
  } = dependencies

  return createIdleInjector({
    name: "omo.boulder",
    gate,
    sessionExists,
    settle,
    dispatch: dispatchContinuation,
    resolve: (sessionID) => {
      const state = readState(directory, sessionID)
      if (state === null) return null
      return {
        prompt: buildBoulderContinuationPrompt(state),
        detail: {
          planName: state.planName,
          remaining: state.checklist.remaining,
          total: state.checklist.total,
        },
      }
    },
    // Boulder state is durable on disk and re-read on every idle, so there is
    // no in-memory state to clear on session delete.
    trace,
  })
}
