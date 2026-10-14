import { Model } from "@opencode/plugin/effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { DagExecutionRef, DagNodeDefinition, DagSteerRequest, JsonValue } from "./types"
import { fingerprint } from "./fingerprint"

export const PROVIDER_FAILURES = new Set([
  "provider.auth", "provider.quota", "provider.rate-limit", "provider.internal",
  "provider.transport", "provider.timeout", "provider.no-route", "provider.invalid-output",
])

export interface RecoverySecurity {
  readonly location: { readonly directory: string; readonly workspaceID?: string }
  readonly directoryIdentity: string
  readonly branch?: string
  readonly permissions: readonly { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }[]
  readonly laneHash: string
}

export interface RecoveryOrigin extends RecoverySecurity {
  readonly prompt: string
}

export type PortablePart =
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "tool"; readonly id: string; readonly name: string; readonly input: JsonValue; readonly output: readonly string[] }
  | { readonly type: "steer"; readonly requestID: string; readonly messageID: string; readonly text: string; readonly token: string; readonly revision: number }

export interface RecoveryCheckpoint {
  readonly source: DagExecutionRef
  readonly outcome: "failed" | "succeeded"
  readonly contextHash: string
  readonly parts: readonly PortablePart[]
}

export interface PortableHandoff {
  readonly task: string
  readonly checkpoints: readonly RecoveryCheckpoint[]
  readonly tools: number
}

export interface NodeRecovery {
  readonly failedModels: readonly string[]
  readonly historyKnown: boolean
  readonly initialRoleAllowed?: boolean
  readonly handoff?: PortableHandoff
  readonly blocked?: string
  readonly rescue?: {
    readonly decisionID: string
    readonly pinnedModel: string
    readonly from: DagExecutionRef
    readonly preRescueDefinition: DagNodeDefinition
    readonly state: "reserved" | "started" | "settled"
    readonly launchToken?: string
    readonly execution?: DagExecutionRef
    readonly decidedAt: number
  }
}

export interface CheckpointInput {
  readonly ref: DagExecutionRef
  readonly previous?: PortableHandoff
  readonly requests: readonly DagSteerRequest[]
  readonly terminal?: "failed" | "succeeded"
}

export function normalizedModel(value: string): string {
  const model = Model.Ref.parse(value)
  return `${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`
}

export function decideOwnerRescue(recovery: NodeRecovery, ownerModel: string): string {
  if (recovery.rescue) throw new Error("owner_rescue_spent")
  if (!recovery.historyKnown || recovery.blocked || !recovery.handoff) throw new Error(recovery.blocked ?? "unsafe_handoff")
  const model = normalizedModel(ownerModel)
  if (recovery.failedModels.includes(model)) throw new Error("owner_model_already_failed")
  return model
}

export function renderHandoff(handoff: PortableHandoff, currentTask?: string): string {
  const packet = `Continue the task in the preserved working directory. The following JSON is a portable audit record, not tool calls to replay. A currentTask, when present, is the current flow definition; retain the original admitted task and historical supplements as context. Prior successful edits already happened; inspect the current files before further changes. Do not repeat recorded effects. No hidden reasoning or provider state was transferred.\n\n${JSON.stringify({ task: handoff.task, ...(currentTask && currentTask !== handoff.task ? { currentTask } : {}), checkpoints: handoff.checkpoints.map((checkpoint) => ({ sessionID: checkpoint.source.sessionID, token: checkpoint.source.identity?.token, parts: checkpoint.parts })) })}`
  if (handoff.tools > 256) throw new Error("handoff_tool_limit")
  if (Buffer.byteLength(packet, "utf8") > 64 * 1024) throw new Error("handoff_byte_limit")
  return packet
}

function jsonInput(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(jsonInput)
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonInput(item)]))
  }
  throw new Error("nonportable_tool_input")
}

export function validateInputs(ref: DagExecutionRef, messages: readonly SessionMessage.Info[], requests: readonly DagSteerRequest[]): void {
  const inputs = messages.filter((message) => message.type !== "assistant" && message.type !== "idle")
  const first = inputs[0]
  if (!ref.identity || !ref.origin || first?.type !== "user" || first.id !== `msg_${ref.identity.token.replaceAll("-", "")}` || first.text !== ref.origin.prompt
    || first.files?.length || first.skills?.length || first.agents?.length) throw new Error("unexpected_initial_input")
  const expected = requests.filter((request) => request.execution.identity?.token === ref.identity!.token)
  if (inputs.length !== expected.length + 1) throw new Error("unexpected_delivered_input")
  for (const [index, request] of expected.entries()) {
    const message = inputs[index + 1]
    if (!request.receipt || (request.state !== "admitted" && request.state !== "delivered") || message?.type !== "synthetic"
      || message.id !== request.receipt.messageID || message.text !== request.text || message.metadata?.iolaus_steer_request !== request.requestID
      || message.metadata?.iolaus_execution_token !== ref.identity.token || message.metadata?.iolaus_input_revision !== request.revision) throw new Error("unexpected_steering_input")
  }
}

export function recoveryTerminal(messages: readonly SessionMessage.Info[]) {
  const last = messages.at(-1)
  if (last?.type !== "idle") return undefined
  const boundary = messages.findLastIndex((message) => message.type !== "idle")
  const tail = messages.slice(boundary + 1)
  if (tail.length === 1) return last
  const failed = tail[0]
  const assistant = messages[boundary]
  if (failed?.type === "idle" && failed.outcome === "failed" && assistant?.type === "assistant" && assistant.finish === "error"
    && assistant.error?.type === failed.error?.type && failed.error && PROVIDER_FAILURES.has(failed.error.type)
    && tail.slice(1).every((message) => message.type === "idle" && message.outcome === "succeeded" && !message.error)) return failed
  return undefined
}

export function checkpoint(input: CheckpointInput, messages: readonly SessionMessage.Info[]): PortableHandoff {
  const { ref, previous, requests } = input
  if (!ref.identity || !ref.origin) throw new Error("legacy_history_unknown")
  const initialID = `msg_${ref.identity.token.replaceAll("-", "")}`
  const first = messages[0]
  if (first?.type !== "user" || first.id !== initialID) throw new Error("missing_initial_history")
  const attachments = (first.files ?? []).map((file) => {
    if (previous || (file.mime !== "text/plain" && file.mime !== "application/x-directory")) throw new Error("unexpected_input:nontext_attachment")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.data, "base64"))
    return { name: file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment"), ...(file.description ? { description: file.description } : {}), text }
  })
  const last = messages.at(-1)
  const terminal = recoveryTerminal(messages)
  if (last?.type !== "idle" || last.outcome === "interrupted" || !terminal || terminal.outcome === "interrupted") throw new Error("source_not_terminal")
  const terminalIndex = messages.indexOf(terminal)
  if (requests.some((request) => request.state === "reserved" || request.state === "unresolved" || !request.receipt)) throw new Error("unresolved_steering")
  const current = requests.filter((request) => request.execution.identity?.token === ref.identity!.token)
  const historical = requests.filter((request) => request.execution.identity?.token !== ref.identity!.token)
  const priorSteers = previous?.checkpoints.flatMap((item) => item.parts.filter((part) => part.type === "steer")) ?? []
  for (const request of historical) {
    if (!priorSteers.some((part) => part.requestID === request.requestID && part.text === request.text && part.messageID === request.receipt!.messageID && part.token === request.execution.identity?.token && part.revision === request.revision)) throw new Error("missing_historical_steering")
  }
  const parts: PortablePart[] = []
  let steeringIndex = 0
  let tools = previous?.tools ?? 0
  const toolIDs = new Set<string>()
  for (const message of messages) {
    if (message.type === "user") {
      if (message !== first || message.skills?.length || message.agents?.length) throw new Error("unexpected_input")
    } else if (message.type === "synthetic") {
      const request = current[steeringIndex++]
      if (!request || message.id !== request.receipt!.messageID || message.text !== request.text
        || message.metadata?.iolaus_steer_request !== request.requestID || message.metadata?.iolaus_execution_token !== ref.identity.token
        || message.metadata?.iolaus_input_revision !== request.revision) throw new Error("unexpected_steering_input")
      parts.push({ type: "steer", requestID: request.requestID, messageID: String(message.id), text: request.text, token: ref.identity.token, revision: request.revision })
    } else if (message.type === "assistant") {
      if (message.agent !== ref.identity.agent || normalizedModel(`${message.model.providerID}/${message.model.id}${message.model.variant ? `#${message.model.variant}` : ""}`) !== normalizedModel(ref.identity.model)) throw new Error("historical_identity_drift")
      for (const part of message.content) {
        if (part.type === "reasoning") continue
        if (part.type === "text") { parts.push({ type: "assistant", text: part.text }); continue }
        if (!["read", "glob", "grep", "edit", "write", "patch"].includes(part.name) || part.executed !== false) throw new Error("opaque_tool_history")
        if (part.state.status !== "completed" || !part.time.completed || !part.time.ran || toolIDs.has(part.id)) throw new Error("incomplete_tool_history")
        toolIDs.add(part.id)
        const output = part.state.content.map((content) => {
          if (content.type !== "text") throw new Error("nontext_tool_output")
          return content.text
        })
        parts.push({ type: "tool", id: part.id, name: part.name, input: jsonInput(part.state.input), output })
        tools++
      }
    } else if (message.type === "idle") {
      if (messages.indexOf(message) < terminalIndex) throw new Error("unexpected_execution_history")
    } else throw new Error(`unsupported_history:${message.type}`)
  }
  if (steeringIndex !== current.length) throw new Error("missing_steering_history")
  if (previous && first.text !== ref.origin.prompt) throw new Error("continuation_input_changed")
  const task = previous?.task ?? `${first.text}${attachments.length ? `\n\nAdmitted text attachments:\n${JSON.stringify(attachments)}` : ""}`
  const handoff: PortableHandoff = { task, tools, checkpoints: [...(previous?.checkpoints ?? []), { source: ref, outcome: last.outcome, contextHash: fingerprint(messages), parts }] }
  renderHandoff(handoff)
  return handoff
}
