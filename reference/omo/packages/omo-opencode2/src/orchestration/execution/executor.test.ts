import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Deferred, Effect, Fiber, Queue, Schema } from "effect"
import { createExecutor } from "./executor"
import type { ExecutionDriver } from "./runtime"
import { runKey, type RunRef, type SubmitRequest } from "./types"

const caller = Session.ID.create()
const request: SubmitRequest = {
  kind: "fresh", owner: { kind: "task", callerSessionID: caller, rootSessionID: caller },
  agent: Agent.ID.make("explore"), model: Model.Ref.parse("provider/model"),
  text: "work", description: "fixture", background: true,
}

const fixture = Effect.gen(function* () {
  const started = yield* Queue.unbounded<RunRef>()
  const release = yield* Deferred.make<void>()
  const draining = yield* Deferred.make<void>()
  const drained = yield* Deferred.make<void>()
  const launches: string[] = []
  const values = new Map<string, Schema.Json>()
  const driver: ExecutionDriver = {
    run: (record) => Effect.gen(function* () {
      launches.push(runKey(record.ref))
      yield* Queue.offer(started, record.ref)
      yield* Deferred.await(release)
      return { status: "completed", output: "actual-output" }
    }),
    drain: () => Effect.gen(function* () {
      yield* Deferred.succeed(draining, undefined)
      yield* Deferred.await(drained)
    }),
  }
  const executor = yield* createExecutor({
    driver, prefix: "test/", writer: "test-writer", limits: { model: 1, team: 1 },
    storage: {
      get: (key) => Effect.sync(() => values.get(key)),
      set: (key, value) => Effect.sync(() => { values.set(key, value) }),
      remove: (key) => Effect.sync(() => { values.delete(key) }),
      scan: () => Effect.succeed({ entries: [] }),
    },
  })
  yield* Effect.addFinalizer(() => Deferred.succeed(drained, undefined))
  return { executor, launches, values, release, started, draining, drained }
})

test("#given held execution #when submitting background work #then acceptance precedes completion and survives the caller scope", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const ref = yield* Effect.scoped(f.executor.submit(request))
    expect(f.values.size).toBe(1)
    yield* Queue.take(f.started)
    expect((yield* f.executor.snapshot(ref)).status).toBe("running")
    yield* Deferred.succeed(f.release, undefined)
    expect((yield* f.executor.wait(ref)).output).toBe("actual-output")
  })))
})

test("#given full model capacity #when queued work is cancelled #then it cannot launch after release", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const active = yield* f.executor.submit(request)
    yield* Queue.take(f.started)
    const queued = yield* f.executor.submit(request)
    yield* f.executor.cancel(queued)
    yield* Deferred.succeed(f.release, undefined)
    yield* f.executor.wait(active)
    expect((yield* f.executor.wait(queued)).status).toBe("cancelled")
    expect(f.launches).toEqual([runKey(active)])
  })))
})

test("#given an active cancellation #when interrupt is acknowledged but drain is held #then queued work retains its place without launching", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const active = yield* f.executor.submit(request)
    yield* Queue.take(f.started)
    const queued = yield* f.executor.submit(request)
    yield* f.executor.cancel(active)
    yield* Deferred.await(f.draining)
    expect((yield* f.executor.snapshot(active)).status).toBe("cancelling")
    expect((yield* f.executor.snapshot(queued)).status).toBe("queued")
    yield* Deferred.succeed(f.drained, undefined)
    expect((yield* f.executor.wait(active)).status).toBe("cancelled")
    yield* Queue.take(f.started)
    yield* Deferred.succeed(f.release, undefined)
    yield* f.executor.wait(queued)
  })))
})

test("#given a finished task #when a continuation finishes #then the original generation remains unchanged", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* f.executor.submit(request)
    yield* Deferred.succeed(f.release, undefined)
    const before = yield* f.executor.wait(first)
    const next = yield* f.executor.submit({ ...request, kind: "continuation", previous: first })
    yield* f.executor.wait(next).pipe(Effect.timeout("1 second"))
    expect(next.generation).toBe(first.generation + 1)
    expect(next.taskID).toBe(first.taskID)
    expect(yield* f.executor.snapshot(first)).toEqual(before)
  })))
})

test("#given an active owner #when graceful stop starts #then new submissions fail while the current turn drains", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    yield* f.executor.submit(request)
    yield* Queue.take(f.started)
    const stopping = yield* Effect.forkChild(f.executor.stopOwner(request.owner, "graceful"), { startImmediately: true })
    const result = yield* Effect.result(f.executor.submit(request))
    expect(result._tag).toBe("Failure")
    yield* Deferred.succeed(f.release, undefined)
    yield* Fiber.join(stopping)
  })))
})

test("#given an active member turn #when two messages arrive #then queue separate generations and never overlap the session", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const sessionID = Session.ID.create()
    const initial = yield* f.executor.submit({ ...request, kind: "fresh", agent: Agent.ID.make("explore"), model: Model.Ref.parse("provider/model"), sessionID })
    yield* Queue.take(f.started)
    const first = yield* f.executor.submit({ ...request, kind: "message", previous: initial, text: "message-one" })
    const second = yield* f.executor.submit({ ...request, kind: "message", previous: initial, text: "message-two" })
    expect(first.generation).toBe(2)
    expect(second.generation).toBe(3)
    expect((yield* f.executor.snapshot(initial)).sessionID).toBe(sessionID)
    expect((yield* f.executor.snapshot(first)).status).toBe("queued")
    expect((yield* f.executor.snapshot(second)).status).toBe("queued")
    expect(f.launches).toEqual([runKey(initial)])
    yield* Deferred.succeed(f.release, undefined)
    yield* f.executor.wait(second)
    expect(f.launches).toEqual([runKey(initial), runKey(first), runKey(second)])
  })).pipe(Effect.timeout("3 seconds")))
})

test("#given a queued notification #when its durable input is replayed #then retain one generation and one execution", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const initial = yield* f.executor.submit(request)
    yield* Queue.take(f.started)
    const message = { ...request, kind: "message" as const, previous: initial,
      inputID: SessionMessage.ID.create(), text: "completion notification" }
    const first = yield* f.executor.submit(message)
    const replay = yield* f.executor.submit(message)
    expect(replay).toEqual(first)
    yield* Deferred.succeed(f.release, undefined)
    yield* f.executor.wait(first)
    expect(f.launches).toEqual([runKey(initial), runKey(first)])
  })).pipe(Effect.timeout("3 seconds")))
})

test("#given a member approving its own shutdown #when admission closes #then return without waiting for its active turn and cancel queued turns", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const active = yield* f.executor.submit(request)
    yield* Queue.take(f.started)
    const queued = yield* f.executor.submit(request)
    yield* f.executor.closeOwner(request.owner)
    expect((yield* f.executor.snapshot(active)).status).toBe("running")
    expect((yield* f.executor.wait(queued)).status).toBe("cancelled")
    expect((yield* Effect.result(f.executor.submit(request)))._tag).toBe("Failure")
    yield* Deferred.succeed(f.release, undefined)
    expect((yield* f.executor.wait(active)).status).toBe("completed")
  })).pipe(Effect.timeout("3 seconds")))
})
