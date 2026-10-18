import type { VariantTable } from "./types"
import anthropicPrompt from "../prompts/atlas/anthropic.md"
import defaultPrompt from "../prompts/atlas/default.md"
import geminiPrompt from "../prompts/atlas/gemini.md"
import glmPrompt from "../prompts/atlas/glm.md"
import gptPrompt from "../prompts/atlas/gpt.md"
import kimiPrompt from "../prompts/atlas/kimi.md"
import kimiK27Prompt from "../prompts/atlas/kimi-k2-7.md"
import kimiK3Prompt from "../prompts/atlas/kimi-k3.md"
import opus47Prompt from "../prompts/atlas/opus-4-7.md"

export const atlasPromptVariants = {
  // Anthropic-idiom body: XML sections, no "Final Verification Wave" or
  // MUST-register, and the ticket session is the primary case. Opus 4.7 keeps
  // its own retained variant; every other model whose idiom resolves to
  // Anthropic - Opus 5/5.5, Fable, and the GLM/Kimi/DeepSeek carriers that
  // borrow the idiom - reads this one.
  anthropic: {
    kind: "bundled",
    content: anthropicPrompt,
    filePath: "packages/prompts-core/prompts/atlas/anthropic.md",
  },
  "opus-4-7": {
    kind: "bundled",
    content: opus47Prompt,
    filePath: "packages/prompts-core/prompts/atlas/opus-4-7.md",
  },
  gpt: {
    kind: "bundled",
    content: gptPrompt,
    filePath: "packages/prompts-core/prompts/atlas/gpt.md",
  },
  gemini: {
    kind: "bundled",
    content: geminiPrompt,
    filePath: "packages/prompts-core/prompts/atlas/gemini.md",
  },
  "kimi-k3": {
    kind: "bundled",
    content: kimiK3Prompt,
    filePath: "packages/prompts-core/prompts/atlas/kimi-k3.md",
  },
  "kimi-k2-7": {
    kind: "bundled",
    content: kimiK27Prompt,
    filePath: "packages/prompts-core/prompts/atlas/kimi-k2-7.md",
  },
  kimi: {
    kind: "bundled",
    content: kimiPrompt,
    filePath: "packages/prompts-core/prompts/atlas/kimi.md",
  },
  glm: {
    kind: "bundled",
    content: glmPrompt,
    filePath: "packages/prompts-core/prompts/atlas/glm.md",
  },
  default: {
    kind: "bundled",
    content: defaultPrompt,
    filePath: "packages/prompts-core/prompts/atlas/default.md",
  },
} satisfies VariantTable
