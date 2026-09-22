import { loadOpenCode2Config } from "../../config"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"

import { registerGoalFeature } from "./register"
import type { GoalFeatureContext, RegisteredGoalFeature } from "./register"
import type { GoalTrace } from "./types"

export type ConfiguredGoalContext = GoalFeatureContext & {
  readonly options: Readonly<Record<string, unknown>>
}

export type RegisterConfiguredGoalFeatureOptions = {
  readonly directory: string
  readonly gate: SessionDispatchGate
  readonly trace?: GoalTrace
}

export async function registerConfiguredGoalFeature(
  ctx: ConfiguredGoalContext,
  options: RegisterConfiguredGoalFeatureOptions,
): Promise<RegisteredGoalFeature> {
  const loaded = loadOpenCode2Config({
    directory: options.directory,
    options: { ...ctx.options },
  })
  const enabled = loaded.config.goal?.enabled === true
    && !loaded.config.disabled_hooks?.includes("goal")
  const autoStart = enabled && loaded.config.goal?.auto_start === true
  options.trace?.("omo.config.loaded", {
    diagnostics: loaded.diagnostics.length,
    goalAutoStart: autoStart,
    goalEnabled: enabled,
    sources: loaded.sources.length,
  })
  return registerGoalFeature(ctx, {
    directory: options.directory,
    autoStart,
    enabled,
    gate: options.gate,
    trace: options.trace,
  })
}
