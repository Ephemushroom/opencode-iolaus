import { parseModelsConfig } from "../src/models"
import { AGENT_NAMES, CATEGORY_NAMES } from "../src/prompts/catalog"

/** Iolaus is config-first: only configured lanes register, so registration tests configure every lane. */
export const ALL_LANES = parseModelsConfig({
  agents: Object.fromEntries(AGENT_NAMES.map((name) => [name, name === "sisyphus" ? "anthropic/claude-opus-5-5#max" : "openai/gpt-5.5"])),
  categories: Object.fromEntries(CATEGORY_NAMES.map((name) => [name, "openai/gpt-5.5"])),
})
