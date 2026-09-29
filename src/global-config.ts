import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseModelsConfig } from "./models"
import { parseOptions } from "./options"
import { parseVerifyConfig } from "./verify/config"

export const GLOBAL_CONFIG_FILE = "iolaus.json"

/** Validate the entire global file before any plugin registration or feature disabling. */
export function loadGlobalConfig(userLayer: string): Record<string, unknown> {
  const path = join(userLayer, GLOBAL_CONFIG_FILE)
  if (!existsSync(path)) return {}
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("must be an object")
    const config = value as Record<string, unknown>
    parseOptions(config)
    if (config.models !== undefined) parseModelsConfig(config.models)
    if (typeof config.verify === "object" && config.verify !== null) parseVerifyConfig(config.verify as Record<string, unknown>)
    return config
  } catch (error) {
    throw new TypeError(`Invalid Iolaus global config ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
