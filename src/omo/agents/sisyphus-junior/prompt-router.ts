/**
 * Sisyphus-Junior model-family prompt routing (pure).
 *
 * Routing:
 * 1. Kimi K3 -> kimi-k3.ts (K3-native executor; reasoning depth with built-in stop conditions)
 * 2. Kimi K2.7 -> kimi-k2-7.ts (restrained, outcome-first)
 * 3. Kimi K2.x -> kimi-k2-6.ts
 * 4. GPT models (openai/*, github-copilot/gpt-*) -> gpt-5-5.ts / gpt-5-4.ts / gpt.ts
 * 5. Gemini models (google/*, google-vertex/*) -> gemini.ts (Gemini-optimized)
 * 6. GLM models -> glm-5-2.ts
 * 7. Default (Claude, etc.) -> default.ts (Claude-optimized)
 */

import { isGlmModel, isGpt5_5Model, isGpt5_6Model, isGpt6Model, isGptModel, isGeminiModel, isKimiK2Model, isKimiK27Model, isKimiK3Model } from "../types"

import { buildDefaultSisyphusJuniorPrompt } from "./default"
import { buildKimiK26SisyphusJuniorPrompt } from "./kimi-k2-6"
import { buildKimiK27SisyphusJuniorPrompt } from "./kimi-k2-7"
import { buildKimiK3SisyphusJuniorPrompt } from "./kimi-k3"
import { buildGptSisyphusJuniorPrompt } from "./gpt"
import { buildGpt54SisyphusJuniorPrompt } from "./gpt-5-4"
import { buildGpt55SisyphusJuniorPrompt } from "./gpt-5-5"
import { buildGeminiSisyphusJuniorPrompt } from "./gemini"
import { buildGlm52SisyphusJuniorPrompt } from "./glm-5-2"

export const SISYPHUS_JUNIOR_DEFAULTS = {
  model: "anthropic/claude-sonnet-5",
  temperature: 0.1,
} as const

export type SisyphusJuniorPromptSource =
  | "default"
  | "kimi-k2"
  | "kimi-k2-7"
  | "kimi-k3"
  | "gpt"
  | "gpt-5-5"
  | "gpt-5-4"
  | "gemini"
  | "glm-5-2"

export function getSisyphusJuniorPromptSource(model?: string): SisyphusJuniorPromptSource {
  if (model && isKimiK3Model(model)) return "kimi-k3"
  if (model && isKimiK27Model(model)) return "kimi-k2-7"
  if (model && isKimiK2Model(model)) return "kimi-k2"
  if (model && isGptModel(model)) {
    if (isGpt5_5Model(model) || isGpt5_6Model(model) || isGpt6Model(model)) return "gpt-5-5"
    const lower = model.toLowerCase()
    if (lower.includes("gpt-5.4") || lower.includes("gpt-5-4")) return "gpt-5-4"
    return "gpt"
  }
  if (model && isGeminiModel(model)) {
    return "gemini"
  }
  if (model && isGlmModel(model)) return "glm-5-2"
  return "default"
}

/**
 * Builds the appropriate Sisyphus-Junior prompt based on model.
 */
export function buildSisyphusJuniorPrompt(
  model: string | undefined,
  useTaskSystem: boolean,
  promptAppend?: string
): string {
  const source = getSisyphusJuniorPromptSource(model)

  switch (source) {
    case "kimi-k3":
      return buildKimiK3SisyphusJuniorPrompt(useTaskSystem, promptAppend)
    case "kimi-k2-7":
      return buildKimiK27SisyphusJuniorPrompt(useTaskSystem, promptAppend)
    case "kimi-k2":
      return buildKimiK26SisyphusJuniorPrompt(useTaskSystem, promptAppend)
    case "gpt-5-5":
      return buildGpt55SisyphusJuniorPrompt(useTaskSystem, promptAppend, model)
    case "gpt-5-4":
      return buildGpt54SisyphusJuniorPrompt(useTaskSystem, promptAppend)
    case "gpt":
      return buildGptSisyphusJuniorPrompt(useTaskSystem, promptAppend)
    case "gemini":
      return buildGeminiSisyphusJuniorPrompt(useTaskSystem, promptAppend)
    case "glm-5-2":
      return buildGlm52SisyphusJuniorPrompt(useTaskSystem, promptAppend)
    case "default":
    default:
      return buildDefaultSisyphusJuniorPrompt(useTaskSystem, promptAppend)
  }
}
