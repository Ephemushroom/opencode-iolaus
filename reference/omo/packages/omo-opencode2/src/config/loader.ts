import { isPlainObject } from "@oh-my-opencode/utils"
import {
  mergeOmoConfigRecords,
} from "@oh-my-opencode/omo-config-core"
import type { OmoConfigEnv } from "@oh-my-opencode/omo-config-core"

import { OpenCode2ConfigSchema } from "./schema"
import type { OpenCode2Config } from "./schema"
import { loadOpenCode2Layers } from "./config-layers"

export type LoadOpenCode2ConfigOptions = {
  directory: string;
  environment?: OmoConfigEnv;
  options: Record<string, unknown>;
}

export type OpenCode2ConfigResult = {
  config: OpenCode2Config;
  rawConfig: Record<string, unknown>;
  diagnostics: readonly { readonly message: string; readonly path: string; readonly kind?: string }[];
  sources: readonly string[];
}

function block(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const value = config["[opencode2]"]
  return isPlainObject(value) ? value : {}
}

function profile(config: Readonly<Record<string, unknown>>, name: string | undefined): Record<string, unknown> {
  if (name === undefined) return {}
  const profiles = config.profiles
  if (!isPlainObject(profiles)) return {}
  const selected = profiles[name]
  return isPlainObject(selected) ? selected : {}
}

function baseView(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === "profiles" || (key.startsWith("[") && key.endsWith("]"))) continue
    result[key] = value
  }
  return result
}

function applyUserSecurityKeys(
  target: Record<string, unknown>,
  userView: Record<string, unknown>,
): Record<string, unknown> {
  const mcpEnvAllowlist = userView.mcp_env_allowlist
  const browserAutomationEngine = isPlainObject(target.browser_automation_engine)
    ? { ...target.browser_automation_engine }
    : undefined

  const userBrowserEngine = isPlainObject(userView.browser_automation_engine)
    ? userView.browser_automation_engine
    : undefined
  const playwrightMcpArgs = userBrowserEngine?.playwright_mcp_args
  const { mcp_env_allowlist: _projectAllowlist, ...unrestricted } = target
  if (browserAutomationEngine) delete browserAutomationEngine.playwright_mcp_args

  return {
    ...unrestricted,
    ...(mcpEnvAllowlist !== undefined ? { mcp_env_allowlist: mcpEnvAllowlist } : {}),
    ...(browserAutomationEngine !== undefined
      ? {
          browser_automation_engine:
            playwrightMcpArgs !== undefined
              ? { ...browserAutomationEngine, playwright_mcp_args: playwrightMcpArgs }
              : browserAutomationEngine,
        }
      : {}),
  }
}

export function loadOpenCode2Config(options: LoadOpenCode2ConfigOptions): OpenCode2ConfigResult {
  const loaded = loadOpenCode2Layers(options.directory, options.environment)
  const selectedProfile = loaded.profile

  const views: Record<string, unknown>[] = []
  
  // 1. Base views (user then project)
  for (const layer of loaded.layers) {
    views.push(baseView(layer.config))
  }
  // 2. [opencode2] blocks (user then project)
  for (const layer of loaded.layers) {
    views.push(block(layer.config))
  }
  // 3. Profile base views (user then project)
  for (const layer of loaded.layers) {
    views.push(baseView(profile(layer.config, selectedProfile)))
  }
  // 4. Profile [opencode2] blocks (user then project)
  for (const layer of loaded.layers) {
    views.push(block(profile(layer.config, selectedProfile)))
  }
  // 5. Context options overlay (highest priority)
  views.push(options.options)

  let merged: Record<string, unknown> = {}
  for (const view of views) {
    if (Object.keys(view).length > 0) {
      merged = mergeOmoConfigRecords(merged, view)
    }
  }

  // Extract user-only security keys
  let userView: Record<string, unknown> = {}
  for (const layer of loaded.layers) {
    if (layer.source.scope !== "user") continue
    userView = mergeOmoConfigRecords(userView, baseView(layer.config))
    userView = mergeOmoConfigRecords(userView, block(layer.config))
    userView = mergeOmoConfigRecords(userView, baseView(profile(layer.config, selectedProfile)))
    userView = mergeOmoConfigRecords(userView, block(profile(layer.config, selectedProfile)))
  }

  const rawConfig = applyUserSecurityKeys(merged, userView)
  
  const parsed = OpenCode2ConfigSchema.safeParse(rawConfig)
  const diagnostics = [...loaded.diagnostics]
  
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push({
        message: `Validation error: ${issue.path.join(".")}: ${issue.message}`,
        path: "(merged config)",
        kind: "validation",
      })
    }
    return {
      config: OpenCode2ConfigSchema.parse({}), // return stripped empty object on schema failure
      rawConfig,
      diagnostics,
      sources: loaded.layers.map((layer) => layer.source.path),
    }
  }

  return {
    config: parsed.data,
    rawConfig,
    diagnostics,
    sources: loaded.layers.map((layer) => layer.source.path),
  }
}
