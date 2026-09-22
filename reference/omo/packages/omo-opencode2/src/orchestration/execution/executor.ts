import type { Context } from "@opencode/plugin/effect/plugin"
import { mkdir, rm } from "node:fs/promises"
import { Deferred, Effect, Exit, Queue, Scope, Semaphore } from "effect"
import { Admission } from "./admission"
import { cancelMany, cancelRun, closeOwner, enqueuePendingNotification, runEntry, stopOwner, waitFor } from "./lifecycle"
import { loadRecords, readRecord, saveRecord } from "./records"
import type { ExecutionDriver, ExecutionRuntime } from "./runtime"
import { submit } from "./submit"
import { isTerminal, ownerKey, runKey, type ExecutionRecord, type Executor, type Owner, type TaskID, type TerminalRecord } from "./types"
import { ExecutionError } from "./errors"
import type { SubmitRequest } from "./types"

export type ExecutorOptions = {
  readonly driver: ExecutionDriver
  readonly storage: Context["storage"]
  readonly prefix: string
  readonly writer: string
  readonly limits?: { readonly model: number; readonly team: number }
  readonly lockPath?: string
  readonly notify?: (record: TerminalRecord) => Effect.Effect<void, ExecutionError>
}

export const createExecutor = Effect.fn("execution.createExecutor")(function* (options: ExecutorOptions) {
  const runtime: ExecutionRuntime = {
    ...options, entries: new Map(), records: new Map(), owners: new Set(), closed: false,
    admission: new Admission(options.limits), mutex: yield* Semaphore.make(1),
    signal: yield* Queue.unbounded<void>(), scope: yield* Scope.make(),
  }
  if (options.lockPath) {
    const lockPath = options.lockPath
    yield* Effect.tryPromise({ try: () => mkdir(lockPath, { recursive: false }),
      catch: () => new ExecutionError({ code: "conflict", message: `Execution writer is already active: ${lockPath}` }) })
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(lockPath, { recursive: true, force: true })))
  }
  const stored = yield* loadRecords(runtime)
  for (const record of stored) runtime.records.set(runKey(record.ref), record)
  for (const record of stored) {
    if (isTerminal(record)) {
      yield* enqueuePendingNotification(runtime, record)
    } else {
      const request: SubmitRequest = { kind: "fresh", owner: record.owner, agent: record.agent, model: record.model,
        text: "", description: record.description, background: record.background }
      const entry = { record, request, done: yield* Deferred.make<TerminalRecord, ExecutionError>(), cancellation: yield* Deferred.make<void>() }
      runtime.entries.set(runKey(record.ref), entry)
      if (record.status !== "queued") yield* runtime.driver.drain(record)
      const interrupted = { ...record, status: "interrupted" as const, reason: "Recovered unfinished execution" }
      yield* saveRecord(runtime, interrupted)
      yield* Deferred.succeed(entry.done, interrupted)
    }
  }
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    runtime.closed = true
    yield* Scope.close(runtime.scope, Exit.void)
    for (const entry of runtime.entries.values()) {
      if (entry.record.status === "queued") yield* cancelRun(runtime, entry.record.ref).pipe(Effect.orDie)
    }
    yield* Queue.shutdown(runtime.signal)
  }))
  const scheduler = Effect.gen(function* () {
    for (;;) {
      yield* Queue.take(runtime.signal)
      yield* Semaphore.withPermit(runtime.mutex)(Effect.gen(function* () {
        if (runtime.closed) return
        for (const permit of runtime.admission.take()) {
          const entry = runtime.entries.get(permit.key)
          if (!entry || isTerminal(entry.record)) {
            runtime.admission.release(permit.key)
            continue
          }
          yield* saveRecord(runtime, { ...entry.record, status: "starting" })
          yield* Effect.forkIn(runEntry(runtime, entry), runtime.scope)
        }
      }))
    }
  })
  yield* Effect.forkIn(scheduler, runtime.scope)
  const executor: Executor = {
    submit: (request) => submit(runtime, request),
    snapshot: (ref) => readRecord(runtime, ref),
    wait: (ref) => waitFor(runtime, ref),
    cancel: (ref) => cancelRun(runtime, ref),
    cancelMany: (refs) => cancelMany(runtime, refs),
    closeOwner: (owner) => closeOwner(runtime, owner).pipe(Effect.asVoid),
    stopOwner: (owner, mode) => stopOwner(runtime, { owner, mode }),
    managed: (sessionID) => Effect.sync(() => [...runtime.records.values()]
      .filter((record) => record.sessionID === sessionID)
      .reduce<ExecutionRecord | undefined>((latest, record) =>
        !latest || record.ref.generation > latest.ref.generation ? record : latest, undefined)),
    list: (owner?: Owner) => Effect.sync(() => [...runtime.records.values()].filter((record) => !owner || ownerKey(record.owner) === ownerKey(owner))),
    latest: (taskID: TaskID) => Effect.sync(() => [...runtime.records.values()]
      .filter((record) => record.ref.taskID === taskID)
      .reduce<ExecutionRecord | undefined>((latest, record) =>
        !latest || record.ref.generation > latest.ref.generation ? record : latest, undefined)),
  }
  return executor
})
