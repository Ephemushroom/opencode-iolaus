export type MonitorId = string

export type MonitorMode = "idle" | "live_safe"
export type MonitorStatus = "starting" | "running" | "exited" | "stopped" | "failed"
export type OutputStreamType = "stdout" | "stderr"

export interface MonitorCounters {
  totalLines: number
  matchedLines: number
  unmatchedLines: number
  droppedMatched: number
  droppedUnmatched: number
  bytesDropped: number
  lastSequence: number
}

export interface OutputLine {
  stream: OutputStreamType
  seq: number
  text: string
  truncated?: boolean
}

export interface OutputBatch {
  monitorId: MonitorId
  batchSeq: number
  lines: OutputLine[]
  stillRunning: boolean
}

export interface MonitorRecord {
  id: MonitorId
  command: string
  label: string
  mode: MonitorMode
  parentSessionId: string
  startedAt: Date
  status: MonitorStatus
  exitCode?: number
  signal?: string
  counters: MonitorCounters
}

export interface MonitorStartOpts {
  command: string
  label?: string
  mode?: MonitorMode
  matchPattern?: string
  parentSessionId: string
}

export interface MonitorOutputQuery {
  stream?: "matched" | "unmatched" | "all"
  since_sequence?: number
  limit?: number
}

export interface MonitorOutputResult {
  lines: OutputLine[]
  counters: MonitorCounters
}

export interface MonitorStartArgs {
  command: string
  label?: string
  mode?: MonitorMode
  match_pattern?: string
}

export interface MonitorOutputArgs {
  monitor_id: string
  stream?: "matched" | "unmatched" | "all"
  since_sequence?: number
  limit?: number
}

/**
 * Splits a command string into argv, honoring quotes and backslash escapes.
 * The first token is what `allowed_commands` is matched against.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inQuote = false
  let quoteChar = ""
  let escaped = false

  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if ((char === "'" || char === '"') && !inQuote) {
      inQuote = true
      quoteChar = char
    } else if (char === quoteChar && inQuote) {
      inQuote = false
      quoteChar = ""
    } else if (char === " " && !inQuote) {
      if (current) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += char
    }
  }

  if (current) tokens.push(current)
  return tokens
}

export function createEmptyCounters(): MonitorCounters {
  return {
    totalLines: 0,
    matchedLines: 0,
    unmatchedLines: 0,
    droppedMatched: 0,
    droppedUnmatched: 0,
    bytesDropped: 0,
    lastSequence: 0,
  }
}
