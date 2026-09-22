import type { Context } from "@opencode/plugin/promise/plugin"

import { BTW_METADATA_KEY, createBtwMetadata, getBtwMetadata } from "./metadata"
import { boundParentTranscript, renderParentTranscript, type TranscriptEntry } from "./parent-context-budget"
import { resolveStorePath } from "../../tools/session-manager/db-path"
import { SessionStore } from "../../tools/session-manager/store"
import type { ChildSessionDeps } from "../../orchestration/child-session"

export interface BtwToolDefinition {
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

export interface BtwToolsOptions {
  readonly ctx: Context
  readonly deps: ChildSessionDeps
  readonly cwd: string
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
  readonly trace?: (event: string, detail?: Record<string, unknown>) => void
  readonly timeoutMs?: number
}

const DEFAULT_BTW_TIMEOUT_MS = 180_000

interface BtwRecord {
  readonly sideSessionID: string
  readonly parentSessionID: string
  readonly createdAt: number
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Loads the parent transcript from opencode2's SQLite store and bounds it to
 * the BTW budgets. Returns undefined when the store or session is absent —
 * the side conversation still works, just without parent background.
 */
function loadBoundedParentTranscript(parentSessionID: string, cwd: string): { text: string; entries: number } | undefined {
  const resolved = resolveStorePath()
  if (!resolved.found) return undefined
  let store: SessionStore
  try {
    store = new SessionStore(resolved.path)
  } catch {
    return undefined
  }
  try {
    const session = store.getSession(parentSessionID)
    if (!session) return undefined
    const rows = store.readMessages(parentSessionID, 500)
    const entries: TranscriptEntry[] = []
    for (const row of rows) {
      const message = row.message
      if (message.kind === "user") {
        if (message.text.length > 0) entries.push({ role: "user", text: message.text })
      } else if (message.kind === "assistant") {
        if (message.text.length > 0) entries.push({ role: "assistant", text: message.text })
      }
    }
    const bounded = boundParentTranscript(entries)
    if (bounded.length === 0) return undefined
    return { text: renderParentTranscript(parentSessionID, bounded), entries: bounded.length }
  } catch {
    return undefined
  } finally {
    store.close()
  }
}

export function createBtwTools(options: BtwToolsOptions): BtwToolDefinition[] {
  const { ctx, deps, cwd, resolveSessionID } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_BTW_TIMEOUT_MS
  const trace = options.trace ?? (() => undefined)
  const openSides = new Map<string, BtwRecord>()

  const btwStart: BtwToolDefinition = {
    name: "btw_start",
    description:
      "Start a lightweight side conversation (BTW) that inherits bounded read-only context from the current session. Use it for clarifying questions, tangents, or second opinions that should NOT pollute the main conversation. The side conversation cannot delegate work or mutate files. Returns the side conversation's answer.",
    input: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask in the side conversation." },
      },
      required: ["question"],
      additionalProperties: false,
    },
    execute: async (rawInput, toolCtx) => {
      const input = asRecord(rawInput)
      const question = readString(input, "question")
      if (!question) return { content: "Invalid arguments: question is required." }

      const parentSessionID = resolveSessionID(toolCtx)
      if (!parentSessionID) return { content: "BTW is unavailable: no parent session context." }

      const parent = loadBoundedParentTranscript(parentSessionID, cwd)
      const prompt = [
        parent?.text,
        `<omo-btw-side session_kind="btw">`,
        "You are answering a side question about the parent conversation above.",
        "Answer only this question. Do not mutate files or external state.",
        "Do not delegate work to subagents.",
        `</omo-btw-side>`,
        `Side question: ${question}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n\n")

      const side = await ctx.session.create({
        title: `BTW · ${question.replace(/\s+/g, " ").slice(0, 64)}`,
      })
      openSides.set(side.id, { sideSessionID: side.id, parentSessionID, createdAt: Date.now() })
      trace("omo.btw.started", { parentSessionID, sideSessionID: side.id, parentEntries: parent?.entries ?? 0 })

      const waitPromise = deps.waitChild({ sessionID: side.id, timeoutMs })
      await ctx.session.prompt({
        sessionID: side.id,
        text: prompt,
        metadata: { [BTW_METADATA_KEY]: createBtwMetadata(parentSessionID) },
      })
      const result = await waitPromise
      trace("omo.btw.finished", { sideSessionID: side.id, ok: result.ok, length: result.text.length })
      return {
        content: result.ok
          ? `BTW side conversation answer:\n\n${result.text}`
          : `BTW side conversation failed: ${result.text}`,
      }
    },
  }

  const btwReply: BtwToolDefinition = {
    name: "btw_reply",
    description:
      "Continue an existing BTW side conversation with a follow-up question. The side conversation keeps its own context; only its final answers reach you.",
    input: {
      type: "object",
      properties: {
        side_session_id: { type: "string", description: "Session id of the BTW side conversation (from btw_start output or btw_list)." },
        text: { type: "string", description: "The follow-up to send." },
      },
      required: ["side_session_id", "text"],
      additionalProperties: false,
    },
    execute: async (rawInput) => {
      const input = asRecord(rawInput)
      const sideSessionID = readString(input, "side_session_id")
      const text = readString(input, "text")
      if (!sideSessionID || !text) return { content: "Invalid arguments: side_session_id and text are required." }

      const record = openSides.get(sideSessionID)
      if (!record) return { content: `Unknown BTW side conversation: ${sideSessionID}. Start one with btw_start first.` }

      const waitPromise = deps.waitChild({ sessionID: sideSessionID, timeoutMs })
      await ctx.session.prompt({
        sessionID: sideSessionID,
        text,
        metadata: { [BTW_METADATA_KEY]: createBtwMetadata(record.parentSessionID) },
      })
      const result = await waitPromise
      trace("omo.btw.replied", { sideSessionID: sideSessionID, ok: result.ok, length: result.text.length })
      return {
        content: result.ok ? `BTW answer:\n\n${result.text}` : `BTW follow-up failed: ${result.text}`,
      }
    },
  }

  const btwList: BtwToolDefinition = {
    name: "btw_list",
    description: "List the BTW side conversations opened from this session.",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (rawInput, toolCtx) => {
      const parentSessionID = resolveSessionID(toolCtx)
      const sides = [...openSides.values()].filter((record) => record.parentSessionID === parentSessionID)
      if (sides.length === 0) return { content: "No BTW side conversations open." }
      const lines = sides.map(
        (record) => `${record.sideSessionID}  opened=${new Date(record.createdAt).toISOString()}`,
      )
      return { content: lines.join("\n") }
    },
  }

  return [btwStart, btwReply, btwList]
}

export { getBtwMetadata }
