import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Tool } from "@opencode/schema/tool"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { isRecord } from "@oh-my-opencode/utils"
import type { Executor, Owner, RunRef } from "../../orchestration/execution/types"
import { BTW_METADATA_KEY, createBtwMetadata } from "./metadata"
import { boundParentTranscript, renderParentTranscript, type TranscriptEntry } from "./parent-context-budget"
import { resolveStorePath } from "../../tools/session-manager/db-path"
import { SessionStore } from "../../tools/session-manager/store"
import { runForeground } from "../../orchestration/execution/foreground"

export type NativeBtwOptions = {
  readonly executor: Executor
  readonly cwd: string
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
  readonly trace?: (event: string, detail?: Record<string, unknown>) => void
  readonly timeoutMs?: number
}

type Input = { readonly question?: string; readonly side_session_id?: string; readonly text?: string }
type Side = { ref: RunRef; readonly parentSessionID: string; readonly sessionID: string; readonly createdAt: number }

const timeoutDefault = 180_000

function inputOf(value: unknown): Input {
  if (!isRecord(value)) return {}
  const record = value
  return {
    question: typeof record.question === "string" ? record.question : undefined,
    side_session_id: typeof record.side_session_id === "string" ? record.side_session_id : undefined,
    text: typeof record.text === "string" ? record.text : undefined,
  }
}

function parentTranscript(sessionID: string): string | undefined {
  const resolved = resolveStorePath()
  if (!resolved.found) return undefined
  const store = new SessionStore(resolved.path)
  try {
    if (!store.getSession(sessionID)) return undefined
    const entries: TranscriptEntry[] = store.readMessages(sessionID, 500).flatMap(({ message }) =>
      message.kind === "user" || message.kind === "assistant"
        ? message.text.length > 0 ? [{ role: message.kind, text: message.text }] : []
        : [])
    const bounded = boundParentTranscript(entries)
    return bounded.length === 0 ? undefined : renderParentTranscript(sessionID, bounded)
  } finally {
    store.close()
  }
}

function owner(parentSessionID: string): Owner {
  const sessionID = Session.ID.make(parentSessionID)
  return { kind: "btw", callerSessionID: sessionID, rootSessionID: sessionID }
}

export function createNativeBtwTools(options: NativeBtwOptions) {
  const sides = new Map<string, Side>()
  const run = (request: Parameters<Executor["submit"]>[0]) => Effect.gen(function* () {
    const parent = yield* options.executor.managed(request.owner.callerSessionID)
    const { ref, record } = yield* runForeground(options.executor, { ...request,
      owner: { ...request.owner, rootSessionID: parent?.owner.rootSessionID ?? request.owner.rootSessionID },
      immediate: parent !== undefined }, options.timeoutMs ?? timeoutDefault)
    if (record.status !== "completed") return yield* new Tool.Error({ message: record.reason ?? `BTW execution ${record.status}` })
    return { ref, sessionID: record.sessionID, text: record.output }
  }).pipe(Effect.mapError((error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) })))
  const start = (rawInput: unknown, toolCtx: unknown) => {
    const input = inputOf(rawInput)
    const parentSessionID = options.resolveSessionID(toolCtx)
    if (!input.question) return Effect.succeed({ content: "Invalid arguments: question is required." })
    if (!parentSessionID) return Effect.succeed({ content: "BTW is unavailable: no parent session context." })
    const transcript = parentTranscript(parentSessionID)
    const text = [transcript, `<omo-btw-side session_kind="btw">`, "Answer only the side question. Do not mutate files or delegate work.", "</omo-btw-side>", `Side question: ${input.question}`].filter((line): line is string => line !== undefined).join("\n\n")
    return run({ kind: "fresh", owner: owner(parentSessionID), agent: options.agent, model: options.model, text, description: `BTW · ${input.question.slice(0, 64)}`, background: false, metadata: { [BTW_METADATA_KEY]: createBtwMetadata(parentSessionID) } }).pipe(Effect.tap(({ ref, sessionID }) => Effect.sync(() => { sides.set(sessionID, { ref, parentSessionID, sessionID, createdAt: Date.now() }); options.trace?.("omo.btw.started", { parentSessionID, sideSessionID: sessionID }) })), Effect.map(({ text }) => ({ content: `BTW side conversation answer:\n\n${text}` })))
  }
  const reply = (rawInput: unknown, toolCtx: unknown) => {
    const input = inputOf(rawInput)
    const side = input.side_session_id === undefined ? undefined : [...sides.values()].find((entry) => entry.sessionID === input.side_session_id)
    if (!input.side_session_id || !input.text) return Effect.succeed({ content: "Invalid arguments: side_session_id and text are required." })
    if (!side) return Effect.succeed({ content: `Unknown BTW side conversation: ${input.side_session_id}. Start one with btw_start first.` })
    if (options.resolveSessionID(toolCtx) !== side.parentSessionID) return Effect.succeed({ content: `BTW side conversation is owned by another session: ${input.side_session_id}.` })
    return run({ kind: "message", owner: owner(side.parentSessionID), previous: side.ref, text: input.text, description: `BTW reply · ${input.text.slice(0, 64)}`, background: false, metadata: { [BTW_METADATA_KEY]: createBtwMetadata(side.parentSessionID) } }).pipe(Effect.map(({ ref, text }) => { side.ref = ref; return { content: `BTW answer:\n\n${text}` } }))
  }
  return { start, reply, list: (toolCtx: unknown) => Effect.sync(() => { const parent = options.resolveSessionID(toolCtx); const values = [...sides.values()].filter((side) => side.parentSessionID === parent); return { content: values.length === 0 ? "No BTW side conversations open." : values.map((side) => `${side.sessionID} opened=${new Date(side.createdAt).toISOString()}`).join("\n") } }) }
}
