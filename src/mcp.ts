// Built-in remote MCP servers retained from oh-my-openagent
// (packages/omo-opencode/src/mcp/{context7,grep-app}.ts). Upstream also
// registers `websearch` and `lsp`; OpenCode 2 has native websearch and Iolaus
// ships no LSP tools, so neither is carried over.
import { Effect, type Scope } from "effect"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import { trace } from "./trace"

export const MCP_NAMES = ["context7", "grep_app"] as const
export type McpName = (typeof MCP_NAMES)[number]

type ServerConfig = Parameters<MCPEditor["set"]>[1]

const CONTEXT7_URL = "https://mcp.context7.com/mcp"
const GREP_APP_URL = "https://mcp.grep.app"
const CONTEXT7_PLACEHOLDER_KEY = "your api key"

function context7ApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.CONTEXT7_API_KEY?.trim()
  if (!key || key.toLowerCase() === CONTEXT7_PLACEHOLDER_KEY) return undefined
  return key
}

export function builtinMcpConfig(name: McpName, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (name === "grep_app") return { type: "remote", url: GREP_APP_URL, oauth: false } as ServerConfig
  const key = context7ApiKey(env)
  return {
    type: "remote",
    url: CONTEXT7_URL,
    oauth: false,
    ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
  } as ServerConfig
}

export interface McpRegistration {
  readonly registered: McpName[]
  /** Names the user already defines in their own config; Iolaus never overwrites those. */
  readonly deferred: McpName[]
}

export function registerMcps(
  ctx: { mcp: { transform: (fn: (editor: MCPEditor) => void) => Effect.Effect<unknown, never, Scope.Scope> } },
  names: readonly McpName[],
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<McpRegistration, never, Scope.Scope> {
  const result: McpRegistration = { registered: [], deferred: [] }
  if (!names.length) return Effect.succeed(result)
  return ctx.mcp.transform((editor) => {
    result.registered.length = 0
    result.deferred.length = 0
    for (const name of names) {
      if (editor.get(name)) {
        result.deferred.push(name)
        continue
      }
      editor.set(name, builtinMcpConfig(name, env))
      result.registered.push(name)
    }
    trace("iolaus.mcp.registered", { registered: [...result.registered], deferred: [...result.deferred] })
  }).pipe(Effect.as(result))
}
