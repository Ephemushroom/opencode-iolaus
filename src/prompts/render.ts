import {
  EXPLORE_PROMPT, MULTIMODAL_LOOKER_PROMPT, buildLibrarianPrompt,
  buildDynamicHephaestusPrompt, isHephaestusSupportedModel, buildSisyphusJuniorPrompt, buildAgentIdentitySection,
  getMetisPrompt, getMomusPromptSelection, getOraclePromptSelection,
  type AvailableAgent, type AvailableCategory, type AvailableSkill, type AvailableTool,
} from "../omo/agents"
import {
  atlasPromptVariants, prometheusPromptVariants, ultraworkPromptVariants,
  HYPERPLAN_MODE_PROMPT, loadPromptSync, resolveVariant,
} from "../omo/modes/src"
import { buildSisyphusPromptForModel } from "./sisyphus-route"
import { CATEGORY_DESCRIPTIONS, type AgentName, type CategoryName, type ModeName } from "./catalog"
import { NATIVE_BINDINGS } from "./native-bindings"
import { TEAM_DAG_MODE_PROMPT } from "./mode-dag"
import { buildHephaestusPrompt } from "../omo/agents/hephaestus/gpt"

export interface PromptContext {
  model: string
  agents?: AvailableAgent[]
  skills?: AvailableSkill[]
  tools?: AvailableTool[]
  categories?: AvailableCategory[]
}

export function renderAgent(name: AgentName, context: PromptContext): string {
  const { model, agents = [], skills = [], tools = [], categories = [] } = context
  switch (name) {
    case "sisyphus": return buildSisyphusPromptForModel(model, agents, tools, skills, categories, false)
    case "hephaestus":
      // Any model runs Hephaestus: GPT models get their tuned variant, others the generic GPT body, which names no model.
      return isHephaestusSupportedModel(model)
        ? buildDynamicHephaestusPrompt({ model, availableAgents: agents, availableSkills: skills, availableTools: tools, availableCategories: categories })
        : `${buildAgentIdentitySection("Hephaestus", "Autonomous deep worker for software engineering from OhMyOpenCode")}\n${buildHephaestusPrompt(agents, tools, skills, categories, false)}`
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

/** Lane contracts the runtime acts on: a deep-low DAG node that ends with the escalation line is rerun on deep-high. */
const CATEGORY_CONTRACTS: Partial<Record<CategoryName, string>> = {
  "deep-low": `If the goal's central decision cannot be settled from what you can read and run (a trade-off, a contract across a package or process boundary, a mechanism with no pattern in the repository, correctness that must be argued from invariants), stop before guessing: report your findings, then end your reply with the line "ESCALATE: deep-high". The goal is then rerun on the deep-high lane with your findings.`,
}

export function renderCategory(name: CategoryName, model: string): string {
  const contract = CATEGORY_CONTRACTS[name]
  const append = `<Category_Context name="${name}">\n${CATEGORY_DESCRIPTIONS[name]}${contract ? `\n${contract}` : ""}\n</Category_Context>`
  return buildSisyphusJuniorPrompt(model, false, append)
}

export function renderMode(mode: ModeName, model: string, agent?: AgentName): string {
  if (mode === "hyperplan") return HYPERPLAN_MODE_PROMPT
  if (mode === "team") return TEAM_DAG_MODE_PROMPT
  const variant = resolveVariant({ modelID: model, agentName: agent, variants: ultraworkPromptVariants }) as keyof typeof ultraworkPromptVariants
  return loadPromptSync({ source: ultraworkPromptVariants[variant], name: mode, variant }).body
}

export function bindNative(prompt: string, homeText?: string): string {
  return `${prompt}\n\n${NATIVE_BINDINGS}${homeText ? `\n${homeText}` : ""}`
}
