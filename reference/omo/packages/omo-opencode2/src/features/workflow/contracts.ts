import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import type { Deferred, Effect, Scope, Semaphore } from "effect"
import type { Executor } from "../../orchestration/execution/types"
import type { Start, WorkflowError, WorkflowID, WorkflowRecord } from "./types"

export interface Workflow {
  readonly start: (input: Start, caller: Session.ID) => Effect.Effect<WorkflowRecord, WorkflowError>
  readonly snapshot: (id: WorkflowID, caller: Session.ID) => Effect.Effect<WorkflowRecord, WorkflowError>
  readonly wait: (id: WorkflowID, caller: Session.ID) => Effect.Effect<WorkflowRecord, WorkflowError>
  readonly cancel: (id: WorkflowID, caller: Session.ID) => Effect.Effect<WorkflowRecord, WorkflowError>
  readonly retry: (id: WorkflowID, caller: Session.ID, request: { readonly expectedGeneration: number; readonly key: string }) => Effect.Effect<WorkflowRecord, WorkflowError>
}

export type WorkflowOptions = {
  readonly executor: Executor
  readonly storage: Context["storage"]
  readonly prefix: string
  readonly agents: ReadonlySet<string>
}

// Entries hold the current immutable record and the current attempt's completion.
export type Entry = {
  record: WorkflowRecord
  done: Deferred.Deferred<WorkflowRecord, WorkflowError>
}

export type Runtime = WorkflowOptions & {
  readonly entries: Map<WorkflowID, Entry>
  readonly mutex: Semaphore.Semaphore
  readonly scope: Scope.Scope
  closed: boolean
}
