import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Schema, type Effect } from "effect"
import type { ExecutionError } from "./errors"

export const TaskID = Schema.String.pipe(Schema.brand("Omo.TaskID"))
export type TaskID = typeof TaskID.Type
export const RunRef = Schema.Struct({ taskID: TaskID, generation: Schema.Number })
export type RunRef = typeof RunRef.Type

const Caller = { callerSessionID: Session.ID, rootSessionID: Session.ID }
export const Owner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("task"), ...Caller }),
  Schema.Struct({ kind: Schema.Literal("team"), ...Caller, teamRunID: Schema.String, member: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("workflow"), ...Caller, workflowID: Schema.String, nodeID: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("btw"), ...Caller }),
  Schema.Struct({ kind: Schema.Literal("look_at"), ...Caller }),
])
export type Owner = typeof Owner.Type

export const Status = Schema.Literals(["queued", "starting", "running", "cancelling", "completed", "failed", "cancelled", "interrupted"])
export type Status = typeof Status.Type
export const ExecutionRecord = Schema.Struct({
  version: Schema.Literal(1), ref: RunRef, owner: Owner,
  writer: Schema.String, sessionID: Session.ID, inputID: SessionMessage.ID,
  agent: Agent.ID, model: Model.Ref, description: Schema.String,
  status: Status, output: Schema.String, reason: Schema.optional(Schema.String),
  background: Schema.Boolean, createdAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
  notificationPending: Schema.optional(Schema.Boolean),
  notificationError: Schema.optional(Schema.String),
})
export type ExecutionRecord = typeof ExecutionRecord.Type
export type TerminalRecord = ExecutionRecord & {
  readonly status: "completed" | "failed" | "cancelled" | "interrupted"
}

type Request = {
  readonly owner: Owner
  readonly text: string
  readonly description: string
  readonly background: boolean
  readonly metadata?: Readonly<Record<string, Schema.Json>>
  readonly immediate?: boolean
  readonly inputID?: SessionMessage.ID
}
export type SubmitRequest = Request & (
  | { readonly kind: "fresh"; readonly agent: Agent.ID; readonly model: Model.Ref; readonly sessionID?: Session.ID }
  | { readonly kind: "continuation"; readonly previous: RunRef; readonly model?: Model.Ref }
  | { readonly kind: "message"; readonly previous: RunRef; readonly model?: Model.Ref }
)

export interface Executor {
  readonly submit: (request: SubmitRequest) => Effect.Effect<RunRef, ExecutionError>
  readonly snapshot: (ref: RunRef) => Effect.Effect<ExecutionRecord, ExecutionError>
  readonly wait: (ref: RunRef) => Effect.Effect<TerminalRecord, ExecutionError>
  readonly cancel: (ref: RunRef) => Effect.Effect<void, ExecutionError>
  readonly cancelMany: (refs: readonly RunRef[]) => Effect.Effect<void, ExecutionError>
  readonly closeOwner: (owner: Owner) => Effect.Effect<void, ExecutionError>
  readonly stopOwner: (owner: Owner, mode: "graceful" | "force") => Effect.Effect<void, ExecutionError>
  readonly managed: (sessionID: Session.ID) => Effect.Effect<ExecutionRecord | undefined>
  readonly list: (owner?: Owner) => Effect.Effect<readonly ExecutionRecord[]>
  readonly latest: (taskID: TaskID) => Effect.Effect<ExecutionRecord | undefined>
}

export function runKey(ref: RunRef): string {
  return `${ref.taskID}/${ref.generation}`
}

export function isTerminal(record: ExecutionRecord): record is TerminalRecord {
  switch (record.status) {
    case "completed": case "failed": case "cancelled": case "interrupted": return true
    case "queued": case "starting": case "running": case "cancelling": return false
    default: return assertNever(record.status)
  }
}

export function assertNever(value: never): never {
  throw new TypeError(`Unexpected execution variant: ${String(value)}`)
}

export function ownerKey(owner: Owner): string {
  const caller = `${owner.rootSessionID}/${owner.callerSessionID}`
  switch (owner.kind) {
    case "task": case "btw": case "look_at": return `${caller}/${owner.kind}`
    case "team": return `${caller}/team/${owner.teamRunID}/${owner.member}`
    case "workflow": return `${caller}/workflow/${owner.workflowID}/${owner.nodeID}`
    default: return assertNever(owner)
  }
}
