import {
  EXPLORE_PROMPT_METADATA,
  LIBRARIAN_PROMPT_METADATA,
  MULTIMODAL_LOOKER_PROMPT_METADATA,
  ORACLE_PROMPT_METADATA,
  metisPromptMetadata,
  momusPromptMetadata,
} from "@oh-my-opencode/agents-core"
import type { AgentPromptMetadata } from "@oh-my-opencode/agents-core"

/**
 * The delegable specialists whose AgentPromptMetadata feeds the Sisyphus
 * dynamic prompt sections (Delegation Table / Tool Selection / Key Triggers).
 *
 * Exactly six: the v1 adapter exposed these in Sisyphus's prompt. Primaries
 * (sisyphus/hephaestus/prometheus/atlas), the executor (sisyphus-junior), and
 * categories are intentionally absent — categories are derived separately from
 * CATEGORY_MODEL_REQUIREMENTS.
 */
export const SISYPHUS_SPECIALIST_IDS = [
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "metis",
  "momus",
] as const

export type SisyphusSpecialistID = (typeof SISYPHUS_SPECIALIST_IDS)[number]

export const SISYPHUS_SPECIALIST_METADATA: Record<SisyphusSpecialistID, AgentPromptMetadata> = {
  oracle: ORACLE_PROMPT_METADATA,
  librarian: LIBRARIAN_PROMPT_METADATA,
  explore: EXPLORE_PROMPT_METADATA,
  "multimodal-looker": MULTIMODAL_LOOKER_PROMPT_METADATA,
  metis: metisPromptMetadata,
  momus: momusPromptMetadata,
}

