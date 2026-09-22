import * as z from "zod"

import type { GoalController } from "./controller"
import { GOAL_STATUS_VALUES, GoalToolResponseSchema } from "./types"
import type { GoalTrace } from "./types"

const CreateGoalInputSchema = z.object({
  objective: z.string(),
}).strict()

const UpdateGoalInputSchema = z.object({
  status: z.enum(GOAL_STATUS_VALUES),
}).strict()

const GetGoalInputSchema = z.object({}).strict()

export type GoalToolExecutionContext = {
  readonly sessionID: string
}

export type GoalToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input: {
    readonly type: "object"
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
    readonly additionalProperties: false
  }
  readonly options: { readonly codemode: false }
  readonly execute: (
    input: unknown,
    context: GoalToolExecutionContext,
  ) => Promise<{ readonly content: string }>
}

export type GoalToolsDependencies = {
  readonly controller: GoalController
  readonly trace?: GoalTrace
}

function formatResponse(goal: ReturnType<GoalController["getGoal"]>): string {
  return JSON.stringify(GoalToolResponseSchema.parse({ goal }), null, 2)
}

export function createGoalTools(dependencies: GoalToolsDependencies): readonly GoalToolDefinition[] {
  const { controller, trace } = dependencies

  return [
    {
      name: "create_goal",
      description: "Create or replace the persistent goal for the current session.",
      input: {
        type: "object",
        properties: {
          objective: { type: "string", description: "Concise outcome the session should achieve" },
        },
        required: ["objective"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        const args = CreateGoalInputSchema.parse(input)
        const sessionID = context.sessionID
        const goal = controller.setGoal(sessionID, args.objective)
        trace?.("omo.goal.created", { sessionID, goalID: goal.id, status: goal.status })
        return { content: formatResponse(goal) }
      },
    },
    {
      name: "update_goal",
      description: "Update the persistent goal status for the current session.",
      input: {
        type: "object",
        properties: {
          status: { type: "string", enum: GOAL_STATUS_VALUES, description: "New goal status" },
        },
        required: ["status"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        const args = UpdateGoalInputSchema.parse(input)
        const sessionID = context.sessionID
        switch (args.status) {
          case "active":
            controller.resumeGoal(sessionID)
            break
          case "paused":
            controller.pauseGoal(sessionID)
            break
          case "complete": {
            const completed = controller.markComplete(sessionID)
            if (completed !== null) {
              trace?.("omo.goal.completed", {
                sessionID,
                goalID: completed.id,
                timeUsedSeconds: completed.timeUsedSeconds,
                tokensUsed: completed.tokensUsed,
              })
            }
            break
          }
          default: {
            const exhaustiveStatus: never = args.status
            return exhaustiveStatus
          }
        }
        return { content: formatResponse(controller.getGoal(sessionID)) }
      },
    },
    {
      name: "get_goal",
      description: "Read the persistent goal for the current session.",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        GetGoalInputSchema.parse(input)
        return { content: formatResponse(controller.getGoal(context.sessionID)) }
      },
    },
  ]
}
