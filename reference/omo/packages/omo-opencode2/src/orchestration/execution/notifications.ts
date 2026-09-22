import type { Context } from "@opencode/plugin/effect/plugin"
import { SessionMessage } from "@opencode/schema/session-message"
import { Cause, Effect, Queue, Schema, Semaphore } from "effect"
import { ExecutionError } from "./errors"
import { runKey, type ExecutionRecord } from "./types"

const Notification = Schema.Struct({
  version: Schema.Literal(1),
  runKey: Schema.String,
  messageID: SessionMessage.ID,
  callerSessionID: Schema.String,
  text: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Json),
  status: Schema.Literals(["pending", "delivered"]),
})
type Notification = typeof Notification.Type

export type ExecutionNotification = {
  readonly messageID: SessionMessage.ID
  readonly callerSessionID: string
  readonly text: string
  readonly metadata: Readonly<Record<string, Schema.Json>>
}

export type ExecutionNotifications = {
  readonly enqueue: (record: ExecutionRecord) => Effect.Effect<void, ExecutionError>
}

type NotificationOptions = {
  readonly storage: Context["storage"]
  readonly prefix: string
  readonly dispatch: (notification: ExecutionNotification) => Effect.Effect<void, ExecutionError>
}

function key(prefix: string, run: string): string {
  return `${prefix}${run}`
}

function notificationFor(record: ExecutionRecord): Notification {
  return {
    version: 1,
    runKey: runKey(record.ref),
    messageID: SessionMessage.ID.create(),
    callerSessionID: record.owner.callerSessionID,
    text: [`Background task ${record.ref.taskID} (${record.description}): ${record.status}`,
      record.reason, record.output].filter((value) => value !== undefined && value.length > 0).join("\n\n"),
    metadata: { omo_execution_run: runKey(record.ref), omo_execution_status: record.status },
    status: "pending",
  }
}

export const createExecutionNotifications = Effect.fn("execution.createNotifications")(function* (
  options: NotificationOptions,
){
  const lock = yield* Semaphore.make(1)
  const queue = yield* Queue.unbounded<string>()
  let closed = false

  const persist = (notification: Notification) =>
    options.storage.set(key(options.prefix, notification.runKey), Schema.encodeSync(Notification)(notification))

  const read = (run: string) =>
    options.storage.get(key(options.prefix, run)).pipe(
      Effect.flatMap((value) => value === undefined
        ? Effect.succeed<Notification | undefined>(undefined)
        : Schema.decodeUnknownEffect(Notification)(value).pipe(
            Effect.mapError(() => new ExecutionError({ code: "storage", message: `Invalid notification ${run}` })),
          )),
    )

  const deliver = (run: string) => Effect.gen(function* () {
    const notification = yield* read(run)
    if (!notification || notification.status === "delivered") return
    yield* options.dispatch(notification)
    yield* lock.withPermits(1)(persist({ ...notification, status: "delivered" }))
  }).pipe(Effect.catchCause((cause) => Effect.logError("execution notification delivery failed", Cause.pretty(cause))))

  yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
    const run = yield* Queue.take(queue)
    if (!closed) yield* deliver(run)
  })))

  let after: string | undefined
  for (;;) {
    const page = yield* options.storage.scan({ prefix: options.prefix, ...(after ? { after } : {}) })
    for (const entry of page.entries) {
      const notification = yield* Schema.decodeUnknownEffect(Notification)(entry.value).pipe(
        Effect.mapError(() => new ExecutionError({ code: "storage", message: `Invalid notification ${entry.key}` })),
      )
      if (notification.status === "pending") yield* Queue.offer(queue, notification.runKey)
    }
    if (!page.next || page.entries.length === 0) break
    after = page.next
  }

  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    closed = true
    yield* Queue.shutdown(queue)
  }))

  return {
    enqueue: (record: ExecutionRecord) => Effect.gen(function* () {
      if (closed) return yield* new ExecutionError({ code: "owner-closed", message: "Notification outbox is closed" })
      if (!record.background || (record.status !== "completed" && record.status !== "failed")) return
      yield* lock.withPermits(1)(Effect.gen(function* () {
        const existing = yield* read(runKey(record.ref))
        if (existing) {
          if (existing.status === "pending") yield* Queue.offer(queue, existing.runKey)
          return
        }
        const notification = notificationFor(record)
        yield* persist(notification)
        yield* Queue.offer(queue, notification.runKey)
      }))
    }),
  }
})
