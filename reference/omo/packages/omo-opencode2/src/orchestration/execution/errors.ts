import { Data } from "effect"

export class ExecutionError extends Data.TaggedError("ExecutionError")<{
  readonly code: "not-found" | "owner-closed" | "capacity" | "conflict" | "host" | "storage"
  readonly message: string
}> {}

export function hostError(error: unknown): ExecutionError {
  return new ExecutionError({ code: "host", message: error instanceof Error ? error.message : String(error) })
}
