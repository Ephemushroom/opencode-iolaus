import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Queue } from "effect"
import { caller, fixture, node } from "./fixture"
import { createWorkflow } from "./runtime"

test("#given a failed branch #when waiting #then block its descendants but finish independent work", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const accepted = yield* f.workflow.start({ key: "failed", nodes: [node("a"), node("b"), node("c", ["a"]), node("d", ["c"])] }, caller)
    const a = yield* Queue.take(f.started)
    const b = yield* Queue.take(f.started)
    yield* Deferred.succeed(a.finish, { status: "failed", output: "", reason: "test failure" })
    yield* Deferred.succeed(b.finish, { status: "completed", output: "kept" })
    const result = yield* f.workflow.wait(accepted.id, caller)
    expect(result.status).toBe("failed")
    expect(result.nodes.map((entry) => entry.state.status)).toEqual(["failed", "completed", "blocked", "blocked"])
    expect(f.launches).toEqual(["a", "b"])
  })).pipe(Effect.timeout("2 seconds")))
})

test("#given full capacity and a waiter #when cancelling #then drain active work and never launch queued or dependent nodes", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const accepted = yield* f.workflow.start({ key: "cancel", nodes: [node("a"), node("b"), node("c"), node("d", ["a"])] }, caller)
    yield* Queue.take(f.started)
    yield* Queue.take(f.started)
    const waiter = yield* Effect.forkChild(f.workflow.wait(accepted.id, caller))
    yield* f.workflow.cancel(accepted.id, caller)
    const result = yield* Fiber.join(waiter)
    expect(result.status).toBe("cancelled")
    expect(f.launches).toEqual(["a", "b"])
    expect(result.nodes.every((entry) => entry.state.status === "cancelled")).toBe(true)
  })).pipe(Effect.timeout("2 seconds")))
})

test("#given a failed workflow #when retrying #then retain successful output and execute unsuccessful nodes once", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const accepted = yield* f.workflow.start({ key: "retry", nodes: [node("a"), node("b"), node("c", ["b"])] }, caller)
    const a = yield* Queue.take(f.started)
    const b = yield* Queue.take(f.started)
    yield* Deferred.succeed(a.finish, { status: "completed", output: "retained" })
    yield* Deferred.succeed(b.finish, { status: "failed", output: "", reason: "once" })
    const failed = yield* f.workflow.wait(accepted.id, caller)
    const retried = yield* f.workflow.retry(accepted.id, caller, { expectedGeneration: 1, key: "retry-1" })
    expect(retried.generation).toBe(2)
    expect(retried.nodes[0]).toEqual(failed.nodes[0])
    const duplicate = yield* Effect.result(f.workflow.retry(accepted.id, caller, { expectedGeneration: 1, key: "retry-2" }))
    expect(duplicate._tag).toBe("Failure")
    const nextB = yield* Queue.take(f.started)
    expect(nextB.id).toBe("b")
    yield* Deferred.succeed(nextB.finish, { status: "completed", output: "retried" })
    const c = yield* Queue.take(f.started)
    yield* Deferred.succeed(c.finish, { status: "completed", output: "done" })
    expect((yield* f.workflow.wait(accepted.id, caller)).status).toBe("completed")
    expect(f.launches).toEqual(["a", "b", "b", "c"])
  })).pipe(Effect.timeout("2 seconds")))
})

test("#given a running workflow #when the owning scope closes #then cancel children and persist the terminal workflow", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const accepted = yield* Effect.scoped(Effect.gen(function* () {
      const nested = yield* createWorkflow({ ...f.options, prefix: "nested/" })
      const record = yield* nested.start({ key: "close", nodes: [node("a"), node("b", ["a"])] }, caller)
      yield* Queue.take(f.started)
      return record
    }))
    const stored = yield* f.options.storage.get("nested/" + accepted.id)
    expect(stored).toMatchObject({ status: "cancelled" })
    expect(f.launches).toEqual(["a"])
  })).pipe(Effect.timeout("2 seconds")))
})
