import { Database } from "bun:sqlite"

import { normalizeDirectory } from "./db-path"
import { parseMessage, searchableText, type ParsedMessage } from "./message-shape"

/**
 * Compares `session_v2.directory` in canonical form. The column holds
 * forward-slash paths while a Windows `process.cwd()` holds backslashes, so a
 * raw `directory = ?` matches nothing and every scoped query returns empty.
 */
const DIRECTORY_PREDICATE = "lower(replace(directory, '\\', '/')) = ?"

export interface SessionRow {
  readonly id: string
  readonly parentID: string | null
  readonly slug: string
  readonly directory: string
  readonly title: string | null
  readonly agent: string | null
  readonly model: string | null
  readonly cost: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly timeCreated: number
  readonly timeUpdated: number
  readonly timeArchived: number | null
}

export interface MessageRow {
  readonly id: string
  readonly sessionID: string
  readonly seq: number
  readonly timeCreated: number
  readonly message: ParsedMessage
}

export interface SearchHit {
  readonly sessionID: string
  readonly messageID: string
  readonly seq: number
  readonly kind: ParsedMessage["kind"]
  readonly excerpt: string
}

export interface ListSessionsQuery {
  readonly directory?: string | undefined
  readonly includeChildren?: boolean | undefined
  readonly fromDate?: number | undefined
  readonly toDate?: number | undefined
  readonly limit: number
}

export interface SearchQuery {
  readonly query: string
  readonly sessionID?: string | undefined
  readonly directory?: string | undefined
  readonly caseSensitive: boolean
  readonly limit: number
  readonly maxSessions: number
  readonly excerptRadius: number
}

const SESSION_COLUMNS =
  "id, parent_id, slug, directory, title, agent, model, cost, tokens_input, tokens_output, time_created, time_updated, time_archived"

interface RawSession {
  id: string
  parent_id: string | null
  slug: string
  directory: string
  title: string | null
  agent: string | null
  model: string | null
  cost: number
  tokens_input: number
  tokens_output: number
  time_created: number
  time_updated: number
  time_archived: number | null
}

function toSessionRow(raw: RawSession): SessionRow {
  return {
    id: raw.id,
    parentID: raw.parent_id,
    slug: raw.slug,
    directory: raw.directory,
    title: raw.title,
    agent: raw.agent,
    model: raw.model,
    cost: raw.cost,
    tokensInput: raw.tokens_input,
    tokensOutput: raw.tokens_output,
    timeCreated: raw.time_created,
    timeUpdated: raw.time_updated,
    timeArchived: raw.time_archived,
  }
}

/**
 * Read-only reader over opencode2's SQLite store. Opened `readonly` so a bug
 * here can never corrupt a live session; every statement is parameterized.
 */
export class SessionStore {
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { readonly: true })
  }

  close(): void {
    this.db.close()
  }

  listSessions(query: ListSessionsQuery): SessionRow[] {
    const where: string[] = []
    const params: Array<string | number> = []

    if (query.directory !== undefined) {
      where.push(DIRECTORY_PREDICATE)
      params.push(normalizeDirectory(query.directory))
    }
    if (!query.includeChildren) where.push("parent_id IS NULL")
    if (query.fromDate !== undefined) {
      where.push("time_created >= ?")
      params.push(query.fromDate)
    }
    if (query.toDate !== undefined) {
      where.push("time_created <= ?")
      params.push(query.toDate)
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    const sql = `SELECT ${SESSION_COLUMNS} FROM session_v2${clause} ORDER BY time_updated DESC LIMIT ?`
    const rows = this.db.query(sql).all(...params, query.limit) as RawSession[]
    return rows.map(toSessionRow)
  }

  getSession(sessionID: string): SessionRow | undefined {
    const sql = `SELECT ${SESSION_COLUMNS} FROM session_v2 WHERE id = ?`
    const raw = this.db.query(sql).get(sessionID) as RawSession | null
    return raw ? toSessionRow(raw) : undefined
  }

  countMessages(sessionID: string): number {
    const row = this.db
      .query("SELECT count(*) AS c FROM session_message WHERE session_id = ?")
      .get(sessionID) as { c: number }
    return row.c
  }

  readMessages(sessionID: string, limit: number): MessageRow[] {
    const rows = this.db
      .query("SELECT id, session_id, seq, time_created, type, data FROM session_message WHERE session_id = ? ORDER BY seq ASC LIMIT ?")
      .all(sessionID, limit) as Array<{ id: string; session_id: string; seq: number; time_created: number; type: string; data: string }>

    return rows.map((row) => ({
      id: row.id,
      sessionID: row.session_id,
      seq: row.seq,
      timeCreated: row.time_created,
      message: parseMessage(row.type, row.data),
    }))
  }

  searchMessages(query: SearchQuery): SearchHit[] {
    const sessionIDs = query.sessionID
      ? [query.sessionID]
      : this.listSessions({
          directory: query.directory,
          includeChildren: true,
          limit: query.maxSessions,
        }).map((session) => session.id)

    const needle = query.caseSensitive ? query.query : query.query.toLowerCase()
    const hits: SearchHit[] = []

    for (const sessionID of sessionIDs) {
      if (hits.length >= query.limit) break
      const rows = this.db
        .query("SELECT id, seq, type, data FROM session_message WHERE session_id = ? ORDER BY seq ASC")
        .all(sessionID) as Array<{ id: string; seq: number; type: string; data: string }>

      for (const row of rows) {
        if (hits.length >= query.limit) break
        const parsed = parseMessage(row.type, row.data)
        const haystackRaw = searchableText(parsed)
        if (!haystackRaw) continue
        const haystack = query.caseSensitive ? haystackRaw : haystackRaw.toLowerCase()
        const index = haystack.indexOf(needle)
        if (index < 0) continue

        const start = Math.max(0, index - query.excerptRadius)
        const end = Math.min(haystackRaw.length, index + needle.length + query.excerptRadius)
        const prefix = start > 0 ? "..." : ""
        const suffix = end < haystackRaw.length ? "..." : ""
        hits.push({
          sessionID,
          messageID: row.id,
          seq: row.seq,
          kind: parsed.kind,
          excerpt: `${prefix}${haystackRaw.slice(start, end)}${suffix}`,
        })
      }
    }

    return hits
  }
}
