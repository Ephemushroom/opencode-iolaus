import { loadOpenCode2Config } from "../../config"
import type { IdleInjectorTrace } from "../../orchestration/idle-injector"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"

import { registerBoulderContinuation } from "./register"
import type { BoulderContinuationContext, RegisteredBoulderContinuation } from "./register"

export type ConfiguredBoulderContinuationContext = BoulderContinuationContext & {
  readonly options: Readonly<Record<string, unknown>>
}

export type RegisterConfiguredBoulderContinuationOptions = {
  readonly directory: string
  readonly gate: SessionDispatchGate
  readonly trace?: IdleInjectorTrace
}

export async function registerConfiguredBoulderContinuation(
  ctx: ConfiguredBoulderContinuationContext,
  options: RegisterConfiguredBoulderContinuationOptions,
): Promise<RegisteredBoulderContinuation> {
  const loaded = loadOpenCode2Config({
    directory: options.directory,
    options: { ...ctx.options },
  })
  const enabled = loaded.config.boulder?.enabled === true
    && !loaded.config.disabled_hooks?.includes("boulder-continuation")

  return registerBoulderContinuation(ctx, {
    enabled,
    directory: options.directory,
    gate: options.gate,
    trace: options.trace,
  })
}
