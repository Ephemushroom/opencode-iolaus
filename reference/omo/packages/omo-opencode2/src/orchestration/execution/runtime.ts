import type { Context } from "@opencode/plugin/effect/plugin"
import type { Deferred, Effect, Queue, Scope, Semaphore } from "effect"
import type { Admission } from "./admission"
import type { ExecutionError } from "./errors"
import type { ExecutionRecord, SubmitRequest, TerminalRecord } from "./types"

export type Settlement = {
  readonly status: TerminalRecord["status"]
  readonly output: string
  readonly reason?: string
}

export interface ExecutionDriver {
  readonly run: (record: ExecutionRecord, request: SubmitRequest) => Effect.Effect<Settlement, ExecutionError>
  readonly drain: (record: ExecutionRecord) => Effect.Effect<void, ExecutionError>
}

export type Entry = {
  record: ExecutionRecord
  readonly request: SubmitRequest
  readonly done: Deferred.Deferred<TerminalRecord, ExecutionError>
  readonly cancellation: Deferred.Deferred<void>
}

export type ExecutionRuntime = {
  readonly entries: Map<string, Entry>
  readonly records: Map<string, ExecutionRecord>
  readonly owners: Set<string>
  readonly admission: Admission
  readonly mutex: Semaphore.Semaphore
  readonly signal: Queue.Queue<void>
  readonly scope: Scope.Scope
  readonly driver: ExecutionDriver
  readonly storage: Context["storage"]
  readonly prefix: string
  readonly writer: string
  readonly notify?: (record: TerminalRecord) => Effect.Effect<void, ExecutionError>
  closed: boolean
}
