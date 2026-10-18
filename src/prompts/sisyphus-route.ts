import {
  buildClaudeFable5SisyphusPrompt,
  buildClaudeOpus47SisyphusPrompt,
  buildClaudeOpus48SisyphusPrompt,
  buildClaudeOpus5SisyphusPrompt,
  buildClaudeOpus55SisyphusPrompt,
  buildFallbackSisyphusPrompt,
  buildGpt54SisyphusPrompt,
  buildGpt55SisyphusPrompt,
  buildGpt6AstraSisyphusPrompt,
  buildGrok4SisyphusPrompt,
  isGptNativeSisyphusModel,
  isGrok45Model,
  isGrok46Model,
} from "../omo/agents"
import type { AvailableAgent, AvailableCategory, AvailableSkill, AvailableTool } from "../omo/agents"
import { identifyModel, resolvePromptIdiom, resolvePromptLane } from "./prompt-lanes"

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
 * Order: the table first (Anthropic and OpenAI classes). A model the table does
 * not name is addressed in its idiom: GLM, Kimi and DeepSeek currently borrow the
 * Anthropic body, so they get the same Claude-shaped prompt as an Opus model
 * instead of their own retained variant. Grok and native GPT models keep their
 * own bodies; anything unrecognised gets the generic one.
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
  const idiom = resolvePromptIdiom(model)
  // Borrowing is only for non-Anthropic vendors. An Anthropic model the table
  // does not name (Sonnet, Haiku) keeps the generic body: the Opus 5 body carries
  // Opus-specific tuning and a self-knowledge block that would name the wrong model.
  if (idiom === "anthropic" && identifyModel(model).vendor !== "anthropic") return build(buildClaudeOpus5SisyphusPrompt)
  if (isGrok45Model(model) || isGrok46Model(model)) return build(buildGrok4SisyphusPrompt)
  if (isGptNativeSisyphusModel(model)) return build(buildGpt54SisyphusPrompt)
  return build(buildFallbackSisyphusPrompt)
}
