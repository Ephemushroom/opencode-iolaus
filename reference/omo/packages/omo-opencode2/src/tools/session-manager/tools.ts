import { formatSearchResults, formatSessionInfo, formatSessionList, formatSessionRead } from "./formatter"
import { resolveStorePath, type ResolveStorePathDeps } from "./db-path"
import { SessionStore } from "./store"

export interface SessionToolDefinition {
  readonly name: string
  readonly description: string
  readonly input: {
    readonly type: "object"
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
    readonly additionalProperties: false
  }
  readonly execute: (input: unknown) => Promise<{ content: string }>
}

export type SessionToolsTrace = (event: string, detail?: Record<string, unknown>) => void

export interface SessionToolsOptions {
  /** Default project scope. Sessions are filtered to this directory. */
  readonly directory: string
  readonly storeDeps?: ResolveStorePathDeps
  readonly openStore?: (path: string) => SessionStore
  /**
   * Execution observability. The v2 CLI does not surface tool results, so this
   * trace is the only place QA can assert that a tool ran and what it found.
   */
  readonly trace?: SessionToolsTrace
}

const MAX_SESSIONS_TO_SCAN = 50
const DEFAULT_LIST_LIMIT = 30
const DEFAULT_SEARCH_LIMIT = 20
const EXCERPT_RADIUS = 80

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readBoolean(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true
}

function readDate(input: Record<string, unknown>, key: string): number | undefined {
  const raw = readString(input, key)
  if (!raw) return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * opencode2's plugin `Context` exposes no session list or message reader, so
 * every tool here reads the harness's own SQLite store. Absence of that store
 * is a normal outcome, never an exception.
 */
function withStore(options: SessionToolsOptions, use: (store: SessionStore) => string): string {
  const resolved = resolveStorePath(options.storeDeps)
  if (!resolved.found) {
    return `No opencode2 session store found. Checked:\n${resolved.checked.map((path) => `  ${path}`).join("\n")}\nSet OMO_OPENCODE2_DB to point at opencode.db if it lives elsewhere.`
  }

  let store: SessionStore
  try {
    store = (options.openStore ?? ((path) => new SessionStore(path)))(resolved.path)
  } catch (error) {
    return `Could not open the opencode2 session store at ${resolved.path}: ${String(error)}`
  }

  try {
    return use(store)
  } catch (error) {
    return `Reading the opencode2 session store failed: ${String(error)}. The store schema may have changed in this opencode2 build.`
  } finally {
    store.close()
  }
}

export function createSessionTools(options: SessionToolsOptions): SessionToolDefinition[] {
  const scopeLabel = (directory: string | undefined): string => directory ?? "all projects"
  const traceRun = (tool: string, detail: Record<string, unknown>): void => {
    options.trace?.("omo.session-tools.executed", { tool, ...detail })
  }

  const sessionList: SessionToolDefinition = {
    name: "session_list",
    description:
      "List opencode2 sessions with metadata (title, last update, agent, cost). Defaults to the current project and to main sessions only. Use this to find a session id before session_read or session_info.",
    input: {
      type: "object",
      properties: {
        limit: { type: "number", description: `Maximum sessions to return (default ${DEFAULT_LIST_LIMIT}).` },
        from_date: { type: "string", description: "Only sessions created at or after this ISO 8601 date." },
        to_date: { type: "string", description: "Only sessions created at or before this ISO 8601 date." },
        project_path: { type: "string", description: "Project directory to scope to. Defaults to the current project." },
        all_projects: { type: "boolean", description: "Ignore the project scope and list sessions from every project." },
        include_children: { type: "boolean", description: "Include subagent/child sessions. Defaults to false." },
      },
      additionalProperties: false,
    },
    execute: async (rawInput) => {
      const input = asRecord(rawInput)
      const directory = readBoolean(input, "all_projects") ? undefined : readString(input, "project_path") ?? options.directory
      let found = 0
      const result = withStore(options, (store) => {
        const sessions = store.listSessions({
          directory,
          includeChildren: readBoolean(input, "include_children"),
          fromDate: readDate(input, "from_date"),
          toDate: readDate(input, "to_date"),
          limit: readNumber(input, "limit") ?? DEFAULT_LIST_LIMIT,
        })
        found = sessions.length
        return formatSessionList(sessions, scopeLabel(directory))
      })
      traceRun("session_list", { sessions: found, scoped: directory !== undefined })
      return { content: result }
    },
  }

  const sessionRead: SessionToolDefinition = {
    name: "session_read",
    description:
      "Read the message history of one opencode2 session. Returns messages in order with role, timestamp, agent, and model. Assistant reasoning is omitted unless include_reasoning is set.",
    input: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id, as returned by session_list." },
        limit: { type: "number", description: "Maximum messages to return (default 200)." },
        include_reasoning: { type: "boolean", description: "Include assistant reasoning blocks. Defaults to false." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    execute: async (rawInput) => {
      const input = asRecord(rawInput)
      const sessionID = readString(input, "session_id")
      if (!sessionID) return { content: "Invalid arguments: session_id is required." }

      let returned = 0
      let total = 0
      const result = withStore(options, (store) => {
        const session = store.getSession(sessionID)
        if (!session) return `Unknown session id: ${sessionID}. Use session_list to find valid ids.`
        const limit = readNumber(input, "limit") ?? 200
        const messages = store.readMessages(sessionID, limit)
        returned = messages.length
        total = store.countMessages(sessionID)
        return formatSessionRead({
          session,
          messages,
          totalMessages: total,
          includeReasoning: readBoolean(input, "include_reasoning"),
        })
      })
      traceRun("session_read", { sessionID, messages: returned, totalMessages: total })
      return { content: result }
    },
  }

  const sessionSearch: SessionToolDefinition = {
    name: "session_search",
    description:
      "Full-text search across opencode2 session messages, returning matching excerpts with their session id. Scoped to the current project unless told otherwise. Assistant reasoning is not searched.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
        session_id: { type: "string", description: "Restrict the search to one session." },
        project_path: { type: "string", description: "Project directory to scope to. Defaults to the current project." },
        all_projects: { type: "boolean", description: "Search every project instead of just the current one." },
        case_sensitive: { type: "boolean", description: "Case-sensitive matching. Defaults to false." },
        limit: { type: "number", description: `Maximum matches to return (default ${DEFAULT_SEARCH_LIMIT}).` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (rawInput) => {
      const input = asRecord(rawInput)
      const query = readString(input, "query")
      if (!query) return { content: "Invalid arguments: query is required." }

      const sessionID = readString(input, "session_id")
      const directory = readBoolean(input, "all_projects") ? undefined : readString(input, "project_path") ?? options.directory
      let matches = 0
      const result = withStore(options, (store) => {
        const hits = store.searchMessages({
          query,
          sessionID,
          directory,
          caseSensitive: readBoolean(input, "case_sensitive"),
          limit: readNumber(input, "limit") ?? DEFAULT_SEARCH_LIMIT,
          maxSessions: MAX_SESSIONS_TO_SCAN,
          excerptRadius: EXCERPT_RADIUS,
        })
        matches = hits.length
        return formatSearchResults(hits, query, sessionID ? `session ${sessionID}` : scopeLabel(directory))
      })
      traceRun("session_search", { query, matches, scopedToSession: sessionID !== undefined })
      return { content: result }
    },
  }

  const sessionInfo: SessionToolDefinition = {
    name: "session_info",
    description:
      "Get metadata and statistics for one opencode2 session: message count, time range, agents used, model, cost, and token totals.",
    input: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id, as returned by session_list." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    execute: async (rawInput) => {
      const input = asRecord(rawInput)
      const sessionID = readString(input, "session_id")
      if (!sessionID) return { content: "Invalid arguments: session_id is required." }

      let counted = 0
      const result = withStore(options, (store) => {
        const session = store.getSession(sessionID)
        if (!session) return `Unknown session id: ${sessionID}. Use session_list to find valid ids.`

        const messages = store.readMessages(sessionID, Number.MAX_SAFE_INTEGER)
        counted = messages.length
        const agents = new Set<string>()
        for (const row of messages) {
          if (row.message.kind === "assistant" && row.message.agent) agents.add(row.message.agent)
          if (row.message.kind === "agent-switched" && row.message.agent) agents.add(row.message.agent)
        }

        return formatSessionInfo({
          session,
          messageCount: messages.length,
          firstMessageAt: messages[0]?.timeCreated,
          lastMessageAt: messages[messages.length - 1]?.timeCreated,
          agentsUsed: [...agents].sort(),
        })
      })
      traceRun("session_info", { sessionID, messages: counted })
      return { content: result }
    },
  }

  return [sessionList, sessionRead, sessionSearch, sessionInfo]
}
