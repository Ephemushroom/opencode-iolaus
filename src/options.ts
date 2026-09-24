import { AGENT_NAMES, CATEGORY_NAMES, MODE_NAMES, type AgentName, type CategoryName, type ModeName } from "./prompts/catalog"

export interface Options {
  enabled: boolean
  agents: AgentName[]
  categories: CategoryName[]
  modes: ModeName[]
  /** Register the `ast_grep` Code Mode tools when an ast-grep binary is available. */
  astGrep: boolean
  /** Inline models config, merged after `.iolaus/models.json` layers. */
  models?: unknown
}

function selection<T extends string>(value: unknown, allowed: readonly T[], name: string): T[] {
  if (value === undefined) return [...allowed]
  if (!Array.isArray(value) || value.some((item) => !allowed.includes(item))) {
    throw new TypeError(`Iolaus ${name} must contain only: ${allowed.join(", ")}`)
  }
  return [...new Set<T>(value)]
}

export function parseOptions(input: Record<string, unknown>): Options {
  const unknown = Object.keys(input).filter((key) => !["enabled", "agents", "categories", "modes", "models", "astGrep"].includes(key))
  if (unknown.length) throw new TypeError(`Unknown Iolaus options: ${unknown.join(", ")}`)
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new TypeError("Iolaus enabled must be a boolean")
  }
  if (input.astGrep !== undefined && typeof input.astGrep !== "boolean") {
    throw new TypeError("Iolaus astGrep must be a boolean")
  }
  return {
    enabled: input.enabled !== false,
    agents: selection(input.agents, AGENT_NAMES, "agents"),
    categories: selection(input.categories, CATEGORY_NAMES, "categories"),
    modes: selection(input.modes, MODE_NAMES, "modes"),
    astGrep: input.astGrep !== false,
    ...(input.models === undefined ? {} : { models: input.models }),
  }
}
