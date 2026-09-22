import {
  buildClaudeFable5SisyphusPrompt,
  buildClaudeOpus47SisyphusPrompt,
  buildClaudeOpus48SisyphusPrompt,
  buildClaudeOpus5SisyphusPrompt,
  buildFallbackSisyphusPrompt,
  buildGlm52SisyphusPrompt,
  buildGpt54SisyphusPrompt,
  buildGpt55SisyphusPrompt,
  buildKimiK26SisyphusPrompt,
  buildKimiK27SisyphusPrompt,
  buildKimiK3SisyphusPrompt,
  isClaudeFable5Model,
  isClaudeOpus47Model,
  isClaudeOpus48Model,
  isClaudeOpus5Model,
  isGlmModel,
  isGpt5_5Model,
  isGpt5_6Model,
  isGptNativeSisyphusModel,
  isKimiK2Model,
  isKimiK27Model,
  isKimiK3Model,
} from "@oh-my-opencode/agents-core"
import type { AvailableAgent, AvailableCategory, AvailableSkill, AvailableTool } from "@oh-my-opencode/agents-core"

/**
 * Builds the Sisyphus system prompt for a resolved model, threading the live
 * agent/tool/skill/category lists through the model-family prompt builder.
 * Mirrors v1's resolveSisyphusPromptFamily ordering; the family-specific
 * builders live in agents-core.
 */
export function buildSisyphusPromptForModel(
  model: string,
  availableAgents: AvailableAgent[],
  availableTools: AvailableTool[],
  availableSkills: AvailableSkill[],
  availableCategories: AvailableCategory[],
  useTaskSystem: boolean,
): string {
  if (isKimiK3Model(model)) return buildKimiK3SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  if (isKimiK27Model(model)) return buildKimiK27SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  if (isKimiK2Model(model)) return buildKimiK26SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  if (isGpt5_5Model(model) || isGpt5_6Model(model)) return buildGpt55SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  if (isGptNativeSisyphusModel(model)) return buildGpt54SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  if (isClaudeFable5Model(model)) return buildClaudeFable5SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  if (isClaudeOpus5Model(model)) return buildClaudeOpus5SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  if (isClaudeOpus48Model(model)) return buildClaudeOpus48SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  if (isClaudeOpus47Model(model)) return buildClaudeOpus47SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  if (isGlmModel(model)) return buildGlm52SisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
  return buildFallbackSisyphusPrompt(model, availableAgents, availableTools, availableSkills, availableCategories, useTaskSystem)
}
