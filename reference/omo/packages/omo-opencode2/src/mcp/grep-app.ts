import type { RemoteMcpServerConfig } from "./types"

/** Grep.app remote MCP. No auth, no headers. */
export function createGrepAppConfig(): RemoteMcpServerConfig {
  return {
    type: "remote",
    url: "https://mcp.grep.app",
    oauth: false,
  }
}
