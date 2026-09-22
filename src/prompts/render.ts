import {
  EXPLORE_PROMPT, MULTIMODAL_LOOKER_PROMPT, buildLibrarianPrompt,
  buildDynamicHephaestusPrompt, isHephaestusSupportedModel, buildSisyphusJuniorPrompt,
  getMetisPrompt, getMomusPromptSelection, getOraclePromptSelection,
  type AvailableAgent, type AvailableSkill, type AvailableTool,
} from "../omo/agents"
import {
  atlasPromptVariants, prometheusPromptVariants, ultraworkPromptVariants,
  HYPERPLAN_MODE_PROMPT, TEAM_MODE_PROMPT, loadPromptSync, resolveVariant,
} from "../omo/modes/src"
import { buildSisyphusPromptForModel } from "./sisyphus-route"
import type { AgentName, ModeName } from "./catalog"
import { NATIVE_BINDINGS } from "./native-bindings"

export interface PromptContext {
  model: string
  agents?: AvailableAgent[]
  skills?: AvailableSkill[]
  tools?: AvailableTool[]
}

export function renderAgent(name: AgentName, context: PromptContext): string {
  const { model, agents = [], skills = [], tools = [] } = context
  switch (name) {
    case "sisyphus": return buildSisyphusPromptForModel(model, agents, tools, skills, [], false)
    case "hephaestus":
      return isHephaestusSupportedModel(model)
        ? buildDynamicHephaestusPrompt({ model, availableAgents: agents, availableSkills: skills, availableTools: tools })
        : buildSisyphusJuniorPrompt(model, false)
    case "sisyphus-junior": return buildSisyphusJuniorPrompt(model, false)
    case "explore": return EXPLORE_PROMPT
    case "librarian": return buildLibrarianPrompt()
    case "multimodal-looker": return MULTIMODAL_LOOKER_PROMPT
    case "metis": return getMetisPrompt(model)
    case "momus": return getMomusPromptSelection(model).prompt
    case "oracle": return getOraclePromptSelection(model).prompt
    case "prometheus": return loadPromptSync({ source: prometheusPromptVariants.default, name, variant: "default" }).body
    case "atlas": {
      const variant = resolveVariant({ modelID: model, agentName: name, variants: atlasPromptVariants }) as keyof typeof atlasPromptVariants
      return loadPromptSync({ source: atlasPromptVariants[variant], name, variant }).body
    }
  }
}

export function renderMode(mode: ModeName, model: string, agent?: AgentName): string {
  if (mode === "hyperplan") return HYPERPLAN_MODE_PROMPT
  if (mode === "team") return TEAM_MODE_PROMPT
  const variant = resolveVariant({ modelID: model, agentName: agent, variants: ultraworkPromptVariants }) as keyof typeof ultraworkPromptVariants
  return loadPromptSync({ source: ultraworkPromptVariants[variant], name: mode, variant }).body
}

export function bindNative(prompt: string): string {
  return `${prompt}\n\n${NATIVE_BINDINGS}`
}
