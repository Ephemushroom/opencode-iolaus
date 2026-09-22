import { AGENT_NAMES, MODE_NAMES, type AgentName, type ModeName } from "./prompts/catalog"

export interface Options {
  enabled: boolean
  agents: AgentName[]
  modes: ModeName[]
}

function selection<T extends string>(value: unknown, allowed: readonly T[], name: string): T[] {
  if (value === undefined) return [...allowed]
  if (!Array.isArray(value) || value.some((item) => !allowed.includes(item))) {
    throw new TypeError(`Iolaus ${name} must contain only: ${allowed.join(", ")}`)
  }
  return [...new Set<T>(value)]
}

export function parseOptions(input: Record<string, unknown>): Options {
  const unknown = Object.keys(input).filter((key) => !["enabled", "agents", "modes"].includes(key))
  if (unknown.length) throw new TypeError(`Unknown Iolaus options: ${unknown.join(", ")}`)
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new TypeError("Iolaus enabled must be a boolean")
  }
  return {
    enabled: input.enabled !== false,
    agents: selection(input.agents, AGENT_NAMES, "agents"),
    modes: selection(input.modes, MODE_NAMES, "modes"),
  }
}
