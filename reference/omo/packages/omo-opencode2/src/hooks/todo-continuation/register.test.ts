import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { registerTodoContinuationEffect } from "./register"

const context = {
  tool: { transform: () => Effect.void },
  session: { get: () => Effect.die("unexpected session read"), synthetic: () => Effect.die("unexpected dispatch") },
  event: { subscribe: () => Stream.never },
}

describe("native todo continuation registration", () => {
  test("#given disabled todo continuation #when registered #then it returns without starting work", async () => {
    // given / when
    const registration = await Effect.runPromise(Effect.scoped(registerTodoContinuationEffect(context, {
      enabled: false,
      getTodos: () => [],
      gate: createSessionDispatchGate(),
    })))
    // then
    expect(registration.dispose).toBeTypeOf("function")
  })
})
