import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent, Model } from "@opencode/plugin"
import { buildSisyphusJuniorPrompt } from "@oh-my-opencode/agents-core"
import { CATEGORY_MODEL_REQUIREMENTS } from "@oh-my-opencode/model-core"
import type { OpenCode2AgentOverride } from "../config"

import { resolveAgentModel } from "./model-resolution"
import type { CatalogSource } from "./model-resolution"
import { Effect } from "effect"

/**
 * Category descriptions. These are the v2-facing one-liners for each delegation
 * category; the authoritative fallback chains live in model-core's
 * CATEGORY_MODEL_REQUIREMENTS.
 */
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  "visual-engineering": "Frontend, UI/UX, design, styling, animation",
  ultrabrain: "Hard logic, architecture decisions, algorithms",
  deep: "Autonomous research + end-to-end implementation on hairy problems",
  artistry: "Complex problem-solving with unconventional, creative approaches",
  quick: "Trivial tasks - single file changes, typo fixes, simple modifications",
  "unspecified-low": "Tasks that don't fit other categories, low effort required",
  "unspecified-high": "Tasks that don't fit other categories, high effort required",
  writing: "Documentation, prose, technical writing",
}

/**
 * Register each delegation category as a dispatchable subagent so the native v2
 * `subagent` tool (and the omo `task` tool in Phase 2) can target a category by
 * name. The system prompt is the sisyphus-junior executor base; category
 * promptAppend joins in Phase 6 (config chain).
 *
 * Returns the category names actually registered.
 */
export function registerCategories(
  ctx: { readonly agent: Pick<Context["agent"], "transform"> },
  options: {
    catalog: CatalogSource;
    systemDefaultModel?: string;
    agentOverrides?: Record<string, OpenCode2AgentOverride>;
    trace?: (event: string, detail?: Record<string, unknown>) => void;
  },
): Effect.Effect<Set<string>, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
  const registered = new Set<string>()

  yield* ctx.agent.transform((draft) => {
    const snapshot = options.catalog.current
    const effectiveDefault = options.systemDefaultModel ?? snapshot.systemDefaultModel
    for (const [name, requirement] of Object.entries(CATEGORY_MODEL_REQUIREMENTS)) {
      const resolved = resolveAgentModel(requirement, snapshot, effectiveDefault, options.agentOverrides?.[name])
      if (!resolved) continue

      const systemPrompt = buildSisyphusJuniorPrompt(resolved.model, false)
      draft.update(name, (agent) => {
        agent.name = Agent.Name.make(name)
        agent.description = CATEGORY_DESCRIPTIONS[name] ?? "Delegated task category"
        agent.mode = "subagent"
        agent.system = systemPrompt

        if (resolved.model.includes("/")) {
          agent.model = Model.Ref.parse(resolved.model) as typeof agent.model
          if (resolved.variant !== undefined && agent.model) {
            agent.model.variant = Model.VariantID.make(resolved.variant)
          }
        }
      })
      registered.add(name)
      options.trace?.("omo.category.registered", {
        id: name,
        mode: "subagent",
        model: resolved.model,
        variant: resolved.variant,
        systemLength: systemPrompt.length,
      })
    }
  })

  return registered
  })
}
