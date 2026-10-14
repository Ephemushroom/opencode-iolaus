import { Model } from "@opencode/plugin/effect"
import type { DagExecutionRef, DagNodeDefinition } from "./types"

/**
 * Durable per-node recovery state, kept in `dag_node_recovery` so it survives node-row rebuilds, reloads and amend.
 * `continueFrom` is the child session a model-failure retry continues in: the next model is switched into that session
 * and told to continue, so the task, completed tool effects and delivered supplements stay in the host's history.
 */
export interface NodeRecovery {
  readonly failedModels: readonly string[]
  readonly continueFrom?: DagExecutionRef
  /** The node's one owner-model rescue. Present means spent; `settled` once its execution ended or was abandoned. */
  readonly rescue?: {
    readonly decisionID: string
    readonly model: string
    readonly from: string
    readonly preRescueDefinition: DagNodeDefinition
    readonly settled: boolean
    readonly decidedAt: number
  }
}

/** Canonical `provider/model[#variant]`, so a lane's "x/y#default" and a session's "x/y" compare equal. */
export function normalizedModel(value: string): string {
  try {
    const model = Model.Ref.parse(value)
    return `${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`
  } catch {
    return value
  }
}

/** The prompt that resumes a failed child session after its model was switched. */
export function continuationPrompt(from: string, to: string): string {
  return `<iolaus-continuation from="${from}" to="${to}">\nThe previous model (${from}) stopped with a provider failure before finishing. You are ${to}, continuing in the same session. Everything above is the real history: the task, any supplements and the tool calls that already ran. Their effects are already in the working directory, so inspect the current state and do not repeat completed work. Continue the task from where it stopped and deliver the final result.\n</iolaus-continuation>`
}
