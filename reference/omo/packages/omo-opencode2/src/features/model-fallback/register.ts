import type { Context } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Cause, Effect, Stream } from "effect"
import { loadOpenCode2Config } from "../../config"
import type { Executor } from "../../orchestration/execution/types"
import { createNativeIdlePorts } from "../../orchestration/idle-injector"
import type { TaskRegistry } from "../../orchestration/task-registry"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { createModelFallbackRuntime } from "./runtime"
import type { ModelFallbackEvent, ModelFallbackSessionInfo, ModelFallbackTrace } from "./runtime"

const DEFAULT_MAX_RETRIES = 1

export type ModelFallbackContext = {
  readonly options: Readonly<Record<string, unknown>>
  readonly event: {
    subscribe(): AsyncIterable<ModelFallbackEvent>
  }
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<ModelFallbackSessionInfo>
    hook(
      event: "context",
      handler: (event: {
        readonly sessionID: string
        readonly agent: string
        readonly model: { readonly providerID: string; readonly id: string }
      }) => void | Promise<void>,
    ): Promise<unknown>
    switchModel(input: {
      readonly sessionID: string
      readonly model: { readonly providerID: string; readonly id: string }
    }): Promise<unknown>
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

export type RegisterModelFallbackOptions = {
  readonly directory: string
  readonly gate: SessionDispatchGate
  readonly registry: TaskRegistry
  readonly trace?: ModelFallbackTrace
}

export type RegisteredModelFallback = {
  readonly dispose: () => void
}

export type NativeModelFallbackOptions = {
  readonly directory: string
  readonly gate: SessionDispatchGate
  readonly executor: Pick<Executor, "managed">
  readonly trace?: ModelFallbackTrace
}

export const registerConfiguredModelFallbackEffect = Effect.fn("omo.registerConfiguredModelFallbackEffect")(function* (
  ctx: Pick<Context, "options" | "session" | "event">,
  options: NativeModelFallbackOptions,
) {
  const loaded = loadOpenCode2Config({ directory: options.directory, options: { ...ctx.options } })
  const disabled = loaded.config.disabled_hooks?.includes("model_fallback") === true
  if (loaded.config.model_fallback?.enabled !== true || disabled) {
    options.trace?.("omo.model-fallback.disabled", { reason: disabled ? "listed in disabled_hooks" : "model_fallback.enabled is not true" })
    return { dispose: () => undefined }
  }
  const maxRetries = loaded.config.model_fallback.max_retries ?? DEFAULT_MAX_RETRIES
  const ports = yield* createNativeIdlePorts(ctx)
  const sessionContexts = new Map<string, ModelFallbackSessionInfo>()
  yield* ctx.session.hook("context", (event) => Effect.sync(() => {
    sessionContexts.set(event.sessionID, { agent: event.agent, model: event.model })
  }))
  const runtime = createModelFallbackRuntime({
    gate: options.gate, maxRetries, trace: options.trace,
    isManaged: (sessionID) => ports.run(options.executor.managed(Session.ID.make(sessionID)).pipe(Effect.map((record) => record !== undefined))),
    getSession: (sessionID) => ports.run(ctx.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(Effect.map((session) => {
      const context = sessionContexts.get(sessionID)
      return { agent: session.agent ?? context?.agent, model: session.model ?? context?.model }
    }))),
    switchModel: (sessionID, model) => ports.run(ctx.session.switchModel({
      sessionID: Session.ID.make(sessionID), model: { providerID: Provider.ID.make(model.providerID), id: Model.ID.make(model.id) },
    }).pipe(Effect.asVoid)),
    redispatch: (sessionID) => ports.run(ctx.session.synthetic({
      sessionID: Session.ID.make(sessionID),
      text: "The previous model execution failed because its provider was exhausted. Continue the current task from the existing conversation without repeating completed work.",
      description: "Continue after provider exhaustion fallback", metadata: { source: "omo.model-fallback" },
      delivery: "queue", resume: true,
    }).pipe(Effect.asVoid)),
  })
  const dispose = () => { runtime.dispose(); sessionContexts.clear() }
  yield* Effect.forkScoped(Stream.runForEach(ctx.event.subscribe(), (event) => {
    if (event.type === "session.deleted") sessionContexts.delete(event.data.sessionID)
    return Effect.forkScoped(Effect.promise(() => runtime.handleEvent(event)).pipe(
      Effect.catchCause((cause) => Effect.sync(() => options.trace?.("omo.model-fallback.exhausted", { reason: "event_handler", message: Cause.pretty(cause) }))),
    )).pipe(Effect.asVoid)
  }))
  yield* Effect.addFinalizer(() => Effect.sync(dispose))
  options.trace?.("omo.model-fallback.registered", { maxRetries })
  return { dispose }
})

export async function registerConfiguredModelFallback(
  ctx: ModelFallbackContext,
  options: RegisterModelFallbackOptions,
): Promise<RegisteredModelFallback> {
  const loaded = loadOpenCode2Config({
    directory: options.directory,
    options: { ...ctx.options },
  })
  const disabledByHook = loaded.config.disabled_hooks?.includes("model_fallback") === true
  if (loaded.config.model_fallback?.enabled !== true || disabledByHook) {
    options.trace?.("omo.model-fallback.disabled", {
      reason: disabledByHook ? "listed in disabled_hooks" : "model_fallback.enabled is not true",
    })
    return { dispose: () => undefined }
  }

  const maxRetries = loaded.config.model_fallback.max_retries ?? DEFAULT_MAX_RETRIES
  const sessionContexts = new Map<string, ModelFallbackSessionInfo>()
  await ctx.session.hook("context", (event) => {
    sessionContexts.set(event.sessionID, { agent: event.agent, model: event.model })
  })
  const runtime = createModelFallbackRuntime({
    gate: options.gate,
    isManaged: async (sessionID) => options.registry.list().some((record) => record.childSessionID === sessionID),
    maxRetries,
    getSession: async (sessionID) => {
      const session = await ctx.session.get({ sessionID })
      const context = sessionContexts.get(sessionID)
      return {
        ...session,
        agent: session.agent ?? context?.agent,
        model: session.model ?? context?.model,
      }
    },
    switchModel: async (sessionID, model) => {
      await ctx.session.switchModel({ sessionID, model })
    },
    redispatch: async (sessionID) => {
      await ctx.session.synthetic({
        sessionID,
        text: "The previous model execution failed because its provider was exhausted. Continue the current task from the existing conversation without repeating completed work.",
        description: "Continue after provider exhaustion fallback",
        metadata: { source: "omo.model-fallback" },
        delivery: "queue",
        resume: true,
      })
    },
    trace: options.trace,
  })
  options.trace?.("omo.model-fallback.registered", { maxRetries })

  let disposed = false
  const inFlight = new Set<Promise<void>>()
  const pump = (async () => {
    for await (const event of ctx.event.subscribe()) {
      if (disposed) return
      if (event.type === "session.deleted" && typeof event.data?.sessionID === "string") {
        sessionContexts.delete(event.data.sessionID)
      }
      const pending = runtime.handleEvent(event)
      inFlight.add(pending)
      void pending
        .catch((error: unknown) => {
          options.trace?.("omo.model-fallback.exhausted", {
            reason: "event_handler",
            message: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => inFlight.delete(pending))
    }
  })()
  void pump.catch((error: unknown) => {
    options.trace?.("omo.model-fallback.exhausted", {
      reason: "event_pump",
      message: error instanceof Error ? error.message : String(error),
    })
  })

  return {
    dispose: () => {
      disposed = true
      runtime.dispose()
      sessionContexts.clear()
      inFlight.clear()
    },
  }
}
