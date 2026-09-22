import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"

import type { IdleInjectorEvent, IdleInjectorTrace } from "../../orchestration/idle-injector"
import { createNativeIdlePorts, type NativeIdleDispatch } from "../../orchestration/idle-injector"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import type { TodoItem } from "../../orchestration/todo-store"
import { createTodoContinuationRuntime } from "./runtime"

const IDLE_SETTLE_MS = 150

export type TodoContinuationSessionInfo = { readonly id?: string }

export type TodoContinuationContext = {
  readonly event: {
    subscribe(): AsyncIterable<IdleInjectorEvent>
  }
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<TodoContinuationSessionInfo>
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

export type RegisterTodoContinuationOptions = {
  readonly dispatch?: NativeIdleDispatch
  readonly enabled: boolean
  readonly getTodos: (sessionID: string) => readonly TodoItem[]
  // The plugin-wide instance, shared with goal so the two cannot both inject
  // on one idle edge.
  readonly gate: SessionDispatchGate
  readonly maxConsecutive?: number
  readonly trace?: IdleInjectorTrace
}

export type RegisteredTodoContinuation = {
  readonly dispose: () => void
}

export function registerTodoContinuationEffect(
  ctx: { readonly session: Pick<Context["session"], "get" | "synthetic">;
    readonly event: { readonly subscribe: () => Stream.Stream<IdleInjectorEvent, unknown, import("effect").Scope.Scope> } },
  options: RegisterTodoContinuationOptions,
): Effect.Effect<RegisteredTodoContinuation, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    if (!options.enabled) {
      options.trace?.("omo.todo.disabled")
      return { dispose: () => undefined }
    }
    const ports = yield* createNativeIdlePorts(ctx, options.dispatch)
    const runtime = createTodoContinuationRuntime({
      gate: options.gate,
      getTodos: options.getTodos,
      maxConsecutive: options.maxConsecutive,
       sessionExists: ports.sessionExists,
       dispatchContinuation: ports.dispatch,
       settle: ports.settle,
      trace: options.trace,
    })
    const worker = Stream.runForEach(ctx.event.subscribe(), (event) =>
      Effect.forkScoped(Effect.promise(() => runtime.handleEvent(event))).pipe(Effect.asVoid))
    yield* Effect.forkScoped(worker)
    yield* Effect.addFinalizer(() => Effect.sync(() => runtime.dispose()))
    options.trace?.("omo.todo.registered", { maxConsecutive: options.maxConsecutive ?? null })
    return { dispose: () => runtime.dispose() }
  })
}

export async function registerTodoContinuation(
  ctx: TodoContinuationContext,
  options: RegisterTodoContinuationOptions,
): Promise<RegisteredTodoContinuation> {
  const { enabled, gate, getTodos, maxConsecutive, trace } = options
  if (!enabled) {
    trace?.("omo.todo.disabled")
    return { dispose: () => undefined }
  }

  const runtime = createTodoContinuationRuntime({
    gate,
    getTodos,
    maxConsecutive,
    sessionExists: async (sessionID) => {
      try {
        await ctx.session.get({ sessionID })
        return true
      } catch (error) {
        trace?.("omo.todo.session-missing", {
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
        description: "Continue unfinished OMO todos",
        metadata: { source: "omo.todo.idle-continuation" },
        delivery: "queue",
        resume: true,
      })
    },
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, IDLE_SETTLE_MS)),
    trace,
  })
  trace?.("omo.todo.registered", { maxConsecutive: maxConsecutive ?? null })

  let disposed = false
  const inFlight = new Set<Promise<void>>()
  const pump = (async () => {
    for await (const event of ctx.event.subscribe()) {
      if (disposed) return
      const pending = runtime.handleEvent(event)
      inFlight.add(pending)
      void pending
        .catch((error: unknown) => {
          trace?.("omo.todo.event-error", {
            message: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => inFlight.delete(pending))
    }
  })()
  void pump.catch((error: unknown) => {
    trace?.("omo.todo.event-pump-error", {
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
