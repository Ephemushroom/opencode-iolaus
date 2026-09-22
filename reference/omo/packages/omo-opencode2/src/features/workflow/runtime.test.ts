import { expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Deferred, Effect, Queue, Schema } from "effect"
import { caller, fixture, node } from "./fixture"
import { WorkflowRecord } from "./types"
import { createWorkflow } from "./runtime"

test("#given held roots #when starting #then persist and return before completion across the caller scope", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const accepted = yield* Effect.scoped(f.workflow.start({ key: "accept", nodes: [node("a")] }, caller))
    expect(accepted.status).toBe("running")
    const stored = Schema.decodeUnknownSync(WorkflowRecord)(f.values.get("workflow/" + accepted.id))
    expect(stored.nodes[0]?.state.status).toBe("running")
    const active = yield* Queue.take(f.started)
    yield* Deferred.succeed(active.finish, { status: "completed", output: "answer" })
    expect((yield* f.workflow.wait(accepted.id, caller)).status).toBe("completed")
  })).pipe(Effect.timeout("2 seconds")))
})

test("#given independent roots #when one finishes #then admit its dependent before the other root finishes", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const accepted = yield* f.workflow.start({ key: "frontier", nodes: [node("a"), node("b"), node("c", ["a"])] }, caller)
    const a = yield* Queue.take(f.started)
    const b = yield* Queue.take(f.started)
    yield* Deferred.succeed(a.finish, { status: "completed", output: "a-result" })
    const c = yield* Queue.take(f.started)
    expect(c.id).toBe("c")
    expect(c.text).toBe("c")
    expect((yield* f.workflow.snapshot(accepted.id, caller)).nodes.find((entry) => entry.definition.id === b.id)?.state.status).toBe("running")
    yield* Deferred.succeed(b.finish, { status: "completed", output: "b-result" })
    yield* Deferred.succeed(c.finish, { status: "completed", output: "c-result" })
    expect((yield* f.workflow.wait(accepted.id, caller)).status).toBe("completed")
  })).pipe(Effect.timeout("2 seconds")))
})

test("#given concurrent same-key starts #when submitting #then dedupe within caller and reject changed input", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const input = { key: "dedupe", nodes: [node("a")] }
    const [first, second] = yield* Effect.all([f.workflow.start(input, caller), f.workflow.start(input, caller)], { concurrency: "unbounded" })
    expect(first.id).toBe(second.id)
    const conflict = yield* Effect.result(f.workflow.start({ ...input, nodes: [node("different")] }, caller))
    expect(conflict._tag).toBe("Failure")
    if (conflict._tag === "Failure") expect(conflict.failure.code).toBe("conflict")
    const other = yield* f.workflow.start(input, Session.ID.create())
    expect(other.id).not.toBe(first.id)
    expect((yield* f.executor.list()).length).toBe(2)
  })).pipe(Effect.timeout("2 seconds")))
})

test("#given an owned workflow #when a different caller reads or mutates #then refuse every action", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const accepted = yield* f.workflow.start({ key: "owner", nodes: [node("a")] }, caller)
    const other = Session.ID.create()
    for (const action of [f.workflow.snapshot, f.workflow.wait, f.workflow.cancel,
      (id: typeof accepted.id, sessionID: Session.ID) => f.workflow.retry(id, sessionID, { expectedGeneration: 1, key: "foreign" })]) {
      const result = yield* Effect.result(action(accepted.id, other))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe("forbidden")
    }
  })).pipe(Effect.timeout("2 seconds")))
})

test("#given a completed stored workflow #when recreating its runtime #then read terminal output and dedupe without dispatch", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const input = { key: "stored", nodes: [node("a")] }
    const accepted = yield* f.workflow.start(input, caller)
    const a = yield* Queue.take(f.started)
    yield* Deferred.succeed(a.finish, { status: "completed", output: "durable" })
    const completed = yield* f.workflow.wait(accepted.id, caller)
    const reopened = yield* createWorkflow(f.options)
    expect(yield* reopened.wait(accepted.id, caller)).toEqual(completed)
    expect(yield* reopened.start(input, caller)).toEqual(completed)
    expect(f.launches).toEqual(["a"])
  })).pipe(Effect.timeout("2 seconds")))
})
