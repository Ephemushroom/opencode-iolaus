import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { GoalFileSchema } from "./types"
import type { Goal, GoalFile, GoalUpdate } from "./types"

const STORE_VERSION = 1

export function goalFilePath(projectDir: string, sessionID: string): string {
  return join(projectDir, ".omo", "goal", `${encodeURIComponent(sessionID)}.json`)
}

export function readGoal(projectDir: string, sessionID: string): Goal | null {
  let raw: string
  try {
    raw = readFileSync(goalFilePath(projectDir, sessionID), "utf-8")
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") return null
    throw error
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    const result = GoalFileSchema.safeParse(parsed)
    return result.success ? result.data.goal : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

export function writeGoal(projectDir: string, sessionID: string, goal: Goal): void {
  const filePath = goalFilePath(projectDir, sessionID)
  const tempPath = `${filePath}.tmp.${randomUUID()}`
  const file: GoalFile = { version: STORE_VERSION, goal }
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf-8")
  renameSync(tempPath, filePath)
}

export function createStoredGoal(projectDir: string, sessionID: string, objective: string): Goal {
  const now = nowSeconds()
  const goal: Goal = {
    id: randomUUID(),
    sessionID,
    objective,
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
    lastStartedAt: now,
  }
  writeGoal(projectDir, sessionID, goal)
  return goal
}

export function updateStoredGoal(projectDir: string, sessionID: string, update: GoalUpdate): Goal | null {
  const existing = readGoal(projectDir, sessionID)
  if (existing === null) return null

  const now = nowSeconds()
  const updated: Goal = {
    ...existing,
    objective: update.objective ?? existing.objective,
    status: update.status ?? existing.status,
    updatedAt: now,
    ...(update.status === "active" && existing.status !== "active" ? { lastStartedAt: now } : {}),
    ...(update.status === "complete" && existing.status !== "complete" ? { completedAt: now } : {}),
  }
  writeGoal(projectDir, sessionID, updated)
  return updated
}

export function clearStoredGoal(projectDir: string, sessionID: string): boolean {
  try {
    unlinkSync(goalFilePath(projectDir, sessionID))
    return true
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") return false
    throw error
  }
}

function isErrorWithCode(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

function nowSeconds(): number {
  return Math.trunc(Date.now() / 1000)
}
