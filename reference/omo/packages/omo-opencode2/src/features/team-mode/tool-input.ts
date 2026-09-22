import type { Task } from "@oh-my-opencode/team-core"

export function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : {}
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} is required`)
  return value
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key]
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
}

export function taskStatus(record: Record<string, unknown>, key: string): Task["status"] {
  const value = requiredString(record, key)
  if (value === "pending" || value === "claimed" || value === "in_progress" || value === "completed" || value === "deleted") return value
  throw new Error(`${key} must be a valid task status`)
}
