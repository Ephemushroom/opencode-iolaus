import { Effect, Schema } from "effect"
import { ExecutionError } from "./errors"
import type { ExecutionRuntime } from "./runtime"
import { ExecutionRecord, runKey, type RunRef } from "./types"

export const saveRecord = Effect.fn("execution.saveRecord")(function* (
  runtime: ExecutionRuntime,
  record: ExecutionRecord,
) {
  yield* runtime.storage.set(runtime.prefix + runKey(record.ref), Schema.encodeSync(ExecutionRecord)(record))
  runtime.records.set(runKey(record.ref), record)
  const entry = runtime.entries.get(runKey(record.ref))
  if (entry) entry.record = record
})

export const readRecord = Effect.fn("execution.readRecord")(function* (runtime: ExecutionRuntime, ref: RunRef) {
  const record = runtime.records.get(runKey(ref))
  if (!record) return yield* new ExecutionError({ code: "not-found", message: `Unknown execution ${runKey(ref)}` })
  return record
})

export const loadRecords = Effect.fn("execution.loadRecords")(function* (runtime: ExecutionRuntime) {
  const records: ExecutionRecord[] = []
  let after: string | undefined
  for (;;) {
    const page = yield* runtime.storage.scan({ prefix: runtime.prefix, ...(after ? { after } : {}) })
    for (const entry of page.entries) {
      const decoded = yield* Schema.decodeUnknownEffect(ExecutionRecord)(entry.value).pipe(
        Effect.mapError(() => new ExecutionError({ code: "storage", message: `Invalid execution record ${entry.key}` })),
      )
      records.push(decoded)
    }
    if (!page.next || page.entries.length === 0) return records
    after = page.next
  }
})
