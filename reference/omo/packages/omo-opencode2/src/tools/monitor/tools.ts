import { MonitorCapacityError, MonitorFilterError, type MonitorManager, type MonitorRuntimeConfig } from "../../features/monitor/manager"
import { checkMonitorCommandPermission } from "../../features/monitor/permission"
import type { MonitorRecord } from "../../features/monitor/types"

export interface MonitorToolDefinition {
  readonly name: string
  readonly description: string
  readonly input: {
    readonly type: "object"
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
    readonly additionalProperties: false
  }
  readonly execute: (input: unknown, toolCtx: unknown) => Promise<{ content: string }>
}

export interface MonitorToolsOptions {
  readonly manager: MonitorManager
  readonly config: MonitorRuntimeConfig
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
}

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

function formatRecord(record: MonitorRecord): string {
  const counters = record.counters
  return [
    `${record.id}  [${record.status}]  ${record.label}`,
    `  matched=${counters.matchedLines} unmatched=${counters.unmatchedLines} dropped=${counters.droppedMatched + counters.droppedUnmatched} last_seq=${counters.lastSequence}`,
  ].join("\n")
}

export function createMonitorTools(options: MonitorToolsOptions): MonitorToolDefinition[] {
  const { manager, config, resolveSessionID } = options

  const monitorStart: MonitorToolDefinition = {
    name: "monitor_start",
    description:
      "Start a long-running background watcher process (dev server, log tail, watch-mode tests). Matching output is delivered to you automatically as it appears, so do not poll. Only programs listed in monitor.allowed_commands may be started.",
    input: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run in the background." },
        label: { type: "string", description: "Short human-facing label used in transcripts instead of the raw command." },
        match_pattern: {
          type: "string",
          description:
            "JavaScript regex. Only matching lines are delivered automatically; everything else stays queryable via monitor_output. Omit to deliver every line.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (rawInput, toolCtx) => {
      const input = asRecord(rawInput)
      const command = readString(input, "command")
      if (!command) return { content: "Invalid arguments: command is required." }

      const sessionID = resolveSessionID(toolCtx)
      if (!sessionID) return { content: "monitor_start could not determine the current session." }

      const permission = checkMonitorCommandPermission(command, config)
      if (!permission.allowed) return { content: `monitor_start denied: ${permission.reason}` }

      try {
        const record = await manager.start({
          command,
          label: readString(input, "label"),
          matchPattern: readString(input, "match_pattern"),
          parentSessionId: sessionID,
        })
        return {
          content: [
            "Monitor started.",
            `monitor_id: ${record.id}`,
            `label: ${record.label}`,
            `limits: max_runtime_ms=${config.max_runtime_ms}, max_monitors_per_session=${config.max_monitors_per_session}`,
            "",
            "Matching output arrives automatically. Do not poll.",
            `Stop it with monitor_stop(monitor_id="${record.id}").`,
          ].join("\n"),
        }
      } catch (error) {
        if (error instanceof MonitorCapacityError) return { content: `monitor_start denied: ${error.message}` }
        if (error instanceof MonitorFilterError) return { content: `monitor_start rejected match_pattern: ${error.message}` }
        return { content: `monitor_start failed: ${String(error)}` }
      }
    },
  }

  const monitorStop: MonitorToolDefinition = {
    name: "monitor_stop",
    description: "Stop a running monitor and kill its process group.",
    input: {
      type: "object",
      properties: { monitor_id: { type: "string", description: "The monitor id returned by monitor_start." } },
      required: ["monitor_id"],
      additionalProperties: false,
    },
    execute: async (rawInput) => {
      const monitorId = readString(asRecord(rawInput), "monitor_id")
      if (!monitorId) return { content: "Invalid arguments: monitor_id is required." }
      if (!manager.get(monitorId)) return { content: `Unknown monitor id: ${monitorId}.` }
      await manager.stop(monitorId)
      return { content: `Monitor ${monitorId} stopped.` }
    },
  }

  const monitorList: MonitorToolDefinition = {
    name: "monitor_list",
    description: "List the monitors running in this session with their line counters.",
    input: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_rawInput, toolCtx) => {
      const sessionID = resolveSessionID(toolCtx)
      if (!sessionID) return { content: "monitor_list could not determine the current session." }
      const records = manager.list(sessionID)
      if (records.length === 0) return { content: "No monitors in this session." }
      return { content: [`${records.length} monitor(s):`, "", ...records.map(formatRecord)].join("\n") }
    },
  }

  const monitorOutput: MonitorToolDefinition = {
    name: "monitor_output",
    description:
      "Read buffered lines from a monitor's ring buffer. Use this to inspect unmatched lines that were not delivered automatically, or to re-read history after a drop.",
    input: {
      type: "object",
      properties: {
        monitor_id: { type: "string", description: "The monitor id returned by monitor_start." },
        stream: {
          type: "string",
          enum: ["matched", "unmatched", "all"],
          description: "Which buffer to read. Defaults to matched.",
        },
        since_sequence: { type: "number", description: "Only lines with a sequence greater than this." },
        limit: { type: "number", description: "Return at most this many of the most recent lines." },
      },
      required: ["monitor_id"],
      additionalProperties: false,
    },
    execute: async (rawInput) => {
      const input = asRecord(rawInput)
      const monitorId = readString(input, "monitor_id")
      if (!monitorId) return { content: "Invalid arguments: monitor_id is required." }

      const streamRaw = readString(input, "stream")
      const stream = streamRaw === "unmatched" || streamRaw === "all" ? streamRaw : "matched"
      const result = manager.getOutput(monitorId, {
        stream,
        since_sequence: readNumber(input, "since_sequence"),
        limit: readNumber(input, "limit"),
      })
      if (!result) return { content: `Unknown monitor id: ${monitorId}.` }

      const counters = result.counters
      const head = `monitor ${monitorId} (${stream}): ${result.lines.length} line(s), last_seq=${counters.lastSequence}`
      if (result.lines.length === 0) return { content: `${head}\n(no lines)` }
      const body = result.lines.map((line) => `[${line.stream} seq=${line.seq}] ${line.text}`)
      return { content: [head, "", ...body].join("\n") }
    },
  }

  return [monitorStart, monitorStop, monitorList, monitorOutput]
}
