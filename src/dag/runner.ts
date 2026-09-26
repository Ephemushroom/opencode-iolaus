import { Effect } from "effect"
import { Agent, Model } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { DagRunnerError } from "./errors"
import type { DagExecutionRef, DagNodeDefinition, JsonValue } from "./types"

export interface DagExecutionResult {
  readonly payload: JsonValue
}

export interface DagRunnerStart {
  readonly node: DagNodeDefinition
  readonly prompt: string
  readonly attempt: number
}

/** Executes one DAG node. Every method is an Effect so the scheduler can compose, interrupt and retry it. */
export interface DagRunner {
  start(input: DagRunnerStart): Effect.Effect<DagExecutionRef, DagRunnerError>
  wait(ref: DagExecutionRef): Effect.Effect<DagExecutionResult, DagRunnerError>
  cancel(ref: DagExecutionRef): Effect.Effect<void, DagRunnerError>
}

/** Promise-shaped runner, used by tests and by hosts that are not Effect-native. */
export interface DagRunnerPromise {
  start(input: DagRunnerStart): Promise<DagExecutionRef>
  wait(ref: DagExecutionRef): Promise<DagExecutionResult>
  cancel(ref: DagExecutionRef): Promise<void>
}

function lift<A>(nodeID: string | undefined, run: () => Promise<A>): Effect.Effect<A, DagRunnerError> {
  return Effect.tryPromise({ try: run, catch: (cause) => new DagRunnerError({ message: cause instanceof Error ? cause.message : String(cause), ...(nodeID ? { nodeID } : {}), cause }) })
}

export function runnerFromPromise(runner: DagRunnerPromise): DagRunner {
  return {
    start: (input) => lift(input.node.id, () => runner.start(input)),
    wait: (ref) => lift(ref.nodeID, () => runner.wait(ref)),
    cancel: (ref) => lift(ref.nodeID, () => runner.cancel(ref)),
  }
}

function assistantText(messages: readonly unknown[]): string {
  for (const raw of [...messages].reverse()) {
    if (!raw || typeof raw !== "object") continue
    const message = raw as { type?: unknown; content?: unknown }
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
      .map((part) => part.text)
      .join("\n")
    if (text) return text
  }
  return ""
}

type SessionApi = Pick<Context["session"], "create" | "prompt" | "wait" | "get" | "context" | "interrupt">

function runnerError(nodeID: string) {
  return (cause: unknown) => new DagRunnerError({ message: cause instanceof Error ? cause.message : String(cause), nodeID, cause })
}

/** Runs a node as a native OpenCode child session on the node's agent and model. */
export function createOpenCodeDagRunner(ctx: { readonly session: SessionApi; readonly location: { readonly directory: string } }): DagRunner {
  return {
    start: (input) => Effect.gen(function* () {
      if (input.node.agent === undefined) return yield* new DagRunnerError({ message: `Iolaus DAG node ${input.node.id} has no execution target`, nodeID: input.node.id })
      const session = yield* ctx.session.create({
        title: `Iolaus DAG · ${input.node.id}`,
        agent: Agent.ID.make(input.node.agent),
        ...(input.node.model === undefined ? {} : { model: Model.Ref.parse(input.node.model) }),
        location: { directory: ctx.location.directory as never },
        metadata: { iolaus_dag_node: input.node.id, iolaus_dag_attempt: input.attempt },
      }).pipe(Effect.mapError(runnerError(input.node.id)))
      yield* ctx.session.prompt({ sessionID: session.id, text: input.prompt, delivery: "queue" }).pipe(Effect.mapError(runnerError(input.node.id)))
      return { nodeID: input.node.id, attempt: input.attempt, sessionID: String(session.id) }
    }),
    wait: (ref) => Effect.gen(function* () {
      const sessionID = ref.sessionID as never
      yield* ctx.session.wait({ sessionID }).pipe(Effect.mapError(runnerError(ref.nodeID)))
      const session = yield* ctx.session.get({ sessionID }).pipe(Effect.mapError(runnerError(ref.nodeID)))
      const messages = yield* ctx.session.context({ sessionID }).pipe(Effect.mapError(runnerError(ref.nodeID)))
      if (session.outcome === "failed") return yield* new DagRunnerError({ message: "Iolaus DAG child session failed", nodeID: ref.nodeID })
      if (session.outcome === "interrupted") return yield* new DagRunnerError({ message: "Iolaus DAG child session was interrupted", nodeID: ref.nodeID })
      return { payload: { text: assistantText(messages as readonly unknown[]) } }
    }),
    cancel: (ref) => ctx.session.interrupt({ sessionID: ref.sessionID as never, resume: false }).pipe(Effect.asVoid, Effect.mapError(runnerError(ref.nodeID))),
  }
}
