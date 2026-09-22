import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Deferred, Effect, Queue, Schema } from "effect"
import { caller, fixture, node } from "./fixture"
import { createWorkflow } from "./runtime"
import { WorkflowRecord } from "./types"

test("#given an unknown target #when starting a graph #then reject before submitting any node", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const result = yield* Effect.result(f.workflow.start({ key: "invalid-target", nodes: [node("a"), { ...node("b"), agent: Agent.ID.make("missing") }] }, caller))
    expect(result._tag).toBe("Failure")
    expect(yield* f.executor.list()).toEqual([])
  })))
})

test("#given a managed node session #when it starts another graph #then reject nested coordination", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    yield* f.workflow.start({ key: "parent", nodes: [node("a")] }, caller)
    const [parent] = yield* f.executor.list()
    if (!parent) throw new Error("missing parent execution")
    const result = yield* Effect.result(f.workflow.start({ key: "nested", nodes: [node("b")] }, parent.sessionID))
    expect(result._tag).toBe("Failure")
    expect(yield* f.executor.list()).toHaveLength(1)
  })))
})

test("#given a failed generation #when retry requests race or repeat #then deduplicate its key and reject stale generations", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const started = yield* f.workflow.start({ key: "retry-key", nodes: [node("a")] }, caller)
    const first = yield* Queue.take(f.started)
    yield* Deferred.succeed(first.finish, { status: "failed", output: "", reason: "retry me" })
    yield* f.workflow.wait(started.id, caller)
    const retry = { expectedGeneration: 1, key: "retry-request" }
    const next = yield* f.workflow.retry(started.id, caller, retry)
    const duplicate = yield* f.workflow.retry(started.id, caller, retry)
    expect(duplicate.generation).toBe(next.generation)
    expect((yield* Effect.result(f.workflow.retry(started.id, caller, { ...retry, key: "stale" })))._tag).toBe("Failure")
    const second = yield* Queue.take(f.started)
    yield* Deferred.succeed(second.finish, { status: "completed", output: "recovered" })
    yield* f.workflow.wait(started.id, caller)
    expect(f.launches).toEqual(["a", "a"])
  })).pipe(Effect.timeout("2 seconds")))
})

test("#given a saved graph whose execution was interrupted #when reopening #then preserve history and permit only explicit retry", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const started = yield* f.workflow.start({ key: "restart", nodes: [node("a")] }, caller)
    yield* Queue.take(f.started)
    yield* f.workflow.cancel(started.id, caller)
    yield* f.workflow.wait(started.id, caller)
    f.values.set("workflow/" + started.id, Schema.encodeSync(WorkflowRecord)(started))
    const reopened = yield* createWorkflow(f.options)
    expect((yield* reopened.snapshot(started.id, caller)).status).toBe("failed")
    expect(f.launches).toEqual(["a"])
    yield* reopened.retry(started.id, caller, { expectedGeneration: 1, key: "restart-retry" })
    const retry = yield* Queue.take(f.started)
    yield* Deferred.succeed(retry.finish, { status: "completed", output: "done" })
    expect((yield* reopened.wait(started.id, caller)).status).toBe("completed")
  })).pipe(Effect.timeout("2 seconds")))
})
