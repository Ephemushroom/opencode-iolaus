import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"

import type { IdleInjectorEvent, IdleInjectorTrace } from "../../orchestration/idle-injector"
import { createNativeIdlePorts, type NativeIdleDispatch } from "../../orchestration/idle-injector"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { createBoulderContinuationRuntime } from "./runtime"

const IDLE_SETTLE_MS = 150

export type BoulderContinuationSessionInfo = { readonly id?: string }

export type BoulderContinuationContext = {
  readonly event: {
    subscribe(): AsyncIterable<IdleInjectorEvent>
  }
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<BoulderContinuationSessionInfo>
    synthetic(input: {
      readonly sessionID: string
      readonly text: string
      readonly description: string
      readonly metadata: Readonly<Record<string, string>>
      readonly delivery: "queue"
      readonly resume: true
    }): Promise<unknown>
  }
}

export type RegisterBoulderContinuationOptions = {
  readonly dispatch?: NativeIdleDispatch
  readonly enabled: boolean
  readonly directory: string
  // The plugin-wide instance, shared with goal and the todo enforcer.
  readonly gate: SessionDispatchGate
  readonly trace?: IdleInjectorTrace
}

export type RegisteredBoulderContinuation = {
  readonly dispose: () => void
}

export function registerBoulderContinuationEffect(
  ctx: { readonly session: Pick<Context["session"], "get" | "synthetic">;
    readonly event: { readonly subscribe: () => Stream.Stream<IdleInjectorEvent, unknown, import("effect").Scope.Scope> } },
  options: RegisterBoulderContinuationOptions,
): Effect.Effect<RegisteredBoulderContinuation, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    if (!options.enabled) {
      options.trace?.("omo.boulder.disabled")
      return { dispose: () => undefined }
    }
    const ports = yield* createNativeIdlePorts(ctx, options.dispatch)
    const runtime = createBoulderContinuationRuntime({
      directory: options.directory,
      gate: options.gate,
      sessionExists: ports.sessionExists,
      dispatchContinuation: ports.dispatch,
      settle: ports.settle,
      trace: options.trace,
    })
    const worker = Stream.runForEach(ctx.event.subscribe(), (event) =>
      Effect.forkScoped(Effect.promise(() => runtime.handleEvent(event))).pipe(Effect.asVoid))
    yield* Effect.forkScoped(worker)
    yield* Effect.addFinalizer(() => Effect.sync(() => runtime.dispose()))
    options.trace?.("omo.boulder.registered")
    return { dispose: () => runtime.dispose() }
  })
}

export async function registerBoulderContinuation(
  ctx: BoulderContinuationContext,
  options: RegisterBoulderContinuationOptions,
): Promise<RegisteredBoulderContinuation> {
  const { directory, enabled, gate, trace } = options
  if (!enabled) {
    trace?.("omo.boulder.disabled")
    return { dispose: () => undefined }
  }

  const runtime = createBoulderContinuationRuntime({
    directory,
    gate,
    sessionExists: async (sessionID) => {
      try {
        await ctx.session.get({ sessionID })
        return true
      } catch (error) {
        trace?.("omo.boulder.session-missing", {
          sessionID,
          message: error instanceof Error ? error.message : String(error),
        })
        return false
      }
    },
    dispatchContinuation: async (sessionID, prompt) => {
      await ctx.session.synthetic({
        sessionID,
        text: prompt,
        description: "Continue unfinished OMO plan work",
        metadata: { source: "omo.boulder.idle-continuation" },
        delivery: "queue",
        resume: true,
      })
    },
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, IDLE_SETTLE_MS)),
    trace,
  })
  trace?.("omo.boulder.registered")

  let disposed = false
  const inFlight = new Set<Promise<void>>()
  const pump = (async () => {
    for await (const event of ctx.event.subscribe()) {
      if (disposed) return
      const pending = runtime.handleEvent(event)
      inFlight.add(pending)
      void pending
        .catch((error: unknown) => {
          trace?.("omo.boulder.event-error", {
            message: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => inFlight.delete(pending))
    }
  })()
  void pump.catch((error: unknown) => {
    trace?.("omo.boulder.event-pump-error", {
      message: error instanceof Error ? error.message : String(error),
    })
  })

  return {
    dispose: () => {
      disposed = true
      runtime.dispose()
      inFlight.clear()
    },
  }
}
