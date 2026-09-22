import type { Mcp } from "@opencode/schema/mcp"

/** v2 local MCP server config: command array + cwd + environment. */
export type LocalMcpServerConfig = {
  readonly type: "local"
  readonly command: readonly string[]
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string>>
  readonly disabled?: boolean
}

/** v2 remote MCP server config: url + headers, never OAuth from us. */
export type RemoteMcpServerConfig = {
  readonly type: "remote"
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly oauth?: false
  readonly disabled?: boolean
}

export type BuiltinMcpServerConfig = LocalMcpServerConfig | RemoteMcpServerConfig

export const BUILTIN_MCP_NAMES = ["context7", "grep_app", "lsp"] as const
export type BuiltinMcpName = (typeof BUILTIN_MCP_NAMES)[number]

export function isBuiltinMcpName(value: string): value is BuiltinMcpName {
  return (BUILTIN_MCP_NAMES as readonly string[]).includes(value)
}

/**
 * v2 ServerConfig is a tagged union over plain records, and the draft hands out
 * DeepMutable versions. Our configs are already plain records with the right
 * shape, so the cast only strips readonly at the boundary. Field shapes are
 * pinned by unit tests (remote url/headers, local command/environment).
 */
export function toServerConfig(config: BuiltinMcpServerConfig): Mcp.ServerConfig {
  return config as unknown as Mcp.ServerConfig
}

/** A built-in never overwrites a server the user already defined. */
export function userDefinedNames(draft: {
  list(): readonly (readonly [string, unknown])[]
}): Set<string> {
  return new Set(draft.list().map(([name]) => name))
}
