import {
  AGENT_MODEL_REQUIREMENTS,
  CATEGORY_MODEL_REQUIREMENTS,
  transformModelForProvider,
  type FallbackEntry,
  type ModelRequirement,
} from "@iolaus/model-core"
import { AGENT_NAMES, CATEGORY_NAMES, type AgentName, type CategoryName } from "./prompts/catalog"

export type LaneName = AgentName | CategoryName

export interface ModelChoice {
  readonly model: string
  readonly variant?: string
}

export interface LaneAssignment extends ModelChoice {
  readonly lane: LaneName
  readonly source: "config" | "requirement"
}

export type ModelOverride = string | { readonly model: string; readonly variant?: string }

/**
 * Model overrides from the global iolaus.json file.
 * Values are "provider/model", "provider/model#variant" or {model, variant}.
 */
export interface ModelsConfig {
  readonly agents?: Readonly<Record<string, ModelOverride>>
  readonly categories?: Readonly<Record<string, ModelOverride>>
}

export function parseModelOverride(value: unknown, path: string): ModelChoice {
  if (typeof value === "string") {
    const hash = value.indexOf("#")
    const model = hash === -1 ? value : value.slice(0, hash)
    const variant = hash === -1 ? undefined : value.slice(hash + 1)
    if (!model.includes("/") || model.startsWith("/") || model.endsWith("/") || variant === "") {
      throw new TypeError(`${path} must be "provider/model" or "provider/model#variant"`)
    }
    return variant === undefined ? { model } : { model, variant }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const unknown = Object.keys(record).filter((key) => key !== "model" && key !== "variant")
    if (unknown.length) throw new TypeError(`Unknown ${path} keys: ${unknown.join(", ")}`)
    if (typeof record.model !== "string" || !record.model.includes("/") || record.model.startsWith("/") || record.model.endsWith("/")) throw new TypeError(`${path}.model must be "provider/model"`)
    if (record.variant !== undefined && (typeof record.variant !== "string" || record.variant === "")) throw new TypeError(`${path}.variant must be a nonempty string`)
    return record.variant === undefined ? { model: record.model } : { model: record.model, variant: record.variant as string }
  }
  throw new TypeError(`${path} must be a string or {model, variant}`)
}

function parseSection(value: unknown, section: string, allowed: readonly string[]): Record<string, ModelOverride> {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${section} must be an object`)
  const result: Record<string, ModelOverride> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${section} name: ${key}`)
    parseModelOverride(entry, `${section}.${key}`)
    result[key] = entry as ModelOverride
  }
  return result
}

export function parseModelsConfig(input: unknown): ModelsConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("models config must be an object")
  const record = input as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => key !== "agents" && key !== "categories")
  if (unknown.length) throw new TypeError(`Unknown models config keys: ${unknown.join(", ")}`)
  return {
    agents: parseSection(record.agents, "agents", AGENT_NAMES),
    categories: parseSection(record.categories, "categories", CATEGORY_NAMES),
  }
}

/**
 * Iolaus follows the configured chain without checking provider connectivity
 * or subscription: the first chain entry is the lane's model. Global
 * iolaus.json overrides it per agent or category.
 */
export function firstChainChoice(requirement: ModelRequirement | undefined): ModelChoice | undefined {
  const entry: FallbackEntry | undefined = requirement?.fallbackChain[0]
  const provider = entry?.providers[0]
  if (!entry || !provider) return undefined
  const model = `${provider}/${transformModelForProvider(provider, entry.model)}`
  const variant = entry.variant ?? requirement?.variant
  return variant === undefined ? { model } : { model, variant }
}

export function resolveLane(lane: LaneName, config: ModelsConfig): LaneAssignment | undefined {
  const isCategory = (CATEGORY_NAMES as readonly string[]).includes(lane)
  const override = isCategory ? config.categories?.[lane] : config.agents?.[lane]
  if (override !== undefined) return { lane, source: "config", ...parseModelOverride(override, lane) }
  const requirement = isCategory ? CATEGORY_MODEL_REQUIREMENTS[lane] : AGENT_MODEL_REQUIREMENTS[lane]
  const choice = firstChainChoice(requirement)
  return choice ? { lane, source: "requirement", ...choice } : undefined
}

export function modelString(choice: ModelChoice): string {
  return choice.variant ? `${choice.model}#${choice.variant}` : choice.model
}
