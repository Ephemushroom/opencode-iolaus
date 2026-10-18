import { Effect } from "effect"
import { Agent, Model } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { DagRunnerError } from "./errors"
import type { DagExecutionIdentity, DagExecutionRef, DagNodeDefinition, DagSteerRequest, JsonValue } from "./types"
import { defaultWorktreePath, ensureWorktree, repositoryRoot } from "./worktree"

export interface DagExecutionResult {
  readonly payload: JsonValue
}

export interface DagRunnerStart {
  readonly runID?: string
  readonly node: DagNodeDefinition
  readonly prompt: string
  readonly attempt: number
  readonly identity?: DagExecutionIdentity
  /** The run's working directory; omitted, the plugin's project directory. */
  readonly directory?: string
}

/** Executes one DAG node. Every method is an Effect so the scheduler can compose, interrupt and retry it. */
export interface DagRunner {
  start(input: DagRunnerStart): Effect.Effect<DagExecutionRef, DagRunnerError>
  wait(ref: DagExecutionRef, requests?: readonly DagSteerRequest[]): Effect.Effect<DagExecutionResult, DagRunnerError>
  admit?(ref: DagExecutionRef): Effect.Effect<void, DagRunnerError>
  verify?(ref: DagExecutionRef): Effect.Effect<void, DagRunnerError>
  steer?(ref: DagExecutionRef, request: DagSteerRequest): Effect.Effect<{ readonly messageID: string }, DagRunnerError>
  /**
   * Picks up a child started by an earlier controller (plugin reload or restart) without prompting it again: waits
   * for it like `wait` when it received its prompt, or returns undefined when it never did.
   */
  reattach(ref: DagExecutionRef, requests?: readonly DagSteerRequest[]): Effect.Effect<DagExecutionResult | undefined, DagRunnerError>
  cancel(ref: DagExecutionRef): Effect.Effect<void, DagRunnerError>
}

/** Promise-shaped runner, used by tests and by hosts that are not Effect-native. */
export interface DagRunnerPromise {
  start(input: DagRunnerStart): Promise<DagExecutionRef>
  wait(ref: DagExecutionRef, requests?: readonly DagSteerRequest[]): Promise<DagExecutionResult>
  admit?(ref: DagExecutionRef): Promise<void>
  verify?(ref: DagExecutionRef): Promise<void>
  steer?(ref: DagExecutionRef, request: DagSteerRequest): Promise<{ readonly messageID: string }>
  /** Optional; a runner without it treats every child from an earlier controller as never prompted. */
  reattach?(ref: DagExecutionRef, requests?: readonly DagSteerRequest[]): Promise<DagExecutionResult | undefined>
  cancel(ref: DagExecutionRef): Promise<void>
}

function lift<A>(nodeID: string | undefined, run: () => Promise<A>): Effect.Effect<A, DagRunnerError> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause instanceof DagRunnerError ? cause : new DagRunnerError({ message: cause instanceof Error ? cause.message : String(cause), ...(nodeID ? { nodeID } : {}), cause }) })
}

export function runnerFromPromise(runner: DagRunnerPromise): DagRunner {
  return {
    start: (input) => lift(input.node.id, () => runner.start(input)),
    wait: (ref, requests) => lift(ref.nodeID, () => runner.wait(ref, requests)),
    ...(runner.admit ? { admit: (ref: DagExecutionRef) => lift(ref.nodeID, () => runner.admit!(ref)) } : {}),
    ...(runner.verify ? { verify: (ref: DagExecutionRef) => lift(ref.nodeID, () => runner.verify!(ref)) } : {}),
    ...(runner.steer ? { steer: (ref: DagExecutionRef, request: DagSteerRequest) => lift(ref.nodeID, () => runner.steer!(ref, request)) } : {}),
    reattach: (ref, requests) => runner.reattach ? lift(ref.nodeID, () => runner.reattach!(ref, requests)) : Effect.succeed(undefined),
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

type SessionApi = Pick<Context["session"], "create" | "prompt" | "synthetic" | "wait" | "get" | "context" | "interrupt">
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
  const verify = (ref: DagExecutionRef) => Effect.gen(function* () {
    if (!ref.identity || ref.sessionID.startsWith(JUDGE_REF)) return
    const session = yield* ctx.session.get({ sessionID: ref.sessionID as never }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    const model = Model.Ref.parse(ref.identity.model)
    if (session.agent !== ref.identity.agent || session.model?.providerID !== model.providerID || session.model?.id !== model.id
      || (session.model?.variant ?? "default") !== (model.variant ?? "default") || session.metadata?.iolaus_execution_token !== ref.identity.token) {
      return yield* new DagRunnerError({ message: `Execution identity drift for ${ref.nodeID}; expected ${ref.identity.agent} on ${ref.identity.model}, got ${session.agent ?? "unknown"} on ${JSON.stringify(session.model)} (execution token ${session.metadata?.iolaus_execution_token === ref.identity.token ? "matches" : "differs"}). The session was not changed.`, nodeID: ref.nodeID, nonRetryable: true })
    }
  })
  const admit = (ref: DagExecutionRef) => Effect.gen(function* () {
    const prompt = pendingPrompts.get(ref.sessionID)
    if (prompt === undefined) return
    yield* verify(ref)
    pendingPrompts.delete(ref.sessionID)
    yield* ctx.session.prompt({ sessionID: ref.sessionID as never, text: prompt, delivery: "queue",
      ...(ref.identity ? { id: `msg_${ref.identity.token.replaceAll("-", "")}` as never } : {}) }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    yield* verify(ref)
  })
  const finish = (ref: DagExecutionRef, requests: readonly DagSteerRequest[] = []) => Effect.gen(function* () {
    const sessionID = ref.sessionID as never
    yield* ctx.session.wait({ sessionID }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    const session = yield* ctx.session.get({ sessionID }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    const messages = yield* ctx.session.context({ sessionID }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    yield* verify(ref)
    let after = -1
    for (const request of requests) {
      const index = messages.findIndex((message) => message.type === "synthetic" && message.id === (request.receipt?.messageID ?? request.messageID))
      if (index < 0) return yield* new DagRunnerError({ message: `Steering delivery unresolved for ${request.requestID}; no delivered host message is visible. Nothing was replayed.`, nodeID: ref.nodeID })
      after = Math.max(after, index)
    }
    const text = assistantText(messages.slice(after + 1))
    if (requests.length && !text) return yield* new DagRunnerError({ message: "Steering result unresolved: no assistant reply follows the delivered supplement", nodeID: ref.nodeID })
    if (session.outcome === "failed") return yield* new DagRunnerError({ message: "Iolaus DAG child session failed", nodeID: ref.nodeID, model: true })
    if (session.outcome === "interrupted") return yield* new DagRunnerError({ message: "Iolaus DAG child session was interrupted", nodeID: ref.nodeID })
    return { payload: { text } }
  })
  return {
    admit,
    verify,
    steer: (ref, request) => Effect.gen(function* () {
      yield* verify(ref)
      const receipt = yield* ctx.session.synthetic({ sessionID: ref.sessionID as never, id: request.messageID as never,
        text: request.text, delivery: "steer", resume: true,
        metadata: { iolaus_steer_request: request.requestID, iolaus_execution_token: ref.identity!.token, iolaus_input_revision: request.revision },
      }).pipe(Effect.mapError(runnerError(ref.nodeID)))
      return { messageID: String(receipt.id) }
    }),
    start: (input) => Effect.gen(function* () {
      if (input.node.kind === "judge") {
        const model = input.node.model === undefined ? undefined : Model.Ref.parse(input.node.model)
        const reply = yield* ctx.generate.text({ prompt: input.prompt, ...(model ? { model } : {}) }).pipe(Effect.mapError(runnerError(input.node.id, true)))
        const key = `${JUDGE_REF}${input.node.id}:${input.attempt}:${Date.now()}`
        judgeReplies.set(key, reply.text)
        return { nodeID: input.node.id, attempt: input.attempt, sessionID: key, ...(input.identity ? { identity: input.identity } : {}) }
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
        title: `Flow · ${input.node.id}`,
        agent: Agent.ID.make(input.node.agent),
        ...(input.node.model === undefined ? {} : { model: Model.Ref.parse(input.node.model) }),
        location: { directory: directory as never },
        metadata: { iolaus_dag_node: input.node.id, iolaus_dag_attempt: input.attempt, ...(input.identity ? { iolaus_execution_token: input.identity.token } : {}), ...(input.runID ? { iolaus_dag_run: input.runID } : {}) },
      }).pipe(Effect.mapError(runnerError(input.node.id, true)))
      pendingPrompts.set(String(session.id), prompt)
      return { nodeID: input.node.id, attempt: input.attempt, sessionID: String(session.id), ...(input.identity ? { identity: input.identity } : {}) }
    }),
    wait: (ref, requests) => Effect.gen(function* () {
      if (ref.sessionID.startsWith(JUDGE_REF)) {
        const text = judgeReplies.get(ref.sessionID)
        judgeReplies.delete(ref.sessionID)
        if (text === undefined) return yield* new DagRunnerError({ message: "Judge reply was lost", nodeID: ref.nodeID })
        return { payload: { text } }
      }
      yield* admit(ref)
      return yield* finish(ref, requests)
    }),
    reattach: (ref, requests) => Effect.gen(function* () {
      // A judge reply and an unsent prompt live only in the controller that started them.
      if (ref.sessionID.startsWith(JUDGE_REF) || pendingPrompts.has(ref.sessionID)) return undefined
      yield* ctx.session.wait({ sessionID: ref.sessionID as never }).pipe(Effect.mapError(runnerError(ref.nodeID)))
      const messages = yield* ctx.session.context({ sessionID: ref.sessionID as never }).pipe(Effect.mapError(runnerError(ref.nodeID)))
      const prompted = (messages as readonly unknown[]).some((message) => typeof message === "object" && message !== null && (message as { type?: unknown }).type === "user")
      return prompted ? yield* finish(ref, requests) : undefined
    }),
    cancel: (ref) => Effect.gen(function* () {
      if (ref.sessionID.startsWith(JUDGE_REF)) { judgeReplies.delete(ref.sessionID); return }
      pendingPrompts.delete(ref.sessionID)
      yield* ctx.session.interrupt({ sessionID: ref.sessionID as never, resume: false }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    }),
  }
}
