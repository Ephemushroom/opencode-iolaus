
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema, Stream } from "effect"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { createNativeIdlePorts, type NativeIdleDispatch } from "../../orchestration/idle-injector"
import { createGoalAutoStartHandler } from "./auto-start"
import type { GoalContextEvent, GoalSessionInfo } from "./auto-start"
import { createGoalController } from "./controller"
import { createGoalRuntime } from "./runtime"
import type { GoalEvent } from "./runtime"
import { createGoalTools } from "./tools"
import type { GoalToolDefinition } from "./tools"
import type { GoalTrace } from "./types"

const IDLE_SETTLE_MS = 150

export type RegisterGoalFeatureOptions = {
  readonly directory: string
  readonly enabled: boolean
  readonly autoStart?: boolean
  // Supplied by the plugin owner so every idle-injecting feature shares one
  // lock. See orchestration/session-dispatch-gate.
  readonly gate: SessionDispatchGate
  readonly trace?: GoalTrace
}

export type GoalFeatureContext = {
  readonly tool: {
    transform(transformer: (draft: { add(tool: GoalToolDefinition): void }) => void | Promise<void>): Promise<unknown>
  }
  readonly event: {
    subscribe(): AsyncIterable<GoalEvent>
  }
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<GoalSessionInfo>
    hook(
      event: "context",
      handler: (event: GoalContextEvent) => void | Promise<void>,
    ): Promise<unknown>
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

export type RegisteredGoalFeature = {
  readonly dispose: () => void
}

export type NativeGoalRegistrationOptions = {
  readonly dispatch?: NativeIdleDispatch
  readonly directory: string
  readonly enabled: boolean
  readonly autoStart?: boolean
  readonly gate: SessionDispatchGate
  readonly trace?: GoalTrace
}

export type NativeGoalRegistration = {
  readonly dispose: () => void
}

export function registerGoalFeatureEffect(
  ctx: { readonly tool: Pick<Context["tool"], "transform">;
    readonly session: Pick<Context["session"], "get" | "synthetic" | "hook">;
    readonly event: { readonly subscribe: () => Stream.Stream<GoalEvent, unknown, import("effect").Scope.Scope> } },
  options: NativeGoalRegistrationOptions,
): Effect.Effect<NativeGoalRegistration, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    if (!options.enabled) {
      options.trace?.("omo.goal.disabled", { tools: [] })
      return { dispose: () => undefined }
    }

    const controller = createGoalController({ projectDir: options.directory })
    const ports = yield* createNativeIdlePorts(ctx, options.dispatch)
    const tools = createGoalTools({ controller, trace: options.trace })
    yield* ctx.tool.transform((draft) => {
      for (const tool of tools) {
        draft.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          options: tool.options,
          execute: (input, toolContext) => Effect.tryPromise({
            try: () => tool.execute(input, { sessionID: toolContext.sessionID }),
            catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
          }).pipe(Effect.map((result) => ({ content: result.content }))),
        })
      }
    }).pipe(Effect.orDie)
    options.trace?.("omo.goal.registered", { tools: tools.map((tool) => tool.name) })

    if (options.autoStart) {
      yield* ctx.session.hook("context", (event) => Effect.promise(() => createGoalAutoStartHandler({
        controller,
        getSessionInfo: (sessionID) => ports.run(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(() => null),
        trace: options.trace,
      })(event))).pipe(Effect.orDie)
      options.trace?.("omo.goal.auto-start-registered")
    }

    const runtime = createGoalRuntime({
      controller,
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
    return { dispose: () => runtime.dispose() }
  })
}

export async function registerGoalFeature(
  ctx: GoalFeatureContext,
  options: RegisterGoalFeatureOptions,
): Promise<RegisteredGoalFeature> {
  const { directory, enabled, autoStart = false, gate, trace } = options
  if (!enabled) {
    trace?.("omo.goal.disabled", { tools: [] })
    return { dispose: () => undefined }
  }

  const controller = createGoalController({ projectDir: directory })
  const getSessionInfo = async (sessionID: string): Promise<GoalSessionInfo | null> => {
    try {
      return await ctx.session.get({ sessionID })
    } catch (error) {
      trace?.("omo.goal.session-missing", {
        sessionID,
        message: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
  const tools = createGoalTools({ controller, trace })
  await ctx.tool.transform((draft) => {
    for (const tool of tools) draft.add(tool)
  })
  trace?.("omo.goal.registered", { tools: tools.map((tool) => tool.name) })

  if (autoStart) {
    await ctx.session.hook("context", createGoalAutoStartHandler({
      controller,
      getSessionInfo,
      trace,
    }))
    trace?.("omo.goal.auto-start-registered")
  }

  const runtime = createGoalRuntime({
    controller,
    gate,
    sessionExists: async (sessionID) => (await getSessionInfo(sessionID)) !== null,
    dispatchContinuation: async (sessionID, prompt) => {
      await ctx.session.synthetic({
        sessionID,
        text: prompt,
        description: "Continue active OMO goal",
        metadata: { source: "omo.goal.idle-continuation" },
        delivery: "queue",
        resume: true,
      })
    },
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, IDLE_SETTLE_MS)),
    trace,
  })

  let disposed = false
  const inFlight = new Set<Promise<void>>()
  const pump = (async () => {
    for await (const event of ctx.event.subscribe()) {
      if (disposed) return
      const pending = runtime.handleEvent(event)
      inFlight.add(pending)
      void pending
        .catch((error: unknown) => {
          trace?.("omo.goal.event-error", {
            message: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => inFlight.delete(pending))
    }
  })()
  void pump.catch((error: unknown) => {
    trace?.("omo.goal.event-pump-error", {
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
