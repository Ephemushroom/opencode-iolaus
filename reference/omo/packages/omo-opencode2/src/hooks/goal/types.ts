import * as z from "zod"

export const GOAL_STATUS_VALUES = ["active", "paused", "complete"] as const
export const GoalStatusSchema = z.enum(GOAL_STATUS_VALUES)
export type GoalStatus = z.infer<typeof GoalStatusSchema>

export const GoalSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  objective: z.string(),
  status: GoalStatusSchema,
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastStartedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
})
export type Goal = z.infer<typeof GoalSchema>

export const GoalFileSchema = z.object({
  version: z.literal(1),
  goal: GoalSchema.nullable(),
})
export type GoalFile = z.infer<typeof GoalFileSchema>

export type GoalUpdate = {
  readonly objective?: string
  readonly status?: GoalStatus
}

export const GoalToolSnapshotSchema = z.object({
  sessionID: z.string(),
  objective: z.string(),
  status: GoalStatusSchema,
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export const GoalToolResponseSchema = z.object({
  goal: GoalToolSnapshotSchema.nullable(),
})

export type GoalTrace = (event: string, detail?: Record<string, unknown>) => void
