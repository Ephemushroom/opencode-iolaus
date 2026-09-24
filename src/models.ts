import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
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
 * `.iolaus/models.json` (project, walking up to the home boundary) and
 * `~/.iolaus/models.json` (user). Project layers override user layers; later
 * project directories override earlier ones. Keys are agent or category names.
 * Values are "provider/model", "provider/model#variant" or {model, variant}.
 */
export interface ModelsConfig {
  readonly agents?: Readonly<Record<string, ModelOverride>>
  readonly categories?: Readonly<Record<string, ModelOverride>>
}

export interface LoadedModelsConfig {
  readonly config: ModelsConfig
  readonly sources: readonly string[]
  readonly diagnostics: readonly string[]
}

export const MODELS_CONFIG_FILE = "models.json"

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
    if (typeof record.model !== "string" || !record.model.includes("/")) throw new TypeError(`${path}.model must be "provider/model"`)
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

function mergeConfigs(layers: readonly ModelsConfig[]): ModelsConfig {
  const agents: Record<string, ModelOverride> = {}
  const categories: Record<string, ModelOverride> = {}
  for (const layer of layers) {
    Object.assign(agents, layer.agents ?? {})
    Object.assign(categories, layer.categories ?? {})
  }
  return { agents, categories }
}

export function loadModelsConfig(directory: string, options: { readonly home?: string; readonly inline?: unknown } = {}): LoadedModelsConfig {
  const home = resolve(options.home ?? process.env.IOLAUS_HOME ?? homedir())
  const candidates: string[] = [join(home, ".iolaus", MODELS_CONFIG_FILE)]
  const project: string[] = []
  let current = resolve(directory)
  for (let depth = 0; depth < 64 && current !== home; depth++) {
    project.push(join(current, ".iolaus", MODELS_CONFIG_FILE))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  candidates.push(...project.reverse())
  const layers: ModelsConfig[] = []
  const sources: string[] = []
  const diagnostics: string[] = []
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      layers.push(parseModelsConfig(JSON.parse(readFileSync(path, "utf8"))))
      sources.push(path)
    } catch (error) {
      diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (options.inline !== undefined) {
    layers.push(parseModelsConfig(options.inline))
    sources.push("plugin options")
  }
  return { config: mergeConfigs(layers), sources, diagnostics }
}

/**
 * Iolaus follows the configured chain without checking provider connectivity
 * or subscription: the first chain entry is the lane's model. `~/.iolaus` or
 * `.iolaus/models.json` overrides it per agent or category.
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
