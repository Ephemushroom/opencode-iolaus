import { Data } from "effect"
import { DagValidationError } from "./graph-error"

export { DagValidationError }

/** A child execution (session start/wait/cancel) failed; the scheduler turns this into node retry/failure. */
/** `model` marks a failure of the model call itself (the child session or judge call failed), which a fallback model may fix. */
export class DagRunnerError extends Data.TaggedError("DagRunnerError")<{ readonly message: string; readonly nodeID?: string; readonly cause?: unknown; readonly model?: boolean }> {}

export type DagError = DagValidationError | DagRunnerError

export function toDagValidationError(error: unknown): DagValidationError {
  return error instanceof DagValidationError ? error : new DagValidationError(error instanceof Error ? error.message : String(error))
}

export function errorMessage(error: unknown): string {
  if (error instanceof DagRunnerError) return error.message
  return error instanceof Error ? error.message : String(error)
}
