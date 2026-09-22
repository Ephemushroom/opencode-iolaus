import { Cause, Clock, Deferred, Effect, Queue, Semaphore } from "effect"
import { ExecutionError } from "./errors"
import { readRecord, saveRecord } from "./records"
import type { Entry, ExecutionRuntime, Settlement } from "./runtime"
import { isTerminal, ownerKey, runKey, type Owner, type RunRef, type TerminalRecord } from "./types"

export const waitFor = Effect.fn("execution.wait")(function* (runtime: ExecutionRuntime, ref: RunRef) {
  const record = yield* readRecord(runtime, ref)
  if (isTerminal(record)) return record
  const entry = runtime.entries.get(runKey(ref))
  if (!entry) return yield* new ExecutionError({ code: "conflict", message: "Execution belongs to a different writer" })
  return yield* Deferred.await(entry.done)
})

export const cancelMany = Effect.fn("execution.cancelMany")(function* (runtime: ExecutionRuntime, refs: readonly RunRef[]) {
  yield* Semaphore.withPermit(runtime.mutex)(Effect.gen(function* () {
    for (const ref of refs) {
    const record = yield* readRecord(runtime, ref)
    if (isTerminal(record)) continue
    const entry = runtime.entries.get(runKey(ref))
    if (!entry) return yield* new ExecutionError({ code: "conflict", message: "Cannot cancel another writer's execution" })
    if (record.status === "queued") {
      runtime.admission.remove(runKey(ref))
      yield* finish(runtime, entry, { status: "cancelled", output: "" })
    } else {
      yield* saveRecord(runtime, { ...record, status: "cancelling" })
      yield* Deferred.succeed(entry.cancellation, undefined)
    }
    }
  }))
})

export const cancelRun = (runtime: ExecutionRuntime, ref: RunRef) => cancelMany(runtime, [ref])

export const closeOwner = Effect.fn("execution.closeOwner")(function* (runtime: ExecutionRuntime, owner: Owner) {
  const key = ownerKey(owner)
  const refs = yield* Semaphore.withPermit(runtime.mutex)(Effect.sync(() => {
    runtime.owners.add(key)
    return [...runtime.entries.values()].filter((entry) => ownerKey(entry.record.owner) === key).map((entry) => entry.record.ref)
  }))
  for (const ref of refs) {
    const record = yield* readRecord(runtime, ref)
    if (record.status === "queued") yield* cancelRun(runtime, ref)
  }
  return refs
})

export const stopOwner = Effect.fn("execution.stopOwner")(function* (
  runtime: ExecutionRuntime,
  input: { readonly owner: Owner; readonly mode: "graceful" | "force" },
) {
  const refs = yield* closeOwner(runtime, input.owner)
  if (input.mode === "force") for (const ref of refs) yield* cancelRun(runtime, ref)
  for (const ref of refs) yield* waitFor(runtime, ref)
})

export const finish = Effect.fn("execution.finish")(function* (runtime: ExecutionRuntime, entry: Entry, result: Settlement) {
  const record: TerminalRecord = { ...entry.record, ...result, completedAt: yield* Clock.currentTimeMillis,
    notificationPending: entry.record.background && runtime.notify !== undefined && (result.status === "completed" || result.status === "failed") }
  yield* saveRecord(runtime, record)
  runtime.admission.release(runKey(record.ref))
  yield* enqueuePendingNotification(runtime, record)
  yield* Deferred.succeed(entry.done, record)
  yield* Queue.offer(runtime.signal, undefined)
})

export const enqueuePendingNotification = Effect.fn("execution.enqueuePendingNotification")(function* (runtime: ExecutionRuntime, record: TerminalRecord) {
  const notify = runtime.notify
  if (!record.notificationPending || !notify) return
  const accepted = yield* Effect.result(notify(record))
  if (accepted._tag === "Success") {
    yield* saveRecord(runtime, { ...record, notificationPending: false })
  } else {
    yield* saveRecord(runtime, { ...record, notificationError: accepted.failure.message })
  }
}, Effect.catchCause((cause) => Effect.logError("execution notification enqueue failed", Cause.pretty(cause))))

export const runEntry = Effect.fn("execution.runEntry")(function* (runtime: ExecutionRuntime, entry: Entry) {
  const body = Effect.gen(function* () {
    yield* saveRecord(runtime, { ...entry.record, status: "running" })
    const result = yield* Effect.raceFirst(
      runtime.driver.run(entry.record, entry.request),
      Deferred.await(entry.cancellation).pipe(Effect.as({ status: "cancelled", output: "" } satisfies Settlement)),
    )
    if (result.status === "cancelled") yield* runtime.driver.drain(entry.record)
    yield* Semaphore.withPermit(runtime.mutex)(finish(runtime, entry, result))
  })
  yield* body.pipe(Effect.onInterrupt(() => Effect.gen(function* () {
    if (isTerminal(entry.record)) return
    yield* runtime.driver.drain(entry.record).pipe(Effect.orDie)
    yield* Semaphore.withPermit(runtime.mutex)(finish(runtime, entry, { status: "interrupted", output: "", reason: "Plugin scope closed" }))
  })), Effect.catch((error) => Effect.gen(function* () {
    // An uncertain drain cannot release admission or claim a terminal session.
    const drained = yield* Effect.result(runtime.driver.drain(entry.record))
    if (drained._tag === "Failure") {
      yield* saveRecord(runtime, { ...entry.record, status: "cancelling", reason: error instanceof Error ? error.message : String(error) })
      yield* Deferred.fail(entry.done, drained.failure)
      return
    }
    yield* Semaphore.withPermit(runtime.mutex)(finish(runtime, entry, { status: "failed", output: "", reason: error instanceof Error ? error.message : String(error) }))
  })))
})
