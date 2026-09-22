import { InvalidObjectiveError } from "./controller"
import type { GoalController } from "./controller"
import type { GoalTrace } from "./types"

export type GoalContextEvent = {
  readonly sessionID: string
  readonly messages: readonly {
    readonly role?: string
    readonly content?: readonly {
      readonly type: string
      readonly text?: string | null
    }[]
  }[]
}

export type GoalSessionInfo = {
  readonly parentID?: string
}

export type GoalAutoStartOptions = {
  readonly controller: GoalController
  readonly getSessionInfo: (sessionID: string) => Promise<GoalSessionInfo | null>
  readonly trace?: GoalTrace
}

export function createGoalAutoStartHandler(options: GoalAutoStartOptions) {
  return async (event: GoalContextEvent): Promise<void> => {
    if (options.controller.getGoal(event.sessionID) !== null) return

    const objectives: string[] = []
    for (const message of event.messages) {
      if (message.role !== "user") continue
      const objective = (message.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join(" ")
        .trim()
      if (objective.length > 0) objectives.push(objective)
      if (objectives.length > 1) return
    }
    const objective = objectives[0]
    if (objective === undefined) return

    const session = await options.getSessionInfo(event.sessionID)
    if (session === null || session.parentID !== undefined) return
    if (options.controller.getGoal(event.sessionID) !== null) return

    try {
      const goal = options.controller.setGoal(event.sessionID, objective)
      options.trace?.("omo.goal.auto-started", {
        sessionID: event.sessionID,
        goalID: goal.id,
        objectiveUpdatedAt: goal.updatedAt,
      })
    } catch (error) {
      if (error instanceof InvalidObjectiveError) {
        options.trace?.("omo.goal.auto-start-skipped", {
          sessionID: event.sessionID,
          reason: "invalid-objective",
        })
        return
      }
      throw error
    }
  }
}
