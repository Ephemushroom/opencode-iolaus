import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"

import { registerCategories } from "./register-categories"
import { registerPrimaries } from "./register-primaries"
import { registerSubagents } from "./register-subagents"
import type { CatalogSource } from "./model-resolution"
import { loadOpenCode2Config } from "../config"
import type { OpenCode2Config } from "../config"

type Trace = (event: string, detail?: Record<string, unknown>) => void

export type RegisterConfiguredAgentsOptions = {
  readonly catalog: CatalogSource
  readonly directory: string
  readonly trace?: Trace
}

export type ConfiguredAgentRegistration = {
  readonly primaries: Set<string>
  readonly subagents: Set<string>
  readonly categories: Set<string>
  readonly sisyphusPrompt: string | undefined
  readonly models: ReadonlyMap<string, string>
}

export type ResolvedAgentRegistrationConfig = {
  readonly agentOverrides: OpenCode2Config["agents"]
  readonly defaultAgent: string
}

export function resolveAgentRegistrationConfig(
  config: Pick<OpenCode2Config, "agents" | "default_agent">,
): ResolvedAgentRegistrationConfig {
  return {
    agentOverrides: config.agents,
    defaultAgent: config.default_agent ?? "sisyphus",
  }
}

/** Coordinates the three agent registries from one parsed config snapshot. */
export const registerConfiguredAgents = Effect.fn("omo.registerConfiguredAgents")(function* (
  ctx: Pick<Context, "options"> & {
    readonly agent: Pick<Context["agent"], "transform"> & {
      readonly list: () => Effect.Effect<Pick<Effect.Success<ReturnType<Context["agent"]["list"]>>, "data">, unknown>
    }
  },
  options: RegisterConfiguredAgentsOptions,
) {
  const config = loadOpenCode2Config({
    directory: options.directory,
    options: { ...ctx.options },
  }).config
  const { agentOverrides, defaultAgent } = resolveAgentRegistrationConfig(config)
  let sisyphusPrompt: string | undefined
  const shared = {
    catalog: options.catalog,
    ...(options.trace ? { trace: options.trace } : {}),
    ...(agentOverrides ? { agentOverrides } : {}),
  }
  const subagents = yield* registerSubagents(ctx, shared)
  const primaries = yield* registerPrimaries(ctx, {
    ...shared,
    defaultAgent,
    onSisyphusPrompt: (prompt) => {
      sisyphusPrompt = prompt
    },
  })
  const categories = yield* registerCategories(ctx, shared)
  // A read materializes deferred transforms; reload only invalidates in setup's batch.
  const agents = yield* ctx.agent.list()
  const models = new Map<string, string>()
  for (const agent of agents.data) {
    if (agent.model) models.set(agent.id, `${agent.model.providerID}/${agent.model.id}`)
  }
  return { primaries, subagents, categories, sisyphusPrompt, models } satisfies ConfiguredAgentRegistration
})
