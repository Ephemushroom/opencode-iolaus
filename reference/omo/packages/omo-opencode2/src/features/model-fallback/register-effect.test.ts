import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { registerConfiguredModelFallbackEffect } from "./register"

test.each([
  { options: { model_fallback: { enabled: false } }, expected: 0 },
  { options: { model_fallback: { enabled: true }, disabled_hooks: ["model_fallback"] }, expected: 0 },
  { options: { model_fallback: { enabled: true, max_retries: 2 } }, expected: 1 },
])("#given native config %j #when its scope closes #then enabled hooks and subscriptions are scoped", async ({ options, expected }) => {
  // given
  let hooks = 0
  let subscriptions = 0
  let closed = 0
  const unexpected = () => Effect.die("unexpected host operation")
  const ctx: Pick<Context, "options" | "session" | "event"> = {
    options,
    session: {
      create: unexpected, get: unexpected, switchAgent: unexpected, switchModel: unexpected,
      prompt: unexpected, generate: unexpected, command: unexpected, interrupt: unexpected,
      rename: unexpected, move: unexpected, wait: unexpected, context: unexpected, synthetic: unexpected,
      hook: () => Effect.sync(() => { hooks++; return { dispose: Effect.void } }),
    },
    event: { subscribe: () => Stream.fromEffect(Effect.sync(() => { subscriptions++ }))
      .pipe(Stream.flatMap(() => Stream.never), Stream.ensuring(Effect.sync(() => { closed++ }))) },
  }
  // when
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* registerConfiguredModelFallbackEffect(ctx, {
      directory: process.cwd(), gate: createSessionDispatchGate(), executor: { managed: () => Effect.succeed(undefined) },
    })
    yield* Effect.yieldNow
  })))
  // then
  expect(hooks).toBe(expected)
  expect(subscriptions).toBe(expected)
  expect(closed).toBe(expected)
})
