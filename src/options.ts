import { MCP_NAMES, type McpName } from "./mcp"
import { AGENT_NAMES, CATEGORY_NAMES, MODE_NAMES, type AgentName, type CategoryName, type ModeName } from "./prompts/catalog"

export interface Options {
  enabled: boolean
  agents: AgentName[]
  categories: CategoryName[]
  modes: ModeName[]
  /** Register the `ast_grep` Code Mode tools when an ast-grep binary is available. */
  astGrep: boolean
  /** Built-in remote MCP servers to register unless the user already defines the same name. `[]` disables them. */
  mcps: McpName[]
  /** Post-edit verification: `false` disables; an object configures checkers. */
  verify: boolean | Record<string, unknown>
  /** Register the read-only `gh` Code Mode tools when an authenticated gh CLI is available. */
  gh: boolean
  /** `background_task.defaultConcurrency`: most DAG nodes one run may execute at once; a run's own `maxParallel` can only lower it. */
  defaultConcurrency: number
}

function selection<T extends string>(value: unknown, allowed: readonly T[], name: string): T[] {
  if (value === undefined) return [...allowed]
  if (!Array.isArray(value) || value.some((item) => !allowed.includes(item))) {
    throw new TypeError(`Iolaus ${name} must contain only: ${allowed.join(", ")}`)
  }
  return [...new Set<T>(value)]
}

export function parseOptions(input: Record<string, unknown>): Options {
  const unknown = Object.keys(input).filter((key) => !["enabled", "agents", "categories", "modes", "models", "astGrep", "mcps", "verify", "gh", "background_task"].includes(key))
  if (unknown.length) throw new TypeError(`Unknown Iolaus options: ${unknown.join(", ")}`)
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new TypeError("Iolaus enabled must be a boolean")
  }
  if (input.astGrep !== undefined && typeof input.astGrep !== "boolean") {
    throw new TypeError("Iolaus astGrep must be a boolean")
  }
  if (input.gh !== undefined && typeof input.gh !== "boolean") {
    throw new TypeError("Iolaus gh must be a boolean")
  }
  const background = input.background_task
  if (background !== undefined) {
    if (typeof background !== "object" || background === null || Array.isArray(background)) throw new TypeError("Iolaus background_task must be an object")
    const unknownBackground = Object.keys(background).filter((key) => key !== "defaultConcurrency")
    if (unknownBackground.length) throw new TypeError(`Unknown Iolaus background_task options: ${unknownBackground.join(", ")}`)
    const concurrency = (background as Record<string, unknown>).defaultConcurrency
    if (concurrency !== undefined && (!Number.isInteger(concurrency) || (concurrency as number) < 1)) {
      throw new TypeError("Iolaus background_task.defaultConcurrency must be a positive integer")
    }
  }
  if (input.verify !== undefined && typeof input.verify !== "boolean" && (typeof input.verify !== "object" || input.verify === null || Array.isArray(input.verify))) {
    throw new TypeError("Iolaus verify must be a boolean or an object")
  }
  return {
    enabled: input.enabled !== false,
    agents: selection(input.agents, AGENT_NAMES, "agents"),
    categories: selection(input.categories, CATEGORY_NAMES, "categories"),
    modes: selection(input.modes, MODE_NAMES, "modes"),
    astGrep: input.astGrep !== false,
    gh: input.gh !== false,
    mcps: selection(input.mcps, MCP_NAMES, "mcps"),
    verify: input.verify === undefined ? true : (input.verify as boolean | Record<string, unknown>),
    defaultConcurrency: ((background as { defaultConcurrency?: number } | undefined)?.defaultConcurrency) ?? 5,
  }
}
