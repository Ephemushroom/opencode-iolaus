import { clearStoredGoal, createStoredGoal, readGoal, updateStoredGoal } from "./store"
import type { Goal } from "./types"

const MAX_OBJECTIVE_LENGTH = 2000

export class InvalidObjectiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidObjectiveError"
  }
}

export type GoalController = ReturnType<typeof createGoalController>

export function createGoalController(options: { readonly projectDir: string }) {
  const { projectDir } = options

  return {
    setGoal(sessionID: string, rawObjective: string): Goal {
      const objective = validateObjective(rawObjective)
      clearStoredGoal(projectDir, sessionID)
      return createStoredGoal(projectDir, sessionID, objective)
    },

    getGoal(sessionID: string): Goal | null {
      return readGoal(projectDir, sessionID)
    },

    pauseGoal(sessionID: string): Goal | null {
      return updateStoredGoal(projectDir, sessionID, { status: "paused" })
    },

    resumeGoal(sessionID: string): Goal | null {
      return updateStoredGoal(projectDir, sessionID, { status: "active" })
    },

    markComplete(sessionID: string): Goal | null {
      return updateStoredGoal(projectDir, sessionID, { status: "complete" })
    },

    clearGoal(sessionID: string): boolean {
      return clearStoredGoal(projectDir, sessionID)
    },
  }
}

function validateObjective(objective: string): string {
  const trimmed = objective.trim()
  if (trimmed.length === 0) {
    throw new InvalidObjectiveError("Objective cannot be empty")
  }
  if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
    throw new InvalidObjectiveError(`Objective exceeds maximum length of ${MAX_OBJECTIVE_LENGTH} characters`)
  }
  return trimmed
}
