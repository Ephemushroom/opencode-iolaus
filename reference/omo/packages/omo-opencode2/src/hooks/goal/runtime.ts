import { createIdleInjector } from "../../orchestration/idle-injector"
import type { IdleInjectorEvent } from "../../orchestration/idle-injector"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import type { GoalController } from "./controller"
import { buildContinuationPrompt } from "./prompt"
import type { GoalTrace } from "./types"

export type GoalEvent = IdleInjectorEvent

export type GoalRuntimeDependencies = {
  readonly controller: GoalController
  readonly sessionExists: (sessionID: string) => Promise<boolean>
  readonly dispatchContinuation: (sessionID: string, prompt: string) => Promise<void>
  readonly settle: () => Promise<void>
  // Required, not defaulted: a per-feature default instance would give each
  // idle-injecting feature its own lock, which is the double injection the
  // gate exists to prevent. The owner of the plugin creates one and shares it.
  readonly gate: SessionDispatchGate
  readonly trace?: GoalTrace
}

export type GoalRuntime = ReturnType<typeof createGoalRuntime>

export function createGoalRuntime(dependencies: GoalRuntimeDependencies) {
  const { controller, dispatchContinuation, gate, sessionExists, settle, trace } = dependencies

  // Goal is one configuration of the shared idle injector: it contributes the
  // predicate, the prompt and the delete-time cleanup. The activity tracking,
  // settle delay, post-settle re-checks and gated dispatch are shared.
  return createIdleInjector({
    name: "omo.goal",
    gate,
    sessionExists,
    dispatch: dispatchContinuation,
    settle,
    resolve: (sessionID) => {
      const goal = controller.getGoal(sessionID)
      if (goal === null || goal.status !== "active") return null
      return {
        prompt: buildContinuationPrompt(goal),
        detail: { goalID: goal.id, objectiveUpdatedAt: goal.updatedAt },
      }
    },
    onSessionDeleted: (sessionID) => controller.clearGoal(sessionID),
    trace,
  })
}
