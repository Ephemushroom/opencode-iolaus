import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Deferred, Effect, Fiber } from "effect"
import { createExecutor } from "./executor"
import { runForeground } from "./foreground"

test.each(["timeout", "interrupt"] as const)("#given held foreground execution #when %s ends observation #then cancel and drain before returning", async (mode) => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let drains = 0
    const executor = yield* createExecutor({ prefix: "runs/", writer: "test",
      storage: { get: () => Effect.succeed(undefined), set: () => Effect.void, remove: () => Effect.void,
        scan: () => Effect.succeed({ entries: [] }) },
      driver: {
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        drain: () => Effect.sync(() => { drains++ }),
      },
    })
    const caller = Session.ID.create()
    const running = yield* Effect.forkChild(runForeground(executor, { kind: "fresh",
      owner: { kind: "task", callerSessionID: caller, rootSessionID: caller },
      agent: Agent.ID.make("explore"), model: Model.Ref.parse("provider/model"), text: "held",
      description: "held", background: false }, mode === "timeout" ? 20 : 60000))
    yield* Deferred.await(started)
    if (mode === "interrupt") yield* Fiber.interrupt(running)
    else yield* Fiber.join(running).pipe(Effect.exit)
    expect(drains).toBe(1)
    expect((yield* executor.list()).map((record) => record.status)).toEqual(["cancelled"])
  })).pipe(Effect.timeout("3 seconds")))
})
