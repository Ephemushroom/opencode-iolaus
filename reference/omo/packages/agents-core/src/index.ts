// @oh-my-opencode/agents-core
// Harness-agnostic agent prompt builders, model-family prompt routing, and
// agent metadata shared across harness adapters. Populated incrementally by the
// Phase 1 extraction (pure move from packages/omo-opencode/src/agents).
export * from "./types"
export * from "./dynamic-agent-prompt-builder"
export { GPT_APPLY_PATCH_GUIDANCE, GPT_FILE_EDIT_GUIDANCE } from "./gpt-apply-patch-guard"
export * from "./gpt-prompt-identity"
export { resolvePromptAppend } from "./builtin-agents/resolve-file-uri"
export * from "./sisyphus"
export { buildFallbackSisyphusPrompt } from "./sisyphus-dynamic-prompt"
export { applyGeminiFallbackOverrides } from "./sisyphus-gemini-fallback-overrides"
export { KIMI_TOOL_LOOP_GUARD } from "./kimi-tool-loop-guard"
export * from "./sisyphus-junior"
export {
  getHephaestusPrompt,
  getHephaestusPromptSource,
  buildDynamicHephaestusPrompt,
  isHephaestusSupportedModel,
  UnsupportedHephaestusModelError,
} from "./hephaestus/prompt-router"
export type { HephaestusContext, HephaestusPromptSource } from "./hephaestus/prompt-router"

// Specialist agent prompts + metadata (oracle / librarian / explore / metis / momus / multimodal-looker)
export { EXPLORE_PROMPT, EXPLORE_AGENT_DESCRIPTION, EXPLORE_PROMPT_METADATA } from "./specialists/explore-prompt"
export {
  MULTIMODAL_LOOKER_PROMPT,
  MULTIMODAL_LOOKER_AGENT_DESCRIPTION,
  MULTIMODAL_LOOKER_PROMPT_METADATA,
} from "./specialists/multimodal-looker-prompt"
export { buildLibrarianPrompt, LIBRARIAN_AGENT_DESCRIPTION, LIBRARIAN_PROMPT_METADATA } from "./specialists/librarian-prompt"
export {
  METIS_SYSTEM_PROMPT,
  METIS_K2_7_SYSTEM_PROMPT,
  METIS_AGENT_DESCRIPTION,
  getMetisPrompt,
  metisPromptMetadata,
} from "./specialists/metis-prompt"
export {
  MOMUS_SYSTEM_PROMPT,
  MOMUS_AGENT_DESCRIPTION,
  getMomusPromptSelection,
  momusPromptMetadata,
} from "./specialists/momus-prompt"
export type { MomusPromptSelection } from "./specialists/momus-prompt"
export { MOMUS_GPT_5_6_PROMPT } from "./specialists/momus-gpt-5-6"
export {
  ORACLE_AGENT_DESCRIPTION,
  getOraclePromptSelection,
  ORACLE_PROMPT_METADATA,
} from "./specialists/oracle-prompt"
export type { OraclePromptSelection } from "./specialists/oracle-prompt"
