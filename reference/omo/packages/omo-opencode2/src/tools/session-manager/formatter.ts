import type { MessageRow, SearchHit, SessionRow } from "./store"

function isoTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "unknown"
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19)
}

function titleOf(session: SessionRow): string {
  return session.title ?? `(untitled, ${session.slug})`
}

export function formatSessionList(sessions: readonly SessionRow[], scope: string): string {
  if (sessions.length === 0) return `No sessions found for ${scope}.`

  const header = "| Session ID | Title | Updated | Agent | Cost |"
  const divider = "|---|---|---|---|---|"
  const rows = sessions.map((session) => {
    const cost = session.cost > 0 ? `$${session.cost.toFixed(4)}` : "-"
    return `| ${session.id} | ${titleOf(session)} | ${isoTime(session.timeUpdated)} | ${session.agent ?? "-"} | ${cost} |`
  })

  return [`${sessions.length} session(s) for ${scope}:`, "", header, divider, ...rows].join("\n")
}

export interface SessionReadView {
  readonly session: SessionRow
  readonly messages: readonly MessageRow[]
  readonly totalMessages: number
  readonly includeReasoning: boolean
}

function formatMessage(row: MessageRow, includeReasoning: boolean): string {
  const stamp = isoTime(row.timeCreated)
  const message = row.message

  switch (message.kind) {
    case "user": {
      const files = message.fileCount > 0 ? ` (+${message.fileCount} file(s))` : ""
      return `[${row.seq}] user (${stamp})${files}\n${message.text}`
    }
    case "assistant": {
      const who = message.agent ?? "assistant"
      const model = message.model ? ` via ${message.model}` : ""
      const reasoning = includeReasoning && message.reasoning ? `\n<reasoning>\n${message.reasoning}\n</reasoning>` : ""
      return `[${row.seq}] ${who}${model} (${stamp})${reasoning}\n${message.text}`
    }
    case "agent-switched":
      return `[${row.seq}] agent switched to ${message.agent ?? "unknown"} (${stamp})`
    case "unknown":
      return `[${row.seq}] ${message.rawType} (${stamp})\n${message.text}`
  }
}

export function formatSessionRead(view: SessionReadView): string {
  const { session, messages, totalMessages } = view
  const truncated = totalMessages > messages.length ? ` (showing first ${messages.length})` : ""
  const head = [
    `Session: ${session.id}`,
    `Title: ${titleOf(session)}`,
    `Directory: ${session.directory}`,
    `Messages: ${totalMessages}${truncated}`,
    "",
  ]
  if (messages.length === 0) return [...head, "This session has no messages."].join("\n")
  return [...head, ...messages.map((row) => formatMessage(row, view.includeReasoning))].join("\n\n")
}

export function formatSearchResults(hits: readonly SearchHit[], query: string, scope: string): string {
  if (hits.length === 0) return `No matches for "${query}" in ${scope}.`

  const sessions = new Set(hits.map((hit) => hit.sessionID))
  const head = `Found ${hits.length} match(es) for "${query}" across ${sessions.size} session(s) in ${scope}:`
  const body = hits.map((hit) => `[${hit.sessionID}] seq ${hit.seq} (${hit.kind})\n${hit.excerpt}`)
  return [head, "", ...body].join("\n\n")
}

export interface SessionInfoView {
  readonly session: SessionRow
  readonly messageCount: number
  readonly firstMessageAt: number | undefined
  readonly lastMessageAt: number | undefined
  readonly agentsUsed: readonly string[]
}

export function formatSessionInfo(view: SessionInfoView): string {
  const { session } = view
  const lines = [
    `Session ID: ${session.id}`,
    `Title: ${titleOf(session)}`,
    `Directory: ${session.directory}`,
    `Parent: ${session.parentID ?? "(none, this is a main session)"}`,
    `Messages: ${view.messageCount}`,
    `First message: ${isoTime(view.firstMessageAt)}`,
    `Last message: ${isoTime(view.lastMessageAt)}`,
    `Created: ${isoTime(session.timeCreated)}`,
    `Updated: ${isoTime(session.timeUpdated)}`,
    `Agents used: ${view.agentsUsed.length > 0 ? view.agentsUsed.join(", ") : "unknown"}`,
    `Model: ${session.model ?? "unknown"}`,
    `Cost: $${session.cost.toFixed(4)}`,
    `Tokens: ${session.tokensInput} in / ${session.tokensOutput} out`,
  ]
  if (session.timeArchived !== null) lines.push(`Archived: ${isoTime(session.timeArchived)}`)
  return lines.join("\n")
}
