import { buildRetryGuidance, detectDelegateTaskError } from "@oh-my-opencode/delegate-core"

const EMPTY_TASK_RESPONSE_WARNING = `[Task Empty Response Warning]

Task invocation completed but returned no response. This indicates the agent either:
- Failed to execute properly
- Did not terminate correctly
- Returned an empty result

Note: The call has already completed - you are NOT waiting for a response. Proceed accordingly.`

export type TaskResultGuidance =
  | {
      readonly kind: "empty_response"
      readonly content: string
    }
  | {
      readonly kind: "retryable_error"
      readonly content: string
      readonly errorType: string
    }
  | {
      readonly kind: "usable"
      readonly content: string
    }

export type TaskResultGuidanceTrace = (
  event: string,
  detail?: Readonly<Record<string, unknown>>,
) => void

export function guideTaskResult(
  output: string,
  trace?: TaskResultGuidanceTrace,
): TaskResultGuidance {
  if (output.trim() === "") {
    trace?.("omo.task.unusable-output-detected", { reason: "empty_response" })
    return { kind: "empty_response", content: EMPTY_TASK_RESPONSE_WARNING }
  }

  const error = detectDelegateTaskError(output)
  if (error) {
    trace?.("omo.task.unusable-output-detected", {
      reason: "retryable_error",
      errorType: error.errorType,
    })
    return {
      kind: "retryable_error",
      content: `${output}\n${buildRetryGuidance(error)}`,
      errorType: error.errorType,
    }
  }

  return { kind: "usable", content: output }
}
