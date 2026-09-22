import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Deferred, Effect, Queue, type Schema } from "effect"
import { createExecutor } from "../orchestration/execution/executor"
import { createExecutionDelivery } from "./execution-delivery"
import { createExecutionNotifications } from "../orchestration/execution/notifications"
import type { Executor } from "../orchestration/execution/types"

test("#given a busy managed caller #when notification delivery is replayed #then queue one budgeted turn without a direct host write", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const values = new Map<string, Schema.Json>()
    const release = yield* Deferred.make<void>()
    const started = yield* Queue.unbounded<string>()
    const launches: string[] = []
    const executor = yield* createExecutor({ prefix: "runs/", writer: "test", limits: { model: 1, team: 1 },
      storage: {
        get: (key) => Effect.sync(() => values.get(key)),
        set: (key, value) => Effect.sync(() => { values.set(key, value) }),
        remove: (key) => Effect.sync(() => { values.delete(key) }),
        scan: () => Effect.succeed({ entries: [] }),
      },
      driver: {
        run: (record, request) => Effect.gen(function* () {
          launches.push(request.text)
          yield* Queue.offer(started, request.text)
          yield* Deferred.await(release)
          return { status: "completed", output: record.description }
        }),
        drain: () => Effect.void,
      },
    })
    const root = Session.ID.create()
    const sessionID = Session.ID.create()
    const ref = yield* executor.submit({ kind: "fresh", sessionID,
      owner: { kind: "task", callerSessionID: root, rootSessionID: root },
      agent: Agent.ID.make("explore"), model: Model.Ref.parse("provider/model"),
      text: "initial", description: "initial", background: false })
    yield* Queue.take(started)
    const delivery = createExecutionDelivery({ session: { synthetic: () => Effect.die("managed session bypassed executor") } }, Effect.succeed(executor))
    const input = { sessionID, text: "result", description: "child completion", id: SessionMessage.ID.create() }
    yield* delivery.dispatch(input)
    yield* delivery.dispatch(input)
    expect(launches).toEqual(["initial"])
    expect(yield* executor.list()).toHaveLength(2)
    yield* Deferred.succeed(release, undefined)
    const latest = yield* executor.latest(ref.taskID)
    if (!latest) throw new Error("missing managed notification")
    yield* executor.wait(latest.ref)
    expect(launches).toEqual(["initial", "result"])
    expect(latest.background).toBe(false)
    const rootDelivery = createExecutionDelivery({ session: {
      synthetic: (request) => Effect.sync(() => {
        expect(request.sessionID).toBe(root)
        expect(request.id).toBe(input.id)
        expect(request.delivery).toBe("queue")
      }).pipe(Effect.andThen(Effect.interrupt)),
    } }, Effect.succeed(executor))
    expect(yield* rootDelivery.managed({ ...input, sessionID: root })).toBe(false)
    yield* rootDelivery.dispatch({ ...input, sessionID: root }).pipe(Effect.exit)
  })).pipe(Effect.timeout("3 seconds")))
})

test("#given a held managed parent #when its background child completes #then the production outbox queues a parent turn without reentering the completion lock", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const values = new Map<string, Schema.Json>()
    const storage = {
      get: (key: string) => Effect.sync(() => values.get(key)),
      set: (key: string, value: Schema.Json) => Effect.sync(() => { values.set(key, value) }),
      remove: (key: string) => Effect.sync(() => { values.delete(key) }),
      scan: ({ prefix }: { prefix?: string }) => Effect.sync(() => ({ entries: [...values]
        .filter(([key]) => key.startsWith(prefix ?? "")).map(([key, value]) => ({ key, value })) })),
    }
    const ready = yield* Deferred.make<Executor>()
    const release = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const queued = yield* Deferred.make<void>()
    const delivery = createExecutionDelivery({ session: { synthetic: () => Effect.die("managed notification bypassed admission") } }, Deferred.await(ready))
    const outbox = yield* createExecutionNotifications({ storage, prefix: "notifications/",
      dispatch: (message) => delivery.dispatch({ sessionID: message.callerSessionID, id: message.messageID,
        text: message.text, metadata: message.metadata, description: "completion" })
        .pipe(Effect.andThen(Deferred.succeed(queued, undefined)), Effect.asVoid) })
    const executor = yield* createExecutor({ storage, prefix: "runs/", writer: "test", notify: outbox.enqueue,
      limits: { model: 2, team: 1 }, driver: {
        run: (_, request) => Effect.gen(function* () {
          if (request.text === "held parent") {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }
          return { status: "completed", output: "nested result" }
        }),
        drain: () => Effect.void,
      } })
    yield* Deferred.succeed(ready, executor)
    const root = Session.ID.create()
    const routing = { agent: Agent.ID.make("quick"), model: Model.Ref.parse("provider/model") }
    const parent = yield* executor.submit({ kind: "fresh", ...routing,
      owner: { kind: "task", callerSessionID: root, rootSessionID: root }, text: "held parent", description: "parent", background: false })
    yield* Deferred.await(started)
    const parentSessionID = (yield* executor.snapshot(parent)).sessionID
    const child = yield* executor.submit({ kind: "fresh", ...routing,
      owner: { kind: "task", callerSessionID: parentSessionID, rootSessionID: root }, text: "child", description: "child", background: true })
    expect((yield* executor.wait(child)).status).toBe("completed")
    yield* Deferred.await(queued)
    const next = yield* executor.managed(parentSessionID)
    if (!next) throw new Error("missing queued parent notification")
    expect(next.ref.generation).toBe(2)
    expect(next.status).toBe("queued")
    expect((yield* executor.snapshot(parent)).status).toBe("running")
    yield* Deferred.succeed(release, undefined)
    expect((yield* executor.wait(next.ref)).status).toBe("completed")
  })).pipe(Effect.timeout("3 seconds")))
})
