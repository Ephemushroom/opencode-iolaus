import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { registerBoulderContinuationEffect } from "./register"

const context = {
  tool: { transform: () => Effect.void },
  session: { get: () => Effect.die("unexpected session read"), synthetic: () => Effect.die("unexpected dispatch") },
  event: { subscribe: () => Stream.never },
}

describe("native boulder continuation registration", () => {
  test("#given disabled boulder continuation #when registered #then it returns without starting work", async () => {
    // given / when
    const registration = await Effect.runPromise(Effect.scoped(registerBoulderContinuationEffect(context, {
      enabled: false,
      directory: process.cwd(),
      gate: createSessionDispatchGate(),
    })))
    // then
    expect(registration.dispose).toBeTypeOf("function")
  })
})
