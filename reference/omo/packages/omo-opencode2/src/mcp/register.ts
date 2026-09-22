import type { Context } from "@opencode/plugin/promise/plugin"

import { createContext7Config } from "./context7"
import { createGrepAppConfig } from "./grep-app"
import { createLspMcpConfig } from "./lsp"
import { isBuiltinMcpName, toServerConfig, userDefinedNames, type BuiltinMcpServerConfig } from "./types"
import { loadOpenCode2Config } from "../config"

type Trace = (event: string, detail?: Record<string, unknown>) => void

export interface RegisterBuiltinMcpsOptions {
  readonly cwd: string
  readonly env?: Record<string, string | undefined>
  readonly trace?: Trace
}

export interface BuiltinMcpsRegistration {
  readonly registered: readonly string[]
}

/**
 * Registers three built-in MCP servers (context7, grep_app remote; lsp local
 * stdio) through ctx.mcp.transform, added in beta-17793.
 *
 * Invariants:
 * - A server the user already defined is NEVER overwritten; the built-in
 *   silently defers to the user's entry.
 * - `disabled_mcps` (under [opencode2]) removes a built-in entirely.
 * - websearch is intentionally absent: opencode2 ships a native
 *   ctx.websearch domain, so a remote Exa/Tavily MCP adds nothing.
 */
export async function registerBuiltinMcps(
  ctx: Context,
  options: RegisterBuiltinMcpsOptions,
): Promise<BuiltinMcpsRegistration> {
  const loaded = loadOpenCode2Config({ directory: options.cwd, options: { ...ctx.options } })
  const disabledMcps = loaded.config.disabled_mcps ?? []
  const env = options.env ?? process.env

  const wanted: Array<{ name: string; config: BuiltinMcpServerConfig | undefined }> = [
    { name: "context7", config: createContext7Config(env) },
    { name: "grep_app", config: createGrepAppConfig() },
    { name: "lsp", config: createLspMcpConfig({ cwd: options.cwd }) },
  ]

  const deferred: string[] = []
  const planned: Array<{ name: string; config: BuiltinMcpServerConfig }> = []

  await ctx.mcp.transform((draft) => {
    const userNames = userDefinedNames(draft)
    for (const { name, config } of wanted) {
      if (disabledMcps.includes(name)) continue
      if (userNames.has(name)) {
        deferred.push(name)
        continue
      }
      if (config === undefined) continue
      draft.set(name, toServerConfig(config))
      planned.push({ name, config })
    }
  })

  // v2 State defers transform materialization when registration happens inside
  // a batch (same laziness agent.transform shows at setup time). Force it so
  // the servers are actually committed before we report them.
  await ctx.mcp.reload().catch(() => undefined)

  const registered = planned.map((entry) => entry.name)
  options.trace?.("omo.mcp.registered", {
    servers: registered,
    deferredToUser: deferred,
    disabled: disabledMcps.filter((name) => isBuiltinMcpName(name)),
  })

  // Post-registration connection probe: ctx.mcp.list() reports each server's
  // harness-side status. Connections are asynchronous, so poll a few times
  // before giving up; statuses are reported, never thrown.
  const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms))
  void (async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await sleep(500)
      let statuses: Array<{ server: string; status: string; error?: string }> = []
      try {
        const result = await ctx.mcp.list()
        statuses = result.data.map((server) => ({
          server: server.name,
          status: server.status.status,
          ...(server.status.status === "failed" ? { error: server.status.error } : {}),
        }))
      } catch {
        return
      }
      for (const entry of statuses) {
        options.trace?.("omo.mcp.status", entry)
      }
      const pending = statuses.filter((entry) => entry.status === "pending").length
      if (pending === 0 || statuses.length === 0) return
    }
  })().catch(() => undefined)

  return { registered }
}
