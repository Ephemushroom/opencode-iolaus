import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Deferred, Effect, Schema } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { createExecutionNotifications } from "./notifications"
import { ExecutionError } from "./errors"
import { TaskID, type ExecutionRecord } from "./types"

const caller = Session.ID.create()
const record = (generation: number, status: ExecutionRecord["status"] = "completed"): ExecutionRecord => ({
  version: 1, ref: { taskID: TaskID.make("task"), generation },
  owner: { kind: "task", callerSessionID: caller, rootSessionID: caller }, writer: "test",
  sessionID: Session.ID.create(), inputID: SessionMessage.ID.create(), agent: Agent.ID.make("agent"),
  model: Model.Ref.parse("provider/model"), description: "test", status, output: `output-${generation}`,
  background: true, createdAt: 1,
})

const run = (effect: Effect.Effect<void, unknown>) => Effect.runPromise(effect)

function storageFixture() {
  const values = new Map<string, Schema.Json>()
  const storage: Context["storage"] = {
    get: (key) => Effect.succeed(values.get(key)),
    set: (key, value) => Effect.sync(() => { values.set(key, value) }),
    remove: (key) => Effect.sync(() => { values.delete(key) }),
    scan: ({ prefix }) => Effect.succeed({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
  }
  return { values, storage }
}

test("#given a background terminal record #when enqueue runs #then dispatch happens outside enqueue and only once", async () => {
  const fixture = storageFixture()
  const dispatched: string[] = []
  await run(Effect.scoped(Effect.gen(function* () {
    const outbox = yield* createExecutionNotifications({ storage: fixture.storage, prefix: "notifications/", dispatch: (message) => Effect.sync(() => { dispatched.push(message.text) }) })
    yield* outbox.enqueue(record(1))
    expect(dispatched).toEqual([])
    yield* Effect.sleep("10 millis")
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toContain("output-1")
    yield* outbox.enqueue(record(1))
    yield* Effect.sleep("10 millis")
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toContain("output-1")
  })))
})

test("#given repeated generations #when enqueue runs #then each generation has a distinct durable message ID", async () => {
  const fixture = storageFixture()
  const ids: string[] = []
  await run(Effect.scoped(Effect.gen(function* () {
    const outbox = yield* createExecutionNotifications({ storage: fixture.storage, prefix: "notifications/", dispatch: (message) => Effect.sync(() => { ids.push(message.messageID) }) })
    yield* outbox.enqueue(record(1))
    yield* outbox.enqueue(record(2))
    yield* Effect.sleep("10 millis")
  })))
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])
})

test("#given a failed delivery #when the outbox is reopened #then the same message ID is replayed", async () => {
  const fixture = storageFixture()
  const ids: string[] = []
  let attempts = 0
  await run(Effect.scoped(Effect.gen(function* () {
    const outbox = yield* createExecutionNotifications({ storage: fixture.storage, prefix: "notifications/", dispatch: (message) => Effect.gen(function* () {
      ids.push(message.messageID)
      attempts += 1
      if (attempts === 1) yield* Effect.fail(new ExecutionError({ code: "host", message: "delivery failed" }))
    }) })
    yield* outbox.enqueue(record(1))
    yield* Effect.sleep("10 millis")
  })))
  await run(Effect.scoped(Effect.gen(function* () {
    yield* createExecutionNotifications({ storage: fixture.storage, prefix: "notifications/", dispatch: (message) => Effect.sync(() => { ids.push(message.messageID) }) })
    yield* Effect.sleep("10 millis")
  })))
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe(ids[1])
})

test("#given a closed scope #when enqueue runs #then it rejects and foreground records never wake", async () => {
  const fixture = storageFixture()
  const outbox = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const outbox = yield* createExecutionNotifications({ storage: fixture.storage, prefix: "notifications/", dispatch: () => Effect.die("unexpected") })
    yield* outbox.enqueue({ ...record(1), background: false })
    return outbox
  })))
  expect(fixture.values.size).toBe(0)
  await expect(run(outbox.enqueue(record(1)))).rejects.toBeDefined()
})

test("#given a defective delivery #when another completion arrives #then keep the first pending and continue processing the queue", async () => {
  const fixture = storageFixture()
  await run(Effect.scoped(Effect.gen(function* () {
    const second = yield* Deferred.make<void>()
    const outbox = yield* createExecutionNotifications({ storage: fixture.storage, prefix: "notifications/",
      dispatch: (message) => message.metadata.omo_execution_run === "task/1"
        ? Effect.die(new Error("host transport defect"))
        : Deferred.succeed(second, undefined).pipe(Effect.asVoid) })
    yield* outbox.enqueue(record(1))
    yield* outbox.enqueue(record(2))
    yield* Deferred.await(second).pipe(Effect.timeout("1 second"))
    expect(fixture.values.get("notifications/task/1")).toMatchObject({ status: "pending" })
  })))
})

test("#given multiple storage pages #when recovering notifications #then deliver pending entries beyond the first page", async () => {
  const fixture = storageFixture()
  const entries = [1, 2].map((generation) => ({ key: `notifications/task/${generation}`, value: {
    version: 1, runKey: `task/${generation}`, messageID: SessionMessage.ID.create(), callerSessionID: caller,
    text: `page-${generation}`, metadata: {}, status: generation === 1 ? "delivered" : "pending",
  } }))
  const scans: (string | undefined)[] = []
  await run(Effect.scoped(Effect.gen(function* () {
    const delivered = yield* Deferred.make<string>()
    const storage: Context["storage"] = { ...fixture.storage,
      get: (key) => Effect.succeed(entries.find((entry) => entry.key === key)?.value),
      scan: ({ after }) => Effect.sync(() => {
        scans.push(after)
        return after ? { entries: entries.slice(1) } : { entries: entries.slice(0, 1), next: entries[0]?.key }
      }),
    }
    yield* createExecutionNotifications({ storage, prefix: "notifications/",
      dispatch: (message) => Deferred.succeed(delivered, message.text).pipe(Effect.asVoid) })
    expect(yield* Deferred.await(delivered).pipe(Effect.timeout("1 second"))).toBe("page-2")
  })))
  expect(scans).toEqual([undefined, "notifications/task/1"])
})
