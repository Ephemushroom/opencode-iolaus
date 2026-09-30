import { Effect } from "effect"
import { Agent, Model } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { DagRunnerError } from "./errors"
import type { DagExecutionRef, DagNodeDefinition, JsonValue } from "./types"
import { defaultWorktreePath, ensureWorktree, repositoryRoot } from "./worktree"

export interface DagExecutionResult {
  readonly payload: JsonValue
}

export interface DagRunnerStart {
  readonly runID?: string
  readonly node: DagNodeDefinition
  readonly prompt: string
  readonly attempt: number
  /** The run's working directory; omitted, the plugin's project directory. */
  readonly directory?: string
}

/** Executes one DAG node. Every method is an Effect so the scheduler can compose, interrupt and retry it. */
export interface DagRunner {
  start(input: DagRunnerStart): Effect.Effect<DagExecutionRef, DagRunnerError>
  wait(ref: DagExecutionRef): Effect.Effect<DagExecutionResult, DagRunnerError>
  /**
   * Picks up a child started by an earlier controller (plugin reload or restart) without prompting it again: waits
   * for it like `wait` when it received its prompt, or returns undefined when it never did.
   */
  reattach(ref: DagExecutionRef): Effect.Effect<DagExecutionResult | undefined, DagRunnerError>
  cancel(ref: DagExecutionRef): Effect.Effect<void, DagRunnerError>
}

/** Promise-shaped runner, used by tests and by hosts that are not Effect-native. */
export interface DagRunnerPromise {
  start(input: DagRunnerStart): Promise<DagExecutionRef>
  wait(ref: DagExecutionRef): Promise<DagExecutionResult>
  /** Optional; a runner without it treats every child from an earlier controller as never prompted. */
  reattach?(ref: DagExecutionRef): Promise<DagExecutionResult | undefined>
  cancel(ref: DagExecutionRef): Promise<void>
}

function lift<A>(nodeID: string | undefined, run: () => Promise<A>): Effect.Effect<A, DagRunnerError> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause instanceof DagRunnerError ? cause : new DagRunnerError({ message: cause instanceof Error ? cause.message : String(cause), ...(nodeID ? { nodeID } : {}), cause }) })
}

export function runnerFromPromise(runner: DagRunnerPromise): DagRunner {
  return {
    start: (input) => lift(input.node.id, () => runner.start(input)),
    wait: (ref) => lift(ref.nodeID, () => runner.wait(ref)),
    reattach: (ref) => runner.reattach ? lift(ref.nodeID, () => runner.reattach!(ref)) : Effect.succeed(undefined),
    cancel: (ref) => lift(ref.nodeID, () => runner.cancel(ref)),
  }
}

/** The last assistant text in a session context, which is what a child session reports. */
export function assistantText(messages: readonly unknown[]): string {
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
type GenerateApi = Pick<Context["generate"], "text">

function runnerError(nodeID: string, model = false) {
  return (cause: unknown) => new DagRunnerError({ message: cause instanceof Error ? cause.message : String(cause), nodeID, cause, ...(model ? { model } : {}) })
}

/** Branch and path of a worktree node: one per run and node, reused by its retries. */
export function nodeWorktree(directory: string, runID: string, nodeID: string): { readonly branch: string; readonly path: string } {
  const root = repositoryRoot(directory)
  if (!root) throw new Error(`Node ${nodeID} asks for a worktree, but ${directory} is not a git repository`)
  const name = `iolaus-${runID.slice(0, 8)}-${nodeID.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`
  return { branch: `iolaus/${name.slice("iolaus-".length)}`, path: defaultWorktreePath(root, name) }
}

/** Prefix marking a judge execution ref; judge nodes have no session, the ref carries the completed text. */
const JUDGE_REF = "judge:"

/**
 * Runs agent nodes as native OpenCode child sessions on the node's agent and
 * model, and judge nodes as one `generate.text` call. A judge has no session,
 * so its ref encodes the reply and `wait` returns it without a host round trip.
 */
export function createOpenCodeDagRunner(ctx: { readonly session: SessionApi; readonly generate: GenerateApi; readonly location: { readonly directory: string } }): DagRunner {
  const judgeReplies = new Map<string, string>()
  const pendingPrompts = new Map<string, string>()
  const finish = (ref: DagExecutionRef) => Effect.gen(function* () {
    const sessionID = ref.sessionID as never
    yield* ctx.session.wait({ sessionID }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    const session = yield* ctx.session.get({ sessionID }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    const messages = yield* ctx.session.context({ sessionID }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    if (session.outcome === "failed") return yield* new DagRunnerError({ message: "Iolaus DAG child session failed", nodeID: ref.nodeID, model: true })
    if (session.outcome === "interrupted") return yield* new DagRunnerError({ message: "Iolaus DAG child session was interrupted", nodeID: ref.nodeID })
    return { payload: { text: assistantText(messages as readonly unknown[]) } }
  })
  return {
    start: (input) => Effect.gen(function* () {
      if (input.node.kind === "judge") {
        const model = input.node.model === undefined ? undefined : Model.Ref.parse(input.node.model)
        const reply = yield* ctx.generate.text({ prompt: input.prompt, ...(model ? { model } : {}) }).pipe(Effect.mapError(runnerError(input.node.id, true)))
        const key = `${JUDGE_REF}${input.node.id}:${input.attempt}:${Date.now()}`
        judgeReplies.set(key, reply.text)
        return { nodeID: input.node.id, attempt: input.attempt, sessionID: key }
      }
      if (input.node.agent === undefined) return yield* new DagRunnerError({ message: `Iolaus DAG node ${input.node.id} has no execution target`, nodeID: input.node.id })
      let directory = input.directory ?? ctx.location.directory
      let prompt = input.prompt
      if (input.node.worktree) {
        const base = directory
        const tree = yield* Effect.try({ try: () => { const tree = nodeWorktree(base, input.runID ?? "run", input.node.id); ensureWorktree(base, tree.path, tree.branch); return tree }, catch: runnerError(input.node.id) })
        directory = tree.path
        prompt = `<iolaus-worktree branch="${tree.branch}" path="${tree.path}">\nYou work in your own git worktree ${tree.path} on branch ${tree.branch}, cut from ${base} at its HEAD (uncommitted changes there are not here). Commit your work to ${tree.branch}; do not touch other worktrees or branches.\n</iolaus-worktree>\n\n${prompt}`
      }
      const session = yield* ctx.session.create({
        title: `Iolaus DAG · ${input.node.id}`,
        agent: Agent.ID.make(input.node.agent),
        ...(input.node.model === undefined ? {} : { model: Model.Ref.parse(input.node.model) }),
        location: { directory: directory as never },
        metadata: { iolaus_dag_node: input.node.id, iolaus_dag_attempt: input.attempt, ...(input.runID ? { iolaus_dag_run: input.runID } : {}) },
      }).pipe(Effect.mapError(runnerError(input.node.id, true)))
      pendingPrompts.set(String(session.id), prompt)
      return { nodeID: input.node.id, attempt: input.attempt, sessionID: String(session.id) }
    }),
    wait: (ref) => Effect.gen(function* () {
      if (ref.sessionID.startsWith(JUDGE_REF)) {
        const text = judgeReplies.get(ref.sessionID)
        judgeReplies.delete(ref.sessionID)
        if (text === undefined) return yield* new DagRunnerError({ message: "Judge reply was lost", nodeID: ref.nodeID })
        return { payload: { text } }
      }
      const sessionID = ref.sessionID as never
      const prompt = pendingPrompts.get(ref.sessionID)
      if (prompt !== undefined) {
        pendingPrompts.delete(ref.sessionID)
        yield* ctx.session.prompt({ sessionID, text: prompt, delivery: "queue" }).pipe(Effect.mapError(runnerError(ref.nodeID)))
      }
      return yield* finish(ref)
    }),
    reattach: (ref) => Effect.gen(function* () {
      // A judge reply and an unsent prompt live only in the controller that started them.
      if (ref.sessionID.startsWith(JUDGE_REF) || pendingPrompts.has(ref.sessionID)) return undefined
      const messages = yield* ctx.session.context({ sessionID: ref.sessionID as never }).pipe(Effect.mapError(runnerError(ref.nodeID)))
      const prompted = (messages as readonly unknown[]).some((message) => typeof message === "object" && message !== null && (message as { type?: unknown }).type === "user")
      return prompted ? yield* finish(ref) : undefined
    }),
    cancel: (ref) => Effect.gen(function* () {
      if (ref.sessionID.startsWith(JUDGE_REF)) { judgeReplies.delete(ref.sessionID); return }
      pendingPrompts.delete(ref.sessionID)
      yield* ctx.session.interrupt({ sessionID: ref.sessionID as never, resume: false }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    }),
  }
}
