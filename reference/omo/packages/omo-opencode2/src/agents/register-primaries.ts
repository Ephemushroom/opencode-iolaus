import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent, Model } from "@opencode/plugin"
import {
  buildDynamicHephaestusPrompt,
  isHephaestusSupportedModel,
} from "@oh-my-opencode/agents-core"
import { atlasPromptVariants, loadPromptSync, resolveVariant } from "@oh-my-opencode/prompts-core"
import { getPrometheusPrompt } from "./prometheus"
import { buildSisyphusPromptForModel } from "./sisyphus-prompt"

import { resolveAgentModel } from "./model-resolution"
import type { CatalogSource } from "./model-resolution"
import { Effect } from "effect"
import { AGENT_MODEL_REQUIREMENTS } from "@oh-my-opencode/model-core"
import type { OpenCode2AgentOverride } from "../config"

const PRIMARY = "primary"

interface PrimaryDefinition {
  id: string;
  description: string;
  color?: string;
  temperature?: number;
  maxOutputTokens?: number;
  buildPrompt: (model: string) => string;
  /** v1 parity: agent only registers when the resolved model satisfies this. */
  supportsModel?: (model: string) => boolean;
}

/**
 * Sisyphus prompt for a resolved model, with empty runtime catalogs at
 * registration time. The model-family routing lives in sisyphus-prompt.ts; the
 * live agent/skill/category/tool lists are injected at request time by the
 * sisyphus context hook.
 */
function buildSisyphusBase(model: string): string {
  return buildSisyphusPromptForModel(model, [], [], [], [], false)
}

function buildAtlasBase(model: string): string {
  const source = resolveVariant({ agentName: "atlas", modelID: model, variants: atlasPromptVariants })
  const variant = (
    Object.prototype.hasOwnProperty.call(atlasPromptVariants, source) ? source : "default"
  ) as keyof typeof atlasPromptVariants
  return loadPromptSync({ source: atlasPromptVariants[variant], name: "atlas", variant }).body
}

const PRIMARIES: PrimaryDefinition[] = [
  {
    id: "sisyphus",
    description:
      "Powerful AI orchestrator. Plans obsessively with todos, assesses search complexity before exploration, delegates strategically via category+skills combinations. Uses explore for internal code (parallel-friendly), librarian for external docs. (Sisyphus - OhMyOpenCode)",
    color: "#00CED1",
    buildPrompt: buildSisyphusBase,
  },
  {
    id: "hephaestus",
    description:
      "Autonomous Deep Worker - goal-oriented execution with GPT Codex. Explores thoroughly before acting, uses explore/librarian agents for comprehensive context, completes tasks end-to-end. Inspired by AmpCode deep mode. (Hephaestus - OhMyOpenCode)",
    color: "#D97706",
    maxOutputTokens: 32000,
    buildPrompt: (model) => buildDynamicHephaestusPrompt({ model }),
    supportsModel: isHephaestusSupportedModel,
  },
  {
    id: "prometheus",
    description: "Plan agent (Prometheus - OhMyOpenCode)",
    color: "#FF5722",
    buildPrompt: () => getPrometheusPrompt(),
  },
  {
    id: "atlas",
    description:
      "Orchestrates work via task() to complete ALL tasks in a todo list until fully done. (Atlas - OhMyOpenCode)",
    color: "#10B981",
    temperature: 0.1,
    buildPrompt: buildAtlasBase,
  },
]

/**
 * Register the primary OMO agents (sisyphus / hephaestus / prometheus / atlas)
 * with OpenCode 2, and set the harness default + downgrade the built-in `build`
 * agent to a hidden subagent (matching the v1 adapter's behaviour).
 */
export function registerPrimaries(
  ctx: { readonly agent: Pick<Context["agent"], "transform"> },
  options: {
    catalog: CatalogSource;
    systemDefaultModel?: string;
    defaultAgent?: string;
    agentOverrides?: Record<string, OpenCode2AgentOverride>;
    trace?: (event: string, detail?: Record<string, unknown>) => void;
    /** Called with the exact static Sisyphus prompt baked at registration time. */
    onSisyphusPrompt?: (prompt: string) => void;
  },
): Effect.Effect<Set<string>, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    const registered = new Set<string>()

  yield* ctx.agent.transform((draft) => {
    const snapshot = options.catalog.current
    const effectiveDefault = options.systemDefaultModel ?? snapshot.systemDefaultModel
    for (const def of PRIMARIES) {
      const requirement = AGENT_MODEL_REQUIREMENTS[def.id]
      const resolved = resolveAgentModel(requirement, snapshot, effectiveDefault, options.agentOverrides?.[def.id])
      if (!resolved) continue

      // v1 parity: an agent with a model-support predicate is skipped (not
      // registered) when the resolved model fails it — e.g. Hephaestus is
      // GPT-5.x-only and never falls back onto a non-GPT system default.
      if (def.supportsModel && !def.supportsModel(resolved.model)) {
        options.trace?.("omo.agent.skipped", {
          id: def.id,
          reason: "unsupported-model",
          model: resolved.model,
        })
        continue
      }

      const systemPrompt = def.buildPrompt(resolved.model)
      if (def.id === "sisyphus") {
        options.onSisyphusPrompt?.(systemPrompt)
      }
      draft.update(def.id, (agent) => {
        agent.name = Agent.Name.make(def.id)
        agent.description = def.description
        agent.mode = PRIMARY
        if (def.color !== undefined) agent.color = def.color
        agent.system = systemPrompt

        if (resolved.model.includes("/")) {
          agent.model = Model.Ref.parse(resolved.model) as typeof agent.model
          if (resolved.variant !== undefined && agent.model) {
            agent.model.variant = Model.VariantID.make(resolved.variant)
          }
        }

        const body: Record<string, unknown> = {}
        if (def.temperature !== undefined) body.temperature = def.temperature
        if (def.maxOutputTokens !== undefined) body.max_output_tokens = def.maxOutputTokens
        if (Object.keys(body).length > 0) {
          agent.request.body = { ...agent.request.body, ...body }
        }
      })
      registered.add(def.id)
      options.trace?.("omo.agent.registered", {
        id: def.id,
        mode: PRIMARY,
        model: resolved.model,
        variant: resolved.variant,
        systemLength: systemPrompt.length,
      })
    }

    // Downgrade the built-in `build` agent to a hidden subagent (v1 parity).
    draft.update("build", (agent) => {
      agent.mode = "subagent"
      agent.hidden = true
    })
    options.trace?.("omo.agent.build-downgraded", {})

    // Default to sisyphus unless overridden.
    draft.default(options.defaultAgent ?? "sisyphus")
    options.trace?.("omo.agent.default", { id: options.defaultAgent ?? "sisyphus" })
  })

  return registered
  })
}
