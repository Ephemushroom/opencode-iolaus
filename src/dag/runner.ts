import { Effect } from "effect"
import { Agent, Model } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { WorkspaceID } from "@opencode/schema/workspace-id"
import type { SessionApi as ClientSessionApi } from "@opencode/client/effect/api"
import type { Context } from "@opencode/plugin/effect/plugin"
import { DagRunnerError } from "./errors"
import type { DagExecutionIdentity, DagExecutionRef, DagNodeDefinition, DagSteerRequest, JsonValue } from "./types"
import { defaultWorktreePath, ensureWorktree, recoveryDirectory, repositoryRoot } from "./worktree"
import { checkpoint, normalizedModel, PROVIDER_FAILURES, recoveryTerminal, renderHandoff, validateInputs, type CheckpointInput, type PortableHandoff, type RecoverySecurity } from "./rescue"
import { fingerprint } from "./fingerprint"

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
  readonly handoff?: PortableHandoff
}

/** Executes one DAG node. Every method is an Effect so the scheduler can compose, interrupt and retry it. */
export interface DagRunner {
  checkpoint?(input: CheckpointInput): Effect.Effect<PortableHandoff, DagRunnerError>
  ownerModel?(owner: string, handoff: PortableHandoff): Effect.Effect<string, DagRunnerError>
  validateHandoff?(handoff: PortableHandoff, model: string, child?: DagExecutionRef, requests?: readonly DagSteerRequest[]): Effect.Effect<void, DagRunnerError>
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
  checkpoint?(input: CheckpointInput): Promise<PortableHandoff>
  ownerModel?(owner: string, handoff: PortableHandoff): Promise<string>
  validateHandoff?(handoff: PortableHandoff, model: string, child?: DagExecutionRef, requests?: readonly DagSteerRequest[]): Promise<void>
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
    ...(runner.checkpoint ? { checkpoint: (input: CheckpointInput) => lift(input.ref.nodeID, () => runner.checkpoint!(input)) } : {}),
    ...(runner.ownerModel ? { ownerModel: (owner: string, handoff: PortableHandoff) => lift(undefined, () => runner.ownerModel!(owner, handoff)) } : {}),
    ...(runner.validateHandoff ? { validateHandoff: (handoff: PortableHandoff, model: string, child?: DagExecutionRef, requests?: readonly DagSteerRequest[]) => lift(child?.nodeID, () => runner.validateHandoff!(handoff, model, child, requests)) } : {}),
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
type Inbox = Pick<ClientSessionApi<unknown>["inbox"], "list">

function readonlyInbox(session: SessionApi): Inbox | undefined {
  if (!("inbox" in session) || typeof session.inbox !== "object" || session.inbox === null || !("list" in session.inbox) || typeof session.inbox.list !== "function") return undefined
  return session.inbox as Inbox
}

type RunnerContext = { readonly session: SessionApi; readonly generate: GenerateApi; readonly location: { readonly directory: string; readonly workspaceID?: string }; readonly agent?: Pick<Context["agent"], "get">; readonly model?: Pick<Context["model"], "list">; readonly permission?: Pick<Context["permission"], "list"> }

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
export function createOpenCodeDagRunner(ctx: RunnerContext, options: { readonly ownerModel?: boolean } = {}): DagRunner {
  const inbox = readonlyInbox(ctx.session)
  if (options.ownerModel && (!inbox || !ctx.agent || !ctx.model || !ctx.permission)) throw new Error("rescue.ownerModel is unsupported by this host: requires the verified read-only session.inbox.list capability and security/catalog inspection")
  const judgeReplies = new Map<string, string>()
  const pendingPrompts = new Map<string, string>()
  const pendingHandoffs = new Map<string, PortableHandoff>()
  const unsafe = (message: string, nodeID?: string) => new DagRunnerError({ message, nodeID, nonRetryable: true })
  const security = (session: Session.Info) => Effect.gen(function* () {
    if (!session.agent || session.revert) return yield* unsafe("missing_agent_or_reverted_history")
    const location = { directory: String(session.location.directory), ...(session.location.workspaceID ? { workspaceID: String(session.location.workspaceID) } : {}) }
    const lane = yield* ctx.agent!.get({ agentID: session.agent, location }).pipe(Effect.mapError(() => unsafe("lane_unavailable")))
    if (String(lane.location.directory) !== location.directory) return yield* unsafe("lane_location_unavailable")
    const directory = yield* Effect.try({ try: () => recoveryDirectory(location.directory), catch: () => unsafe("recovery_directory_missing_or_moved") })
    return { location, ...directory, permissions: session.permissions ?? [], laneHash: fingerprint(lane.data.permissions) } satisfies RecoverySecurity
  })
  const inboxEmpty = (ref: DagExecutionRef) => Effect.gen(function* () {
    const sessionID = Session.ID.make(ref.sessionID)
    const pending = yield* inbox!.list({ sessionID }).pipe(Effect.mapError(() => unsafe("inbox_inspection_unavailable", ref.nodeID)))
    if (pending.length) return yield* unsafe("pending_host_input", ref.nodeID)
  })
  const inputEmpty = (ref: DagExecutionRef) => Effect.gen(function* () {
    yield* inboxEmpty(ref)
    const sessionID = Session.ID.make(ref.sessionID)
    const permissions = yield* ctx.permission!.list({ sessionID }).pipe(Effect.mapError(() => unsafe("permission_inspection_unavailable", ref.nodeID)))
    if (permissions.length) return yield* unsafe("pending_permission", ref.nodeID)
  })
  const availableModel = (value: string, location: RecoverySecurity["location"]) => Effect.gen(function* () {
    const ref = Model.Ref.parse(value)
    const catalog = yield* ctx.model!.list({ location }).pipe(Effect.mapError(() => unsafe("model_catalog_unavailable")))
    if (String(catalog.location.directory) !== location.directory || (location.workspaceID && ctx.location.workspaceID !== location.workspaceID)) return yield* unsafe("model_catalog_location_unavailable")
    const model = catalog.data.find((model) => model.providerID === ref.providerID && model.id === ref.id)
    if (!model?.enabled || !model.capabilities.tools || !model.capabilities.input.includes("text") || !model.capabilities.output.includes("text")
      || (ref.variant && ref.variant !== "default" && !model.variants.some((variant) => variant.id === ref.variant))) return yield* unsafe("model_unavailable_or_incompatible")
  })
  const verify = (ref: DagExecutionRef) => Effect.gen(function* () {
    if (!ref.identity || ref.sessionID.startsWith(JUDGE_REF)) return
    const session = yield* ctx.session.get({ sessionID: ref.sessionID as never }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    const model = Model.Ref.parse(ref.identity.model)
    if (session.agent !== ref.identity.agent || session.model?.providerID !== model.providerID || session.model?.id !== model.id
      || (session.model?.variant ?? "default") !== (model.variant ?? "default") || session.metadata?.iolaus_execution_token !== ref.identity.token) {
      return yield* new DagRunnerError({ message: `Execution identity drift for ${ref.nodeID}; expected ${ref.identity.agent} on ${ref.identity.model}, got ${session.agent ?? "unknown"} on ${JSON.stringify(session.model)} (execution token ${session.metadata?.iolaus_execution_token === ref.identity.token ? "matches" : "differs"}). The session was not changed.`, nodeID: ref.nodeID, nonRetryable: true })
    }
    if (ref.origin) {
      const current = yield* security(session)
      const { prompt: _prompt, ...expected } = ref.origin
      if (fingerprint(current) !== fingerprint(expected)) return yield* unsafe("execution_security_or_location_drift", ref.nodeID)
    }
  })
  const validateHandoff = (handoff: PortableHandoff, model: string, child?: DagExecutionRef, requests: readonly DagSteerRequest[] = []) => Effect.gen(function* () {
    if (!handoff.checkpoints.length) return yield* unsafe("missing_handoff_history")
    yield* Effect.try({ try: () => renderHandoff(handoff), catch: (cause) => unsafe(String(cause)) })
    for (const entry of handoff.checkpoints) {
      yield* verify(entry.source)
      const sessionID = Session.ID.make(entry.source.sessionID)
      const session = yield* ctx.session.get({ sessionID }).pipe(Effect.mapError(() => unsafe("source_unavailable")))
      const messages = yield* ctx.session.context({ sessionID }).pipe(Effect.mapError(() => unsafe("source_history_unavailable")))
      if (session.outcome !== entry.outcome || messages.at(-1)?.type !== "idle" || fingerprint(messages) !== entry.contextHash) return yield* unsafe("source_terminal_or_context_changed")
      yield* inputEmpty(entry.source)
    }
    yield* availableModel(model, handoff.checkpoints.at(-1)!.source.origin!.location)
    if (child) {
      yield* verify(child)
      yield* inputEmpty(child)
      const messages = yield* ctx.session.context({ sessionID: Session.ID.make(child.sessionID) }).pipe(Effect.mapError(() => unsafe("child_history_unavailable")))
      yield* Effect.try({ try: () => validateInputs(child, messages, requests), catch: (cause) => unsafe(String(cause)) })
    }
  })
  const admit = (ref: DagExecutionRef) => Effect.gen(function* () {
    const prompt = pendingPrompts.get(ref.sessionID)
    if (prompt === undefined) return
    yield* verify(ref)
    const handoff = pendingHandoffs.get(ref.sessionID)
    if (handoff) {
      yield* validateHandoff(handoff, ref.identity!.model)
      yield* inputEmpty(ref)
      const messages = yield* ctx.session.context({ sessionID: Session.ID.make(ref.sessionID) }).pipe(Effect.mapError(() => unsafe("child_history_unavailable")))
      if (messages.length) return yield* unsafe("unexpected_fresh_child_input")
      for (const entry of handoff.checkpoints) yield* inboxEmpty(entry.source)
      yield* inboxEmpty(ref)
    }
    pendingPrompts.delete(ref.sessionID)
    pendingHandoffs.delete(ref.sessionID)
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
      const message = messages[index]!
      if (options.ownerModel && (index <= after || !request.receipt || request.state === "reserved" || request.state === "unresolved" || message.type !== "synthetic"
        || message.text !== request.text || message.metadata?.iolaus_steer_request !== request.requestID || message.metadata?.iolaus_execution_token !== ref.identity?.token
        || message.metadata?.iolaus_input_revision !== request.revision)) return yield* unsafe("Steering delivery unresolved: exact input receipt/order does not match", ref.nodeID)
      after = Math.max(after, index)
    }
    const text = assistantText(messages.slice(after + 1))
    const terminal = options.ownerModel ? recoveryTerminal(messages) : undefined
    if (options.ownerModel && (session.outcome === "failed" || terminal?.outcome === "failed")) {
      const failure = terminal?.outcome === "failed" ? terminal.error?.type : undefined
      return yield* new DagRunnerError({ message: "Iolaus DAG child session failed", nodeID: ref.nodeID, model: true, deliveredRequests: requests.map((request) => request.requestID), ...(failure && PROVIDER_FAILURES.has(failure) ? { providerFailure: failure } : {}) })
    }
    if (requests.length && !text) return yield* new DagRunnerError({ message: "Steering result unresolved: no assistant reply follows the delivered supplement", nodeID: ref.nodeID })
    if (session.outcome === "failed") return yield* new DagRunnerError({ message: "Iolaus DAG child session failed", nodeID: ref.nodeID, model: true })
    if (session.outcome === "interrupted") return yield* new DagRunnerError({ message: "Iolaus DAG child session was interrupted", nodeID: ref.nodeID })
    return { payload: { text } }
  })
  return {
    ...(options.ownerModel ? {
      checkpoint: (input: CheckpointInput) => Effect.gen(function* () {
        yield* verify(input.ref)
        const sessionID = Session.ID.make(input.ref.sessionID)
        const session = yield* ctx.session.get({ sessionID }).pipe(Effect.mapError(() => unsafe("source_unavailable")))
        const messages = yield* ctx.session.context({ sessionID }).pipe(Effect.mapError(() => unsafe("source_history_unavailable")))
        const last = messages.at(-1)
        const terminal = recoveryTerminal(messages)
        const expected = input.terminal ?? "failed"
        if (last?.type !== "idle" || session.outcome !== last.outcome || terminal?.outcome !== expected || (expected === "failed" && (!terminal.error || !PROVIDER_FAILURES.has(terminal.error.type)))) return yield* unsafe("ineligible_terminal_failure")
        yield* inputEmpty(input.ref)
        const handoff = yield* Effect.try({ try: () => checkpoint(input, messages), catch: (cause) => unsafe(cause instanceof Error ? cause.message : String(cause)) })
        yield* verify(input.ref)
        return handoff
      }),
      ownerModel: (owner: string, handoff: PortableHandoff) => Effect.gen(function* () {
        const session = yield* ctx.session.get({ sessionID: Session.ID.make(owner) }).pipe(Effect.mapError(() => unsafe("owner_unavailable")))
        if (!session.model) return yield* unsafe("owner_has_no_model")
        const model = normalizedModel(`${session.model.providerID}/${session.model.id}${session.model.variant ? `#${session.model.variant}` : ""}`)
        const source = handoff.checkpoints.at(-1)?.source.origin
        if (!source) return yield* unsafe("missing_handoff_history")
        yield* availableModel(model, source.location)
        return model
      }),
      validateHandoff,
    } : {}),
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
      const prior = input.handoff?.checkpoints.at(-1)?.source.origin
      if (input.handoff) {
        if (!prior) return yield* unsafe("missing_handoff_history", input.node.id)
        yield* validateHandoff(input.handoff, input.node.model!)
        directory = prior.location.directory
        prompt = yield* Effect.try({ try: () => renderHandoff(input.handoff!, input.prompt), catch: (cause) => unsafe(String(cause)) })
      } else if (input.node.worktree) {
        const base = directory
        const tree = yield* Effect.try({ try: () => { const tree = nodeWorktree(base, input.runID ?? "run", input.node.id); ensureWorktree(base, tree.path, tree.branch); return tree }, catch: runnerError(input.node.id) })
        directory = tree.path
        prompt = `<iolaus-worktree branch="${tree.branch}" path="${tree.path}">\nYou work in your own git worktree ${tree.path} on branch ${tree.branch}, cut from ${base} at its HEAD (uncommitted changes there are not here). Commit your work to ${tree.branch}; do not touch other worktrees or branches.\n</iolaus-worktree>\n\n${prompt}`
      }
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory), ...(prior?.location.workspaceID ? { workspaceID: WorkspaceID.make(prior.location.workspaceID) } : {}) })
      const session = yield* ctx.session.create({
        title: `Flow · ${input.node.id}`,
        agent: Agent.ID.make(input.node.agent),
        ...(input.node.model === undefined ? {} : { model: Model.Ref.parse(input.node.model) }),
        location,
        ...(prior ? { permissions: prior.permissions } : {}),
        metadata: { iolaus_dag_node: input.node.id, iolaus_dag_attempt: input.attempt, ...(input.identity ? { iolaus_execution_token: input.identity.token } : {}), ...(input.runID ? { iolaus_dag_run: input.runID } : {}) },
      }).pipe(Effect.mapError((cause) => input.handoff ? unsafe(`Continuation creation unresolved: ${String(cause)}. Nothing will be replayed.`, input.node.id) : runnerError(input.node.id, true)(cause)))
      const origin = options.ownerModel ? { ...yield* security(session), prompt } : undefined
      if (prior && origin && fingerprint({ ...origin, prompt: undefined }) !== fingerprint({ ...prior, prompt: undefined })) return yield* unsafe("continuation_security_or_location_drift", input.node.id)
      pendingPrompts.set(String(session.id), prompt)
      if (input.handoff) pendingHandoffs.set(String(session.id), input.handoff)
      return { nodeID: input.node.id, attempt: input.attempt, sessionID: String(session.id), ...(input.identity ? { identity: input.identity } : {}), ...(origin ? { origin } : {}) }
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
      pendingHandoffs.delete(ref.sessionID)
      yield* ctx.session.interrupt({ sessionID: ref.sessionID as never, resume: false }).pipe(Effect.mapError(runnerError(ref.nodeID)))
    }),
  }
}
