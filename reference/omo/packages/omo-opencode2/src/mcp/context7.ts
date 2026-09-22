import type { RemoteMcpServerConfig } from "./types"

const CONTEXT7_URL = "https://mcp.context7.com/mcp"

/**
 * Context7 remote MCP. CONTEXT7_API_KEY is optional; placeholder-looking
 * values are treated as absent so a template env file does not send garbage
 * as a Bearer token.
 */
export function createContext7Config(env: Record<string, string | undefined> = process.env): RemoteMcpServerConfig {
  const apiKey = normalizeContext7ApiKey(env.CONTEXT7_API_KEY)

  return {
    type: "remote",
    url: CONTEXT7_URL,
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    oauth: false,
  }
}

function normalizeContext7ApiKey(value: string | undefined): string | null {
  if (value === undefined || isPlaceholderContext7ApiKey(value)) return null
  return value.trim()
}

function isPlaceholderContext7ApiKey(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[<>"'`]/g, "").replace(/[\s_-]+/g, " ")
  return normalized.length === 0 || normalized === "your api key"
}
