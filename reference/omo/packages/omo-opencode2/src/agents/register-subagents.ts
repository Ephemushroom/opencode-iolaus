import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent, Model } from "@opencode/plugin"
import { AGENT_MODEL_REQUIREMENTS } from "@oh-my-opencode/model-core"

import { SUBAGENT_DEFINITIONS } from "./agent-catalog"
import { resolveAgentModel } from "./model-resolution"
import type { CatalogSource } from "./model-resolution"
import type { OpenCode2AgentOverride } from "../config"
import { Effect } from "effect"

export interface RegisterSubagentsOptions {
  /** Live catalog source; models resolve against its freshest snapshot. */
  catalog: CatalogSource;
  /** System default model override (falls back to the catalog's default). */
  systemDefaultModel?: string;
  /** Per-agent overrides from the config chain. */
  agentOverrides?: Record<string, OpenCode2AgentOverride>;
  /** Optional per-agent trace hook (QA evidence; records resolved model/mode). */
  trace?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * Register the OMO subagent catalog with OpenCode 2.
 *
 * The v2 agent registry materializes lazily and the catalog populates
 * asynchronously, so model resolution happens inside the agent.transform
 * callback against the catalog source's freshest snapshot (not a setup-time
 * capture). Sisyphus, Hephaestus, Prometheus, and Atlas are registered
 * separately by callers that can supply their richer runtime context.
 *
 * Returns the live set of agent ids registered; it populates once the transform
 * is applied (see ctx.agent.reload()).
 */
export function registerSubagents(
  ctx: { readonly agent: Pick<Context["agent"], "transform"> },
  options: RegisterSubagentsOptions,
): Effect.Effect<Set<string>, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
  const registered = new Set<string>()

  yield* ctx.agent.transform((draft) => {
    const snapshot = options.catalog.current
    const effectiveDefault = options.systemDefaultModel ?? snapshot.systemDefaultModel

    for (const def of SUBAGENT_DEFINITIONS) {
      const requirement = AGENT_MODEL_REQUIREMENTS[def.id]
      const resolved = resolveAgentModel(requirement, snapshot, effectiveDefault, options.agentOverrides?.[def.id])
      if (!resolved) continue

      const systemPrompt = def.buildPrompt(resolved.model)
      draft.update(def.id, (agent) => {
        agent.name = Agent.Name.make(def.name)
        agent.description = def.description
        agent.mode = def.mode
        if (def.hidden !== undefined) agent.hidden = def.hidden
        if (def.color !== undefined) agent.color = def.color
        agent.system = systemPrompt

        if (resolved.model.includes("/")) {
          agent.model = Model.Ref.parse(resolved.model) as typeof agent.model
          if (resolved.variant !== undefined && agent.model) {
            agent.model.variant = Model.VariantID.make(resolved.variant)
          }
        }

        agent.permissions = def.permissions.map((rule) => ({
          action: rule.action,
          resource: rule.resource,
          effect: rule.effect,
        }))

        const body: Record<string, unknown> = {}
        if (def.request?.temperature !== undefined) body.temperature = def.request.temperature
        if (def.request?.maxOutputTokens !== undefined) {
          body.max_output_tokens = def.request.maxOutputTokens
        }
        if (Object.keys(body).length > 0) {
          agent.request.body = { ...agent.request.body, ...body }
        }
      })

      registered.add(def.id)
      options.trace?.("omo.agent.registered", {
        id: def.id,
        mode: def.mode,
        model: resolved.model,
        variant: resolved.variant,
        systemLength: systemPrompt.length,
      })
    }
  })

  return registered
  })
}
