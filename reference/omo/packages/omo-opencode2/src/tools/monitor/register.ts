import type { Context } from "@opencode/plugin/promise/plugin"
import type { Context as EffectContext } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Cause, Effect, Stream } from "effect"

import { loadOpenCode2Config } from "../../config"
import { resolveMonitorConfig } from "../../features/monitor/config"
import { MonitorDelivery } from "../../features/monitor/delivery"
import type { MonitorDispatchInput } from "../../features/monitor/delivery"
import { MonitorManager } from "../../features/monitor/manager"
import { createNativeIdlePorts } from "../../orchestration/idle-injector"
import { createMonitorTools } from "./tools"

type Trace = (event: string, detail?: Record<string, unknown>) => void

export interface RegisterMonitorToolsOptions {
  readonly cwd: string
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
  readonly trace?: Trace
}

export interface MonitorRegistration {
  readonly manager: MonitorManager
  readonly dispose: () => Promise<void>
}

export type NativeMonitorOptions = {
  readonly cwd: string
  readonly trace?: Trace
  readonly dispatchManaged?: (input: MonitorDispatchInput) => Effect.Effect<boolean, unknown>
}

type NativeMonitorContext = Pick<EffectContext, "options" | "session" | "event"> & {
  readonly tool: Pick<EffectContext["tool"], "transform">
}

export const registerMonitorToolsEffect = Effect.fn("omo.registerMonitorToolsEffect")(function* (
  ctx: NativeMonitorContext,
  options: NativeMonitorOptions,
) {
  const loaded = loadOpenCode2Config({ directory: options.cwd, options: { ...ctx.options } })
  const config = resolveMonitorConfig(loaded.config.monitor)
  const disabled = loaded.config.disabled_hooks?.includes("monitor") === true
  if (!config.enabled || disabled) {
    options.trace?.("omo.monitor.disabled", { reason: disabled ? "listed in disabled_hooks" : "monitor.enabled is not true" })
    return undefined
  }

  const ports = yield* createNativeIdlePorts(ctx)
  const delivery = new MonitorDelivery({
    ...(options.trace ? { trace: options.trace } : {}),
    dispatch: (input) => ports.run(Effect.gen(function* () {
      if (options.dispatchManaged && (yield* options.dispatchManaged(input))) return
      yield* ctx.session.synthetic({ ...input, sessionID: Session.ID.make(input.sessionID) })
    })),
  })
  const manager = new MonitorManager({ config, delivery, cwd: options.cwd })
  yield* Effect.addFinalizer(() => Effect.promise(() => manager.shutdown()))
  const tools = createMonitorTools({
    manager, config,
    resolveSessionID: (toolCtx) => typeof toolCtx === "object" && toolCtx !== null && "sessionID" in toolCtx
      && typeof toolCtx.sessionID === "string" ? toolCtx.sessionID : undefined,
  })
  yield* ctx.tool.transform((draft) => {
    for (const tool of tools) draft.add({
      name: tool.name, description: tool.description, input: tool.input, options: { codemode: false },
      execute: (input, toolCtx) => Effect.tryPromise({
        try: () => tool.execute(input, toolCtx),
        catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
      }),
    })
  })
  yield* Effect.forkScoped(Stream.runForEach(ctx.event.subscribe(), (event) => {
    if (event.type !== "session.deleted") return Effect.void
    return Effect.forkScoped(Effect.promise(() => manager.stopSessionMonitors(event.data.sessionID)).pipe(
      Effect.catchCause((cause) => Effect.sync(() => options.trace?.("omo.monitor.cleanup-failed", { message: Cause.pretty(cause) }))),
    )).pipe(Effect.asVoid)
  }))
  options.trace?.("omo.monitor.registered", {
    tools: tools.map((tool) => tool.name), allowedCommands: config.allowed_commands ?? [],
    maxMonitorsPerSession: config.max_monitors_per_session,
  })
  return { manager, dispose: () => manager.shutdown() }
})

/**
 * Registers monitor_start / monitor_stop / monitor_list / monitor_output.
 * Returns undefined when `monitor.enabled` is not true, so the tools are absent
 * from the registry rather than present-and-refusing.
 */
export async function registerMonitorTools(
  ctx: Context,
  options: RegisterMonitorToolsOptions,
): Promise<MonitorRegistration | undefined> {
  const loaded = loadOpenCode2Config({ directory: options.cwd, options: { ...ctx.options } })
  const config = resolveMonitorConfig(loaded.config.monitor)
  const disabled = loaded.config.disabled_hooks?.includes("monitor") === true
  if (!config.enabled || disabled) {
    options.trace?.("omo.monitor.disabled", {
      reason: disabled ? "listed in disabled_hooks" : "monitor.enabled is not true",
    })
    return undefined
  }

  const delivery = new MonitorDelivery({ ctx, ...(options.trace ? { trace: options.trace } : {}) })
  const manager = new MonitorManager({ config, delivery, cwd: options.cwd })
  const tools = createMonitorTools({ manager, config, resolveSessionID: options.resolveSessionID })

  await ctx.tool.transform((draft) => {
    for (const tool of tools) {
      draft.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        options: { codemode: false },
        execute: tool.execute,
      })
    }
  })

  options.trace?.("omo.monitor.registered", {
    tools: tools.map((tool) => tool.name),
    allowedCommands: config.allowed_commands ?? [],
    maxMonitorsPerSession: config.max_monitors_per_session,
  })

  return { manager, dispose: () => manager.shutdown() }
}
