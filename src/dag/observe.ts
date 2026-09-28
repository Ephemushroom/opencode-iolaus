import { Cause, Effect, Stream, type Scope } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { DagController } from "./controller"
import { assistantText } from "./runner"

type Trace = (event: string, data?: Record<string, unknown>) => void

/** Prompts are stored for the details pane, not replayed, so a long one is cut. */
const PROMPT_LIMIT = 4000

export interface SubagentOutcome {
  readonly sessionID?: string
  readonly status?: string
  readonly text?: string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Reads a native subagent tool result: the structured `{output: {sessionID, status,
 * output}}` the host returns, or failing that the `<subagent sessionID=… state=…>`
 * text and the background notice the model sees.
 */
export function subagentOutcome(result: unknown): SubagentOutcome {
  const value = record(result)
  const output = record(value.output)
  if (typeof output.sessionID === "string") {
    return { sessionID: output.sessionID, ...(typeof output.status === "string" ? { status: output.status } : {}), ...(typeof output.output === "string" ? { text: output.output } : {}) }
  }
  const text = Array.isArray(value.content) ? value.content.map((part) => String(record(part).text ?? "")).join("\n") : typeof value.content === "string" ? value.content : ""
  const tag = text.match(/<subagent sessionID="(ses_[^"]+)" state="([a-z]+)">\n?([\s\S]*?)\n?<\/subagent>/)
  if (tag) return { sessionID: tag[1], status: tag[2], text: tag[3] }
  const background = text.match(/\(sessionID: (ses_\w+)\)/)
  return background ? { sessionID: background[1], status: "running" } : {}
}

interface Call {
  readonly runID: string
  readonly nodeID: string
  readonly owner: string
  readonly caller: string
  readonly agent: string
  readonly title: string
  sessionID?: string
}

interface Child {
  readonly runID: string
  readonly nodeID: string
  readonly owner: string
}

/**
 * Records every native subagent call as a node of its owner's observed DAG run, so
 * the DAG view shows it. The call itself is untouched: follow-ups by sessionID,
 * background runs and completion notices stay the host's. A call made inside a
 * child session hangs under that child's node in the same run. Correlation lives
 * in memory, so after a restart a follow-up to an older child starts a new node.
 */
export function registerSubagentObserver(ctx: Context, controller: DagController, trace: Trace): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const calls = new Map<string, Call>()
    const children = new Map<string, Child>()
    const safe = (what: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.asVoid,
      Effect.catchCause((cause) => Effect.sync(() => trace("iolaus.subagent.observe-failed", { what, cause: Cause.pretty(cause).slice(0, 500) }))))
    // "default" is the host's no-op variant, so it is left off.
    const modelOf = (value: unknown) => {
      const ref = record(value)
      return typeof ref.providerID === "string" && typeof ref.id === "string" ? `${ref.providerID}/${ref.id}${typeof ref.variant === "string" && ref.variant !== "default" ? `#${ref.variant}` : ""}` : undefined
    }
    const attach = (call: Call, sessionID: string, known?: string) => Effect.gen(function* () {
      call.sessionID = sessionID
      children.set(sessionID, { runID: call.runID, nodeID: call.nodeID, owner: call.owner })
      // An agent without a pinned model announces its session before the model is resolved; read it back.
      const model = known ?? (yield* ctx.session.get({ sessionID: sessionID as never }).pipe(Effect.map((session) => modelOf((session as { model?: unknown }).model)), Effect.catch(() => Effect.succeed(undefined))))
      yield* controller.observed(call.runID, call.nodeID, { status: "running", sessionID, ...(model ? { model } : {}) })
    })

    yield* ctx.tool.hook("execute.before", (event) => event.tool !== "subagent" ? Effect.void : Effect.gen(function* () {
      const input = record(event.input)
      const caller = String(event.sessionID)
      const followed = typeof input.sessionID === "string" ? children.get(input.sessionID) : undefined
      const agent = typeof input.agent === "string" ? input.agent : "subagent"
      const title = typeof input.description === "string" && input.description.trim() ? input.description.trim() : agent
      if (followed) {
        calls.set(String(event.id), { ...followed, caller, agent, title, sessionID: input.sessionID as string })
        yield* controller.observed(followed.runID, followed.nodeID, { status: "running" })
        trace("iolaus.subagent.followed", { owner: followed.owner, nodeID: followed.nodeID })
        return
      }
      const parent = children.get(caller)
      const owner = parent?.owner ?? caller
      const node = yield* controller.observe({ ownerSessionID: owner, agent, title, prompt: typeof input.prompt === "string" ? input.prompt.slice(0, PROMPT_LIMIT) : "",
        ...(parent ? { parentNodeID: parent.nodeID } : {}), ...(typeof input.sessionID === "string" ? { sessionID: input.sessionID } : {}) })
      const call: Call = { ...node, owner, caller, agent, title }
      calls.set(String(event.id), call)
      if (typeof input.sessionID === "string") yield* attach(call, input.sessionID)
      trace("iolaus.subagent.observed", { owner, runID: node.runID, nodeID: node.nodeID, agent, nested: parent !== undefined, background: input.background === true })
    }).pipe(safe("before")))

    yield* ctx.tool.hook("execute.after", (event) => event.tool !== "subagent" ? Effect.void : Effect.gen(function* () {
      const call = calls.get(String(event.id))
      if (!call) return
      calls.delete(String(event.id))
      if (event.status === "error") {
        yield* controller.observed(call.runID, call.nodeID, { status: "failed", error: event.error.message })
        return
      }
      const outcome = subagentOutcome(event.result)
      if (outcome.sessionID && call.sessionID !== outcome.sessionID) yield* attach(call, outcome.sessionID)
      if (outcome.status === "completed") yield* controller.observed(call.runID, call.nodeID, { status: "completed", text: outcome.text ?? "" })
      else if (outcome.status && outcome.status !== "running") yield* controller.observed(call.runID, call.nodeID, { status: outcome.status === "interrupted" ? "interrupted" : "failed", error: outcome.text || `subagent ${outcome.status}` })
    }).pipe(safe("after")))

    const settle = (sessionID: string, type: string) => Effect.gen(function* () {
      // A call the host refused before running it (unknown tool, depth limit) reaches no execute.after; it ends with its caller's turn.
      for (const [id, call] of calls) {
        if (call.caller !== sessionID || call.sessionID !== undefined) continue
        calls.delete(id)
        yield* controller.observed(call.runID, call.nodeID, { status: "failed", error: "The host did not run this subagent call" })
      }
      const child = children.get(sessionID)
      if (!child) return
      if (type === "session.execution.succeeded") {
        const messages = (yield* ctx.session.context({ sessionID: sessionID as never })) as readonly unknown[]
        const model = modelOf(record([...messages].reverse().find((message) => record(message).type === "assistant")).model)
        yield* controller.observed(child.runID, child.nodeID, { status: "completed", text: assistantText(messages), ...(model ? { model } : {}) })
      } else yield* controller.observed(child.runID, child.nodeID, type === "session.execution.interrupted" ? { status: "interrupted", error: "The subagent session was interrupted" } : { status: "failed", error: "The subagent session failed" })
    })

    yield* Effect.forkScoped(Stream.runForEach(ctx.event.subscribe(), (event) => {
      const data = record((event as { data?: unknown }).data)
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      if (!sessionID) return Effect.void
      if (event.type === "session.created" && typeof data.parentID === "string") {
        // The child exists before the tool returns; pair it with the oldest unpaired call from that parent.
        const candidates = [...calls.values()].filter((call) => call.caller === data.parentID && call.sessionID === undefined && (data.agent === undefined || call.agent === data.agent))
        const call = candidates.find((candidate) => candidate.title === data.title) ?? candidates[0]
        return call ? attach(call, sessionID, modelOf(data.model)).pipe(safe("created")) : Effect.void
      }
      if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
        return Effect.forkScoped(settle(sessionID, event.type).pipe(safe("settle"))).pipe(Effect.asVoid)
      }
      return Effect.void
    }).pipe(safe("events")))
    trace("iolaus.subagent.observer-registered")
  })
}
