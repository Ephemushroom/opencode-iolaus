import {
  buildClaudeFable5SisyphusPrompt,
  buildClaudeOpus47SisyphusPrompt,
  buildClaudeOpus48SisyphusPrompt,
  buildClaudeOpus5SisyphusPrompt,
  buildClaudeOpus55SisyphusPrompt,
  buildFallbackSisyphusPrompt,
  buildGlm52SisyphusPrompt,
  buildGpt54SisyphusPrompt,
  buildGpt55SisyphusPrompt,
  buildGpt6AstraSisyphusPrompt,
  buildGrok4SisyphusPrompt,
  buildKimiK26SisyphusPrompt,
  buildKimiK27SisyphusPrompt,
  buildKimiK3SisyphusPrompt,
  isGptNativeSisyphusModel,
  isGrok45Model,
  isGrok46Model,
  isKimiK2CodeModel,
  isKimiK2Model,
  isKimiK3Model,
} from "../omo/agents"
import type { AvailableAgent, AvailableCategory, AvailableSkill, AvailableTool } from "../omo/agents"
import { resolvePromptLane } from "./prompt-lanes"

type Builder = (
  model: string,
  agents: AvailableAgent[],
  tools: AvailableTool[],
  skills: AvailableSkill[],
  categories: AvailableCategory[],
  useTaskSystem: boolean,
) => string

/**
 * Table-routed variants. A lane here is chosen by `resolvePromptLane`, which
 * knows vendor, class and version, so two releases of one class get their own
 * prompt (`claude-opus-5` vs `claude-opus-5-5`) and a new model resolves to the
 * nearest version inside its own class instead of landing on the generic body.
 */
const LANE_BUILDERS: Readonly<Record<string, Builder>> = {
  "claude-opus-4-7": buildClaudeOpus47SisyphusPrompt,
  "claude-opus-4-8": buildClaudeOpus48SisyphusPrompt,
  "claude-opus-5": buildClaudeOpus5SisyphusPrompt,
  "claude-opus-5-5": buildClaudeOpus55SisyphusPrompt,
  "claude-fable-5": buildClaudeFable5SisyphusPrompt,
  "gpt-6-astra": buildGpt6AstraSisyphusPrompt,
  "gpt-5-4": buildGpt54SisyphusPrompt,
  "gpt-5-5": buildGpt55SisyphusPrompt,
}

/**
 * Builds the Sisyphus system prompt for a resolved model.
 *
 * Order: the table first (Anthropic and OpenAI classes), then the families the
 * table does not model — Kimi, GLM, Grok, GPT-5.3/5.4 — and finally the
 * generic body for anything unrecognised.
 */
export function buildSisyphusPromptForModel(
  model: string,
  availableAgents: AvailableAgent[],
  availableTools: AvailableTool[],
  availableSkills: AvailableSkill[],
  availableCategories: AvailableCategory[],
  useTaskSystem: boolean,
): string {
  const build = (builder: Builder) => builder(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  const lane = resolvePromptLane(model)
  if (lane) return build(LANE_BUILDERS[lane.lane] ?? buildGpt55SisyphusPrompt)
  if (isKimiK3Model(model)) return build(buildKimiK3SisyphusPrompt)
  if (isKimiK2CodeModel(model)) return build(buildKimiK27SisyphusPrompt)
  if (isKimiK2Model(model)) return build(buildKimiK26SisyphusPrompt)
  if (isGptNativeSisyphusModel(model)) return build(buildGpt54SisyphusPrompt)
  if (isGrok45Model(model) || isGrok46Model(model)) return build(buildGrok4SisyphusPrompt)
  if (model.toLowerCase().includes("glm")) return build(buildGlm52SisyphusPrompt)
  return build(buildFallbackSisyphusPrompt)
}
