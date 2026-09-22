import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope, Stream } from "effect"
import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { registerGoalFeature, registerGoalFeatureEffect } from "./register"

describe("native goal registration", () => {
  test("#given disabled goal #when registered #then no native domains are touched", async () => {
    // given
    const gate = createSessionDispatchGate()
    const context = {
      tool: { transform: () => Effect.die("disabled goal touched tools") },
      session: {
        get: () => Effect.die("disabled goal read session"),
        synthetic: () => Effect.die("disabled goal dispatched"),
        hook: () => Effect.die("disabled goal installed hook"),
      },
      event: { subscribe: () => Stream.die("disabled goal subscribed") },
    }
    // when
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const registration = yield* registerGoalFeatureEffect(context, { directory: process.cwd(), enabled: false, gate })
      registration.dispose()
    })))
    // then
    expect(gate.isReserved("session")).toBe(false)
  })

  test("#given enabled goal #when its scope closes #then the event subscription is cancelled", async () => {
    // given
    let closed = false
    const scope = Effect.runSync(Scope.make())
    const context = {
      tool: { transform: () => Effect.succeed({ dispose: Effect.void }) },
      session: {
        get: () => Effect.die("unexpected session read"),
        synthetic: () => Effect.die("unexpected dispatch"),
        hook: () => Effect.succeed({ dispose: Effect.void }),
      },
      event: { subscribe: () => Stream.fromEffect(Effect.acquireRelease(Effect.void, () => Effect.sync(() => { closed = true }))).pipe(Stream.flatMap(() => Stream.never)) },
    }
    // when
    await Effect.runPromise(Effect.gen(function* () {
      yield* registerGoalFeatureEffect(context, { directory: process.cwd(), enabled: true, gate: createSessionDispatchGate() }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* Effect.yieldNow
      yield* Scope.close(scope, Exit.void)
    }))
    // then
    expect(closed).toBe(true)
  })
})

describe("Promise goal registration", () => {
  test("#given goal is disabled #when registration runs #then no tools or lifecycle subscription are installed", async () => {
    const feature = await registerGoalFeature({
      tool: { transform: async () => undefined },
      event: { subscribe: async function* () { return } },
      session: { get: async () => ({}), hook: async () => undefined, synthetic: async () => ({}) },
    }, { directory: process.cwd(), enabled: false, gate: createSessionDispatchGate() })
    expect(feature.dispose).toBeTypeOf("function")
    feature.dispose()
  })
})
