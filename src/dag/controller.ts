import { randomUUID } from "node:crypto"
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect"
import { evaluateCondition } from "./condition"
import { DagRunnerError, DagValidationError, errorMessage } from "./errors"
import { dependencyState, isGate, validateDefinition } from "./graph"
import { growLoop } from "./loop"
import { fingerprint, graphFingerprint, nodeFingerprint } from "./fingerprint"
import type { DagRunner } from "./runner"
import { DagStore, resolveDagDatabasePath } from "./store"
import { sameRepository } from "./worktree"
import { canonicalProject } from "../database"
import type { DagNotifier } from "./notices"
import { normalizedModel, type NodeRecovery } from "./rescue"
import type { DagDefinition, DagEvent, DagNodeDefinition, DagNodeRecord, DagObservedStart, DagObservedUpdate, DagResolvedInput, DagResultEnvelope, DagRunRecord, DagSnapshot, DagSteerRequest, JsonValue } from "./types"

export { DagValidationError }

/**
 * Every operation is an Effect. Failures are typed (`DagValidationError`); node
 * execution failures never escape, they become node retry/failure state.
 */
export interface DagController {
  readonly lineage: (runID: string, nodeID: string, sessionID: string) => Effect.Effect<DagRunRecord | undefined>
  readonly create: (definition: DagDefinition, ownerSessionID: string, authorizedPlan?: string) => Effect.Effect<DagRunRecord, DagValidationError>
  readonly list: (ownerSessionID?: string) => Effect.Effect<readonly DagRunRecord[]>
  readonly snapshot: (runID: string, ownerSessionID: string) => Effect.Effect<DagSnapshot, DagValidationError>
  readonly node: (runID: string, ownerSessionID: string, nodeID: string) => Effect.Effect<DagNodeRecord, DagValidationError>
  readonly wait: (runID: string, ownerSessionID: string) => Effect.Effect<DagRunRecord, DagValidationError>
  readonly cancel: (runID: string, ownerSessionID: string, expectedGeneration?: number) => Effect.Effect<DagRunRecord, DagValidationError>
  readonly retry: (runID: string, ownerSessionID: string, nodeID?: string, expectedGeneration?: number) => Effect.Effect<DagRunRecord, DagValidationError>
  readonly resume: (runID: string, ownerSessionID: string) => Effect.Effect<DagRunRecord, DagValidationError>
  readonly approve: (runID: string, ownerSessionID: string, nodeID: string, note?: string, expectedGeneration?: number) => Effect.Effect<DagRunRecord, DagValidationError>
  readonly reject: (runID: string, ownerSessionID: string, nodeID: string, note?: string, expectedGeneration?: number) => Effect.Effect<DagRunRecord, DagValidationError>
  readonly amend: (runID: string, ownerSessionID: string, definition: DagDefinition) => Effect.Effect<DagRunRecord, DagValidationError>
  readonly steer: (runID: string, ownerSessionID: string, nodeID: string, text: string, requestID: string) => Effect.Effect<DagSteerRequest, DagValidationError>
  /** Appends a native subagent call to its exact inherited run or owner-scoped batch. */
  readonly observe: (input: DagObservedStart) => Effect.Effect<{ readonly runID: string; readonly nodeID: string }>
  /** Moves an observed node to running again (a follow-up), or settles it. */
  readonly observed: (runID: string, nodeID: string, update: DagObservedUpdate) => Effect.Effect<void>
  /** The observed node a child session belongs to, read from the store so it survives a reload. */
  readonly observedChild: (sessionID: string) => Effect.Effect<{ readonly runID: string; readonly nodeID: string; readonly owner: string } | undefined>
  readonly close: Effect.Effect<void>
}

export interface DagControllerOptions {
  readonly directory: string
  readonly databasePath?: string
  readonly runner: DagRunner
  /** Global opt-in: after a node's fallbacks and attempts are spent on model failures, continue it once on the owner's model. */
  readonly rescue?: { readonly ownerModel: boolean }
  /** Restart recovery waits for this, so reattached children see a fully loaded host. */
  readonly recoveryReady?: Effect.Effect<void>
  /** Returns the configured "provider/model[#variant]" for an agent ID, or undefined. */
  readonly defaultModel?: (agent: string) => string | undefined
  /** Configured runtime fallbacks ("provider/model[#variant]") for an agent ID, tried in order when a node's model fails. */
  readonly fallbackModels?: (agent: string) => readonly string[]
  /** Whether a run may work in `directory`; defaults to worktrees of the project's own repository. */
  readonly directoryAllowed?: (directory: string) => boolean
  readonly admit?: (ownerSessionID: string, definition: DagDefinition, authorizedPlan?: string) => Effect.Effect<void, DagValidationError>
  readonly admitSteer?: (ownerSessionID: string, node: DagNodeRecord) => Effect.Effect<void, DagValidationError>
  /** Whether a session's role permits an owner-model rescue (planning and plan-execution sessions do not). */
  readonly rescueRoleAllowed?: (sessionID: string) => Effect.Effect<boolean, DagValidationError>
  readonly notifier?: DagNotifier
  readonly maxParallel?: number
  readonly now?: () => number
  readonly trace?: (event: string, data?: Record<string, unknown>) => void
  readonly onEvent?: (event: DagEvent, ownerSessionID: string) => void | Promise<void> | Effect.Effect<void, unknown>
}

type SharedController = { readonly controller: DagController; refs: number }
const sharedControllers = new Map<string, SharedController>()

function terminal(status: DagRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function jsonText(value: unknown): string {
  return JSON.stringify(value)
}

export function resolveInputs(node: DagNodeRecord, run: DagRunRecord): DagResolvedInput[] {
  const bindings = (node.definition.inputs ?? []).flatMap((binding) =>
    binding.node === "*" ? node.definition.dependsOn.map((id) => ({ node: id, ...(binding.field === undefined ? {} : { field: binding.field }) })) : [binding])
  return bindings.map((binding) => {
    const source = run.nodes.find((candidate) => candidate.definition.id === binding.node)
    const result = source?.result
    if (source?.status === "skipped") {
      return { node: binding.node, field: binding.field ?? "payload", value: null, provenance: { agent: source.definition.agent ?? "", model: source.definition.model ?? "", attempt: source.attempt, status: "skipped", sessionID: null } }
    }
    const payload = result?.payload ?? null
    const value = binding.field !== undefined && payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload[binding.field] ?? null : payload
    return {
      node: binding.node,
      field: binding.field ?? "payload",
      value,
      provenance: result ? { agent: result.provenance.agent, model: result.provenance.model, attempt: result.attempt, status: result.status, sessionID: result.provenance.execution?.sessionID ?? null, ...(result.inputRevision ? { inputRevision: result.inputRevision } : {}) } : null,
    }
  })
}

export function conditionSource(run: DagRunRecord): Map<string, JsonValue | null> {
  return new Map(run.nodes.map((node) => [node.definition.id, node.status === "skipped" ? null : node.result?.payload ?? null]))
}

export function buildPrompt(node: DagNodeRecord, run: DagRunRecord): string {
  const inputs = resolveInputs(node, run)
  if (inputs.length === 0) return node.definition.prompt
  return `${node.definition.prompt}\n\n<iolaus-dag-inputs>${jsonText(inputs)}</iolaus-dag-inputs>`
}

/**
 * Fills each agent node's model from its lane. Routing is fail-closed: a lane that
 * resolves to no model is reported as `model_unavailable` at create/amend time,
 * rather than being discovered when the child session fails to start.
 */
export function applyDefaultModels(definition: DagDefinition, defaultModel: DagControllerOptions["defaultModel"], fallbackModels?: DagControllerOptions["fallbackModels"]): DagDefinition {
  const missing: string[] = []
  const nodes = definition.nodes.map((node) => {
    if (isGate(node) || node.model !== undefined || node.agent === undefined) return node
    const model = defaultModel?.(node.agent)
    if (model === undefined) { missing.push(`${node.id} (${node.agent})`); return node }
    const fallbacks = node.fallbackModels ?? fallbackModels?.(node.agent) ?? []
    return { ...node, model, ...(fallbacks.length ? { fallbackModels: fallbacks } : {}) }
  })
  if (missing.length) throw new DagValidationError(`model_unavailable: no configured model for ${missing.join(", ")}; set model on the node or configure the lane in IOLAUS_HOME/iolaus.json`)
  return { ...definition, nodes }
}

/** The text a child reported: a string payload or its `text` field. */
export function replyText(payload: JsonValue): string | undefined {
  if (typeof payload === "string") return payload
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) && typeof payload.text === "string" ? payload.text : undefined
}

/** A deep-low child that cannot settle its central decision from evidence ends its reply with this line. */
export const ESCALATE_LINE = /^ESCALATE:\s*deep-high\s*$/m

/** Runs synchronous validation code as a typed Effect failure. */
function validated<A>(compute: () => A): Effect.Effect<A, DagValidationError> {
  return Effect.try({ try: compute, catch: (error) => error instanceof DagValidationError ? error : new DagValidationError(error instanceof Error ? error.message : String(error)) })
}

export function createDagController(options: DagControllerOptions): DagController {
  const databasePath = options.databasePath ?? resolveDagDatabasePath(options.directory)
  const project = canonicalProject(options.directory)
  const key = JSON.stringify([databasePath, project])
  const existing = sharedControllers.get(key)
  if (existing) {
    existing.refs += 1
    return { ...existing.controller, close: Effect.sync(() => releaseSharedController(key, existing)) }
  }
  const store = new DagStore(databasePath, project)
  const runner = options.runner
  const now = options.now ?? Date.now
  const maxParallel = options.maxParallel ?? 5
  const locks = new Map<string, Semaphore.Semaphore>()
  const waiters = new Map<string, Set<Deferred.Deferred<DagRunRecord>>>()
  // Every launch fiber lives in this scope; closing the controller interrupts them.
  const scope = Scope.makeUnsafe()
  let closed = false

  const trace = (event: string, data: Record<string, unknown> = {}) => options.trace?.(event, data)
  const directoryAllowed = options.directoryAllowed ?? ((directory: string) => sameRepository(options.directory, directory))
  const prepare = (input: DagDefinition): DagDefinition => {
    const definition = applyDefaultModels(input, options.defaultModel, options.fallbackModels)
    validateDefinition(definition)
    if (definition.directory !== undefined && !directoryAllowed(definition.directory))
      throw new DagValidationError(`directory ${definition.directory} is not a worktree of this project's repository`)
    return definition
  }
  const emit = (event: DagEvent, ownerSessionID: string): void => {
    const result = options.onEvent?.(event, ownerSessionID)
    if (result && typeof result === "object" && "then" in result) void (result as Promise<void>).catch(() => undefined)
    else if (result && Effect.isEffect(result)) Effect.runFork(Effect.ignore(result as Effect.Effect<void, unknown>))
  }
  const event = (run: DagRunRecord, type: DagEvent["type"], nodeID?: string, payload?: JsonValue) => {
    const created = store.saveRun(run, [{ schemaVersion: 1, runID: run.runID, generation: run.generation, type, createdAt: now(), ...(nodeID ? { nodeID } : {}), ...(payload === undefined ? {} : { payload }) }], [], options.notifier !== undefined)[0]!
    trace(`iolaus.dag.${type}`, { runID: run.runID, generation: run.generation, ...(nodeID ? { nodeID } : {}), sequence: created.sequence })
    emit(created, run.ownerSessionID)
    if (options.notifier) Effect.runFork(Effect.forkIn(deliverNotice(created.eventID), scope))
  }
  /** Per-run critical section. Each run has one permit, so state transitions never interleave. */
  const locked = <A, E>(runID: string, task: Effect.Effect<A, E>): Effect.Effect<A, E> => {
    let lock = locks.get(runID)
    if (!lock) { lock = Semaphore.makeUnsafe(1); locks.set(runID, lock) }
    return lock.withPermit(task)
  }
  const operating = <A, E>(runID: string, task: Effect.Effect<A, E>): Effect.Effect<A, E> => locked(`operation:${runID}`, task)
  const deliverNotice = (eventID: string): Effect.Effect<void> => locked(`notice:${eventID}`, Effect.gen(function* () {
    if (closed || !options.notifier) return
    const notice = store.notices().find((value) => value.eventID === eventID)
    if (!notice || notice.state === "admitted") return
    const fresh = notice.state === "pending"
    store.saveNotice({ ...notice, state: "reserved" })
    const result = yield* Effect.exit(fresh ? options.notifier.send(notice) : options.notifier.reconcile(notice))
    if (closed) return
    const receipt = Exit.isSuccess(result) ? result.value : undefined
    store.saveNotice({ ...notice, state: receipt ? "admitted" : "unresolved", ...(receipt ? { receipt } : { error: Exit.isFailure(result) ? errorMessage(Cause.squash(result.cause)) : "Notice admission is unresolved; nothing was replayed" }) })
  }))
  const owned = (runID: string, ownerSessionID: string): Effect.Effect<DagRunRecord, DagValidationError> => Effect.suspend(() => {
    if (closed) return Effect.fail(new DagValidationError("Iolaus DAG controller closed"))
    const run = store.getRun(runID)
    if (!run) return Effect.fail(new DagValidationError(`Unknown Iolaus DAG run: ${runID}`))
    if (run.ownerSessionID !== ownerSessionID) return Effect.fail(new DagValidationError("Iolaus DAG run belongs to another session"))
    return Effect.succeed(run)
  })
  const notify = (run: DagRunRecord) => {
    if (!terminal(run.status)) return
    const pending = waiters.get(run.runID)
    if (!pending) return
    waiters.delete(run.runID)
    for (const waiter of pending) Deferred.doneUnsafe(waiter, Exit.succeed(run))
  }
  const save = (run: DagRunRecord): DagRunRecord => { store.saveRun(run); return run }
  const activeCount = (run: DagRunRecord): number => run.nodes.filter((node) => node.status === "starting" || node.status === "running").length
  const updateNode = (run: DagRunRecord, nodeID: string, update: (node: DagNodeRecord) => DagNodeRecord): DagRunRecord => ({
    ...run,
    updatedAt: now(),
    nodes: run.nodes.map((node) => node.definition.id === nodeID ? update(node) : node),
  })
  const updateRunStatus = (run: DagRunRecord): DagRunRecord => {
    const active = run.nodes.some((node) => node.status === "starting" || node.status === "running" || node.status === "ready" || node.status === "needs_retry")
    const pending = run.nodes.some((node) => node.status === "pending")
    const waiting = run.nodes.some((node) => node.status === "waiting_approval")
    if (waiting && !active) {
      if (run.status === "paused") return run
      const paused = { ...run, status: "paused" as const, updatedAt: now() }
      event(paused, "run.paused")
      return paused
    }
    if (active || pending) return run.status === "paused" ? { ...run, status: "running", updatedAt: now() } : run
    const status: DagRunRecord["status"] = run.nodes.every((node) => node.status === "completed" || node.status === "reused" || node.status === "skipped") ? "completed" : run.status === "cancelled" ? "cancelled" : "failed"
    if (run.status === status) return run
    const updated = { ...run, status, updatedAt: now() }
    event(updated, status === "completed" ? "run.completed" : status === "cancelled" ? "run.cancelled" : "run.failed")
    notify(updated)
    return updated
  }

  /** Advances the dependency frontier: blocks, skips, gates and launches; returns the nodes to start. */
  const advance = (runID: string): DagNodeRecord[] => {
    let run = store.getRun(runID)
    if (!run || closed || terminal(run.status)) return []
    const records = new Map(run.nodes.map((node) => [node.definition.id, node]))
    const launches: DagNodeRecord[] = []
    // A skip or block settled in this pass may unblock a node visited earlier in it; repeat until the frontier is stable.
    let settled = true
    do {
      settled = true
      for (const node of run.nodes) {
        if (node.status !== "pending" && node.status !== "needs_retry") continue
        const state = dependencyState(node.definition, records)
        if (state === "blocked") {
          run = updateNode(run, node.definition.id, (current) => ({ ...current, status: "blocked", error: "A dependency did not complete successfully", updatedAt: now() }))
          event(run, "node.blocked", node.definition.id)
          records.set(node.definition.id, run.nodes.find((candidate) => candidate.definition.id === node.definition.id)!)
          settled = false
          continue
        }
        if (state !== "ready") continue
        if (node.definition.when && !evaluateCondition(node.definition.when, conditionSource(run))) {
          run = updateNode(run, node.definition.id, (current) => ({ ...current, status: "skipped", error: undefined, updatedAt: now() }))
          event(run, "node.skipped", node.definition.id, { reason: "condition_false" })
          records.set(node.definition.id, run.nodes.find((candidate) => candidate.definition.id === node.definition.id)!)
          settled = false
          continue
        }
        if (isGate(node.definition)) {
          run = updateNode(run, node.definition.id, (current) => ({ ...current, status: "waiting_approval", attempt: current.attempt + 1, error: undefined, updatedAt: now() }))
          event(run, "node.waiting", node.definition.id, { message: node.definition.prompt, inputs: jsonText(resolveInputs(node, run)) })
          continue
        }
        // run already marks this pass's launches as starting, so activeCount includes them.
        if (activeCount(run) >= Math.min(maxParallel, run.definition.maxParallel ?? maxParallel)) continue
        const next = updateNode(run, node.definition.id, (current) => ({ ...current, status: "starting", attempt: current.attempt + 1, execution: undefined,
          runtime: { identity: { token: randomUUID(), agent: current.definition.agent!, model: current.definition.model! }, initial: "pending", inputRevision: 0 }, updatedAt: now() }))
        run = next
        launches.push(next.nodes.find((candidate) => candidate.definition.id === node.definition.id)!)
        event(run, "node.ready", node.definition.id)
      }
    } while (!settled)
    save(updateRunStatus(run))
    return launches
  }

  const schedule = (runID: string): Effect.Effect<void> => Effect.suspend(() => {
    if (closed) return Effect.void
    return locked(runID, Effect.sync(() => advance(runID))).pipe(
      Effect.flatMap((launches) => Effect.forEach(launches, (node) => Effect.forkIn(launch(runID, node), scope), { discard: true })),
    )
  })

  const inRescueDomain = (run: DagRunRecord, node: DagNodeRecord): boolean =>
    (node.definition.kind ?? "agent") === "agent" && !run.definition.observed && !run.authorizedPlan
    && !run.definition.nodes.some((value) => value.agent === "atlas") && node.definition.agent !== "prometheus"

  /** Recovery after a settled execution: no continuation pending, and a rescue that ran is no longer live. */
  const closedRecovery = (recovery: NodeRecovery | undefined): NodeRecovery | undefined => recovery
    ? { failedModels: recovery.failedModels, ...(recovery.rescue ? { rescue: { ...recovery.rescue, settled: true } } : {}) } : undefined

  const settle = (runID: string, nodeID: string, node: DagNodeRecord, outcome: Exit.Exit<{ ref: import("./types").DagExecutionRef; payload: JsonValue }, DagRunnerError>): Effect.Effect<void> =>
    locked(runID, Effect.gen(function* () {
      const current = store.getRun(runID)
      // A cancelled run already settled its nodes; the interrupted child's late outcome must not reopen them.
      if (!current || current.status === "cancelled") return
      // Settle each attempt once: a node already settled (or retried) keeps its newer state.
      const live = current.nodes.find((candidate) => candidate.definition.id === nodeID)
      if (!live || (live.status !== "starting" && live.status !== "running") || live.attempt !== node.attempt || live.runtime?.identity.token !== node.runtime?.identity.token) return
      if ((live.runtime?.inputRevision ?? 0) !== (node.runtime?.inputRevision ?? 0)) return
      const requests = executionRequests(runID, live)
      if (requests.some((request) => request.state === "reserved" || request.state === "unresolved")) return
      if (live.execution && runner.verify) {
        const checked = yield* Effect.exit(runner.verify(live.execution))
        if (Exit.isFailure(checked)) outcome = Exit.failCause(checked.cause)
      }
      if (requests.length) {
        const checked = yield* Effect.exit(authorizeSteer(current, live))
        if (Exit.isFailure(checked)) outcome = Exit.fail(new DagRunnerError({ message: errorMessage(Cause.squash(checked.cause)), nodeID }))
      }
      // A failed model turn that already received a supplement leaves it in the session's history, so it is delivered.
      const failed = Exit.isFailure(outcome) ? Cause.squash(outcome.cause) : undefined
      const reached = (request: DagSteerRequest) => Exit.isSuccess(outcome)
        || (failed instanceof DagRunnerError && failed.model === true && failed.deliveredRequests?.includes(request.requestID) === true)
      for (const request of requests) store.saveSteering({ ...request, state: reached(request) ? "delivered" : "unresolved", ...(reached(request) ? {} : { error: errorMessage(failed) }) })
      const rescue = live.recovery?.rescue
      const rescued = rescue !== undefined && !rescue.settled && normalizedModel(live.definition.model ?? "") === rescue.model
      const emptyReply = Exit.isSuccess(outcome) && (outcome.value.payload === null || replyText(outcome.value.payload)?.trim() === "")
      if (Exit.isSuccess(outcome) && !emptyReply) {
        const { ref, payload } = outcome.value
        const text = replyText(payload)
        const escalated = live.definition.agent === "deep-low" && text !== undefined && ESCALATE_LINE.test(text) ? options.defaultModel?.("deep-high") : undefined
        if (escalated && requests.length === 0 && !rescued) {
          // The goal's central decision needs the escalation lane: rerun it there with the findings so far.
          const fallbacks = options.fallbackModels?.("deep-high") ?? []
          const definition: DagNodeDefinition = { ...live.definition, agent: "deep-high", model: escalated, fallbackModels: fallbacks.length ? fallbacks : undefined,
            prompt: `${live.definition.prompt}\n\n<iolaus-escalation from="deep-low">\nA deep-low attempt escalated this goal because its central decision cannot be settled from evidence alone. Its findings follow; build on them, settle the decision, and deliver.\n${text}\n</iolaus-escalation>` }
          const updated = updateNode(current, nodeID, (value) => ({ ...value, definition, ...(value.recovery ? { recovery: closedRecovery(value.recovery) } : {}), status: "needs_retry", error: undefined, updatedAt: now() }))
          event(updated, "node.escalated", nodeID, { from: "deep-low", to: "deep-high", model: escalated })
          save(updateRunStatus(updated))
          return
        }
        const envelope: DagResultEnvelope = { schemaVersion: 1, runID, nodeID, generation: current.generation, attempt: node.attempt, inputRevision: live.runtime?.inputRevision ?? 0, status: "completed", payload, provenance: { parentNodeIDs: node.definition.dependsOn, execution: ref, agent: live.definition.agent ?? "", model: live.definition.model ?? "", ...(rescued ? { rescue: { decisionID: rescue.decisionID, model: rescue.model, from: rescue.from } } : {}) }, createdAt: now() }
        let updated = updateNode(current, nodeID, (value) => ({ ...value, status: "completed", result: envelope, error: undefined, ...(value.recovery ? { recovery: closedRecovery(value.recovery) } : {}), updatedAt: now() }))
        event(updated, "node.completed", nodeID, envelope.payload)
        save(updateRunStatus(updated))
        return
      }
      const failure = Exit.isFailure(outcome) ? Cause.squash(outcome.cause) : undefined
      const message = emptyReply ? "The child finished with an empty reply" : errorMessage(failure)
      const modelFailure = emptyReply || (failure instanceof DagRunnerError && failure.model === true)
      const [next, ...rest] = live.definition.fallbackModels ?? []
      const nonRetryable = failure instanceof DagRunnerError && failure.nonRetryable === true
      // Every supplement reached the session's history, so continuing that session on another model keeps them.
      const delivered = requests.every(reached)
      // A session-backed model failure continues in the same session: switch its model and tell it to continue.
      // Without a continuable session (judge, failed create, a host without switchModel) a retry starts afresh,
      // which is only safe for a node that was never steered.
      // The session to continue is this execution's once its prompt was admitted, or, when this attempt failed before
      // taking the session over (the model switch itself failed), the one it was meant to continue.
      const session = (live.definition.kind ?? "agent") === "agent" && runner.continues
        ? live.execution && live.runtime?.initial === "admitted" ? live.execution : live.recovery?.continueFrom : undefined
      const continuable = modelFailure && !nonRetryable && delivered && (session !== undefined || !store.steering(runID).some((request) => request.nodeID === nodeID))
      const failedModels = live.definition.model ? [...new Set([...(live.recovery?.failedModels ?? []), normalizedModel(live.definition.model)])] : live.recovery?.failedModels ?? []
      const retryRecovery: NodeRecovery = { failedModels, ...(session ? { continueFrom: session } : {}), ...(rescue ? { rescue } : {}) }
      const retry = (definition: DagNodeDefinition, type: "node.fallback" | "node.rescued", payload: JsonValue, recovery: NodeRecovery = retryRecovery) => {
        const updated = updateNode(current, nodeID, (value) => ({ ...value, definition, recovery, status: "needs_retry", error: message, updatedAt: now() }))
        event(updated, type, nodeID, payload)
        save(updateRunStatus(updated))
      }
      if (continuable && !rescued && next !== undefined) {
        // A model failure moves to the next model in the lane's chain; the chain, not maxAttempts, bounds it.
        return retry({ ...live.definition, model: next, fallbackModels: rest.length ? rest : undefined }, "node.fallback", { from: live.definition.model ?? null, to: next, message, ...(session ? { continued: true } : {}) })
      }
      const maxAttempts = live.definition.maxAttempts ?? 1
      if (continuable && !rescued && live.attempt < maxAttempts) {
        // Remaining attempts stay on the last model and continue in the same session too.
        const updated = updateNode(current, nodeID, (value) => ({ ...value, recovery: retryRecovery, status: "needs_retry", error: message, updatedAt: now() }))
        event(updated, "node.failed", nodeID, { message, status: "needs_retry", ...(session ? { continued: true } : {}) })
        return save(updateRunStatus(updated))
      }
      if (options.rescue?.ownerModel && continuable && !rescued && inRescueDomain(current, live)) {
        const decision = yield* Effect.exit(Effect.gen(function* () {
          if (rescue) return yield* new DagRunnerError({ message: "owner_rescue_spent" })
          if (!runner.ownerModel) return yield* new DagRunnerError({ message: "owner_model_unavailable" })
          if (options.rescueRoleAllowed) {
            const ownerAllowed = yield* options.rescueRoleAllowed(current!.ownerSessionID).pipe(Effect.mapError((error) => new DagRunnerError({ message: error.message })))
            const childAllowed = session ? yield* options.rescueRoleAllowed(session.sessionID).pipe(Effect.mapError((error) => new DagRunnerError({ message: error.message }))) : true
            if (!ownerAllowed || !childAllowed) return yield* new DagRunnerError({ message: "rescue_role_excluded" })
          }
          const model = yield* runner.ownerModel(current!.ownerSessionID)
          if (failedModels.includes(normalizedModel(model))) return yield* new DagRunnerError({ message: "owner_model_already_failed" })
          return model
        }))
        if (Exit.isSuccess(decision)) {
          const model = decision.value
          const reserved: NonNullable<NodeRecovery["rescue"]> = { decisionID: randomUUID(), model: normalizedModel(model), from: live.definition.model ?? "", preRescueDefinition: live.definition, settled: false, decidedAt: now() }
          return retry({ ...live.definition, model, fallbackModels: undefined }, "node.rescued", { decisionID: reserved.decisionID, from: reserved.from, to: model, message, ...(session ? { continued: true } : {}) }, { ...retryRecovery, rescue: reserved })
        }
        event(current, "node.rescue-skipped", nodeID, { reason: errorMessage(Cause.squash(decision.cause)) })
      }
      const status: DagNodeRecord["status"] = requests.length && !delivered ? "interrupted"
        : !modelFailure && !nonRetryable && requests.length === 0 && live.attempt < maxAttempts ? "needs_retry" : "failed"
      const recovery = live.recovery || failedModels.length ? { ...closedRecovery(live.recovery ?? { failedModels }), failedModels } : undefined
      const updated = updateNode(current, nodeID, (value) => ({ ...value, status, error: message, ...(recovery ? { recovery } : {}), updatedAt: now() }))
      event(updated, "node.failed", nodeID, { message, status })
      save(updateRunStatus(updated))
    }))

  const launch = (runID: string, node: DagNodeRecord): Effect.Effect<void> => Effect.gen(function* () {
    const nodeID = node.definition.id
    const run = store.getRun(runID)
    const live = run?.nodes.find((candidate) => candidate.definition.id === nodeID)
    if (!run || live?.status !== "starting" || live.runtime?.identity.token !== node.runtime?.identity.token) return
    const execution = Effect.gen(function* () {
      // Atlas authorization covers the node as planned; a fallback model does not change what the node is.
      const planned = run.definition.nodes.find((candidate) => candidate.id === nodeID) ?? node.definition
      yield* checkAtlas(run, { ...run.definition, nodes: [planned] }).pipe(Effect.mapError((error) => new DagRunnerError({ message: error.message, nodeID })))
      if (options.admit) yield* options.admit(run.ownerSessionID, { ...run.definition, nodes: [node.definition] }, run.authorizedPlan).pipe(
        Effect.mapError((error) => new DagRunnerError({ message: error.message, nodeID })))
      const continueFrom = node.recovery?.continueFrom
      const started = yield* runner.start({ node: node.definition, prompt: buildPrompt(node, run), attempt: node.attempt, identity: node.runtime?.identity, runID, ...(continueFrom ? { continueFrom } : {}), ...(run.definition.directory ? { directory: run.definition.directory } : {}) })
      const ref = { ...started, identity: node.runtime?.identity }
      const published = yield* locked(runID, Effect.sync(() => {
        const current = store.getRun(runID)
        const live = current?.nodes.find((value) => value.definition.id === nodeID)
        if (!current || current.status === "cancelled" || live?.status !== "starting" || live.runtime?.identity.token !== node.runtime?.identity.token) return false
        // The continuation is consumed: this execution owns the session now, and a later failure continues from it.
        const updated = updateNode(current, nodeID, (value) => ({ ...value, status: "running", execution: ref, ...(value.recovery?.continueFrom ? { recovery: { ...value.recovery, continueFrom: undefined } } : {}), updatedAt: now() }))
        save(updated); event(updated, "node.started", nodeID)
        return true
      }))
      if (!published) {
        yield* runner.cancel(ref)
        return yield* new DagRunnerError({ message: "Execution was cancelled before initial admission", nodeID })
      }
      yield* operating(runID, Effect.gen(function* () {
        const admitted = yield* locked(runID, Effect.gen(function* () {
          const current = store.getRun(runID)
          const live = current?.nodes.find((value) => value.definition.id === nodeID)
          if (!current || current.status === "cancelled" || live?.status !== "running" || live.runtime?.identity.token !== node.runtime?.identity.token) return false
          if (options.admit) yield* options.admit(current.ownerSessionID, { ...current.definition, nodes: [live.definition] }, current.authorizedPlan).pipe(Effect.mapError((error) => new DagRunnerError({ message: error.message, nodeID, nonRetryable: true })))
          return true
        }))
        if (!admitted) return yield* new DagRunnerError({ message: "Execution was cancelled before initial admission", nodeID })
        if (runner.admit) {
          const admission = yield* Effect.exit(runner.admit(ref))
          if (Exit.isFailure(admission)) {
            yield* locked(runID, Effect.sync(() => {
              const current = store.getRun(runID)!
              save(updateNode(current, nodeID, (value) => ({ ...value, runtime: { ...value.runtime!, initial: "unresolved" } })))
            }))
            yield* runner.cancel(ref).pipe(Effect.catch((error) => Effect.sync(() => trace("iolaus.dag.initial.cancel-failed", { runID, nodeID, error: error.message }))))
            return yield* new DagRunnerError({ message: `Initial prompt admission unresolved: ${errorMessage(Cause.squash(admission.cause))}. Nothing will be replayed.`, nodeID, nonRetryable: true })
          }
        }
        yield* locked(runID, Effect.sync(() => {
          const current = store.getRun(runID)!
          save(updateNode(current, nodeID, (value) => ({ ...value, runtime: { ...value.runtime!, initial: "admitted" } })))
        }))
      }))
      const result = yield* runner.wait(ref)
      return { ref, payload: result.payload }
    })
    yield* finish(runID, nodeID, node, yield* Effect.exit(execution))
  })

  const finish = (runID: string, nodeID: string, node: DagNodeRecord, outcome: Exit.Exit<{ ref: import("./types").DagExecutionRef; payload: JsonValue }, DagRunnerError>): Effect.Effect<void> => Effect.gen(function* () {
    yield* settle(runID, nodeID, node, outcome)
    yield* grow(runID, nodeID).pipe(Effect.catch((error) => locked(runID, Effect.sync(() => {
      const current = store.getRun(runID)
      if (!current || terminal(current.status)) return
      const failed: DagRunRecord = { ...current, status: "failed", updatedAt: now(), nodes: current.nodes.map((value) =>
        value.status === "pending" || value.status === "needs_retry" ? { ...value, status: "blocked", error: error.message, updatedAt: now() } : value) }
      save(failed); event(failed, "run.failed", nodeID, { message: error.message }); notify(failed)
    }))))
    yield* schedule(runID)
  })

  const interrupt = (runID: string, node: DagNodeRecord, message: string): Effect.Effect<void> => locked(runID, Effect.sync(() => {
    const current = store.getRun(runID)
    const live = current?.nodes.find((candidate) => candidate.definition.id === node.definition.id)
    if (!current || terminal(current.status) || !live || (live.status !== "starting" && live.status !== "running") || live.attempt !== node.attempt || live.runtime?.identity.token !== node.runtime?.identity.token) return
    const updated = updateNode(current, node.definition.id, (value) => ({ ...value, status: "interrupted", error: message, updatedAt: now() }))
    event(updated, "node.failed", node.definition.id, { message, status: "interrupted" })
    save(updateRunStatus(updated))
  }))

  /**
   * An observed run's correlation with its subagent sessions lives in the observer's memory, so after a reload the
   * child's completion never reaches the node. Wait on the recorded session again and record its own outcome.
   */
  const recoverObserved = (run: DagRunRecord): Effect.Effect<void> => Effect.gen(function* () {
    for (const node of run.nodes) {
      if (node.status !== "running") continue
      const ref = node.execution
      if (!ref) {
        trace("iolaus.dag.recovered", { runID: run.runID, nodeID: node.definition.id, outcome: "interrupted" })
        yield* controller.observed(run.runID, node.definition.id, { status: "interrupted", error: "The controller stopped before the subagent session was known" })
        continue
      }
      trace("iolaus.dag.recovered", { runID: run.runID, nodeID: node.definition.id, outcome: "reattached", sessionID: ref.sessionID })
      yield* Effect.forkIn(Effect.gen(function* () {
        const outcome = yield* Effect.exit(runner.reattach(ref))
        if (!Exit.isSuccess(outcome)) return yield* controller.observed(run.runID, node.definition.id, { status: "failed", error: errorMessage(Cause.squash(outcome.cause)) })
        if (outcome.value === undefined) return yield* controller.observed(run.runID, node.definition.id, { status: "interrupted", error: "The controller stopped before the subagent session received its prompt" })
        const payload = outcome.value.payload
        const text = payload !== null && typeof payload === "object" && !Array.isArray(payload) && typeof payload.text === "string" ? payload.text : ""
        yield* controller.observed(run.runID, node.definition.id, { status: "completed", text })
      }), scope)
    }
  })

  /**
   * A controller that stopped mid-run (plugin reload, restart) left nodes starting or running with nobody waiting on
   * them. A child that received its prompt is waited on again and settles with its own outcome, even if it finished
   * while no controller was listening; a node whose prompt never reached a child is interrupted for an explicit retry.
   */
  const recover = (run: DagRunRecord): Effect.Effect<void> => Effect.gen(function* () {
    if (run.definition.observed) return yield* recoverObserved(run)
    for (const node of run.nodes) {
      if (node.status !== "starting" && node.status !== "running") continue
      const ref = node.execution
      if (!ref) {
        trace("iolaus.dag.recovered", { runID: run.runID, nodeID: node.definition.id, outcome: "interrupted" })
        yield* interrupt(run.runID, node, "The controller stopped before this node started; retry it to run again")
        continue
      }
      trace("iolaus.dag.recovered", { runID: run.runID, nodeID: node.definition.id, outcome: "reattached", sessionID: ref.sessionID })
      yield* Effect.forkIn(Effect.gen(function* () {
        const requests = executionRequests(run.runID, node)
        const outcome = yield* Effect.exit(runner.reattach(ref, requests))
        if (requests.length) {
          const recovered = Exit.isSuccess(outcome) && outcome.value !== undefined
          yield* locked(run.runID, Effect.sync(() => {
            for (const request of requests) store.saveSteering({ ...request, state: recovered ? "admitted" : "unresolved",
              ...(recovered ? { receipt: request.receipt ?? { messageID: request.messageID } } : { error: "Host delivery or resulting execution could not be reconciled; nothing was replayed" }) })
          }))
          if (!recovered) {
            yield* interrupt(run.runID, node, "Steering delivery unresolved after recovery; nothing was replayed")
            return yield* schedule(run.runID)
          }
        }
        if (Exit.isSuccess(outcome) && outcome.value === undefined) {
          if (node.runtime?.initial === "pending") yield* locked(run.runID, Effect.sync(() => {
            const current = store.getRun(run.runID)!
            const live = current.nodes.find((value) => value.definition.id === node.definition.id)
            if (live?.runtime?.identity.token === node.runtime?.identity.token) save(updateNode(current, node.definition.id, (value) => ({ ...value, runtime: { ...value.runtime!, initial: "unresolved" } })))
          }))
          yield* interrupt(run.runID, node, node.runtime?.initial === "pending"
            ? "Initial prompt admission is unresolved after recovery; nothing was replayed"
            : "The controller stopped before the child session received its prompt; retry it to run again")
          return yield* schedule(run.runID)
        }
        yield* finish(run.runID, node.definition.id, node, Exit.isSuccess(outcome) ? Exit.succeed({ ref, payload: outcome.value!.payload }) : Exit.failCause(outcome.cause))
      }), scope)
    }
    yield* schedule(run.runID)
  })

  /** Dynamic review loop: after a review settles FAIL with rounds left, append the next fix/review pair. */
  const grow = (runID: string, nodeID: string): Effect.Effect<void, DagValidationError> => locked(runID, Effect.gen(function* () {
    const run = store.getRun(runID)
    if (!run || !run.definition.loop || terminal(run.status)) return
    const next = growLoop(run, nodeID)
    if (!next) return
    const definition = yield* validated(() => prepare(next))
    yield* checkAtlas(run, definition)
    if (options.admit) yield* options.admit(run.ownerSessionID, definition, run.authorizedPlan)
    const previousByID = new Map(run.nodes.map((node) => [node.definition.id, node]))
    const fingerprints = fingerprintNodes(definition)
    const nodes = definition.nodes.map((node) => {
      const old = previousByID.get(node.id)
      if (old && old.fingerprint === fingerprints.get(node.id)) return old
      // Existing nodes with a changed definition (the loop tail rewired to the newest review) keep their status if untouched.
      if (old) return { ...old, definition: node, fingerprint: fingerprints.get(node.id)!, updatedAt: now() }
      return { definition: node, fingerprint: fingerprints.get(node.id)!, status: "pending" as const, attempt: 0, createdAt: now(), updatedAt: now() }
    })
    const grown: DagRunRecord = { ...run, definition, fingerprint: graphFingerprint(definition), generation: run.generation + 1, status: "running", nodes, updatedAt: now() }
    save(grown)
    event(grown, "loop.grown", nodeID, { round: definition.nodes.filter((node) => node.id.startsWith(`${run.definition.loop!.fix}`)).length })
  }))

  const fingerprintNodes = (definition: DagDefinition): Map<string, string> => {
    const fingerprints = new Map<string, string>()
    for (const node of definition.nodes) fingerprints.set(node.id, nodeFingerprint(node, node.dependsOn.map((dependency) => fingerprints.get(dependency) ?? "")))
    return fingerprints
  }

  const checkGeneration = (run: DagRunRecord, expected: number | undefined): Effect.Effect<void, DagValidationError> =>
    expected !== undefined && run.generation !== expected ? Effect.fail(new DagValidationError("DAG generation has changed")) : Effect.void

  const gateNode = (run: DagRunRecord, nodeID: string): Effect.Effect<DagNodeRecord, DagValidationError> => Effect.suspend(() => {
    const gate = run.nodes.find((node) => node.definition.id === nodeID)
    if (!gate || !isGate(gate.definition)) return Effect.fail(new DagValidationError(`Not a gate node: ${nodeID}`))
    if (gate.status !== "waiting_approval") return Effect.fail(new DagValidationError(`Gate is not waiting for approval: ${nodeID}`))
    return Effect.succeed(gate)
  })

  const current = (runID: string): Effect.Effect<DagRunRecord> => Effect.sync(() => store.getRun(runID)!)

  const executionRequests = (runID: string, node: DagNodeRecord): readonly DagSteerRequest[] => store.steering(runID).filter((request) =>
    request.execution.identity?.token === node.runtime?.identity.token && request.nodeID === node.definition.id)

  const authorizeSteer = (run: DagRunRecord, node: DagNodeRecord): Effect.Effect<void, DagValidationError> => Effect.gen(function* () {
    if (run.definition.observed) return yield* Effect.fail(new DagValidationError("Steering observed native subagent runs is not supported"))
    if (run.authorizedPlan || run.definition.nodes.some((value) => value.agent === "atlas")) return yield* Effect.fail(new DagValidationError("Steering Atlas or authorized-plan flows is not supported"))
    if (options.admit) yield* options.admit(run.ownerSessionID, { ...run.definition, nodes: [node.definition] })
    if (options.admitSteer) yield* options.admitSteer(run.ownerSessionID, node)
  })

  const steeringNode = (run: DagRunRecord, nodeID: string): Effect.Effect<DagNodeRecord, DagValidationError> => Effect.gen(function* () {
    const node = run.nodes.find((value) => value.definition.id === nodeID)
    if (!node) return yield* Effect.fail(new DagValidationError(`Unknown DAG node: ${nodeID}`))
    yield* authorizeSteer(run, node)
    if (terminal(run.status)) return yield* Effect.fail(new DagValidationError(`Steering requires an active flow; this flow is ${run.status}`))
    if (isGate(node.definition) || node.definition.kind === "judge") return yield* Effect.fail(new DagValidationError("Steering requires a session-backed agent node, not a gate or judge"))
    if (node.status !== "running" || !node.execution) return yield* Effect.fail(new DagValidationError(`Steering requires an active running node; ${nodeID} is ${node.status}`))
    if (!node.runtime || node.runtime.initial !== "admitted") return yield* Effect.fail(new DagValidationError("Steering is unavailable before initial prompt admission or for legacy unpinned executions"))
    if (!runner.admit || !runner.verify || !runner.steer) return yield* Effect.fail(new DagValidationError("This runner does not support steering"))
    yield* runner.verify(node.execution).pipe(Effect.mapError((error) => new DagValidationError(error.message)))
    return node
  })

  const schedulable = (run: DagRunRecord): Effect.Effect<void, DagValidationError> => run.definition.observed
    ? Effect.fail(new DagValidationError("This run records native subagent calls; it cannot be retried, resumed or amended. Call the subagent again, or build an iolaus_flow definition when the work needs scheduling."))
    : Effect.void

  const checkAtlas = (run: DagRunRecord, definition: DagDefinition): Effect.Effect<void, DagValidationError> => validated(() => {
    if (!run.authorizedPlan) return
    for (const node of definition.nodes) {
      if (node.agent === "atlas" && run.authorizedAtlasNodes?.[node.id] !== nodeFingerprint(node))
        throw new DagValidationError(`Atlas node ${node.id} is not part of the authorized /start-work plan`)
    }
  })

  const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "subagent"

  const controller: DagController = {
    lineage: (runID, nodeID, sessionID) => Effect.sync(() => {
      // A child of a run whose directory is this project (a /start-work worktree) is served by this project's plugin
      // instance, while the run belongs to the project that started it; that run is its lineage too.
      const foreign = store.getRun(runID) ? undefined : store.getRun(runID, true)
      const run = foreign ? (foreign.definition.directory !== undefined && canonicalProject(foreign.definition.directory) === project ? foreign : undefined) : store.getRun(runID)
      if (!run || run.definition.observed) return undefined
      const node = run.nodes.find((candidate) => candidate.definition.id === nodeID)
      return node?.execution?.sessionID === sessionID || node?.result?.provenance.execution?.sessionID === sessionID ? run : undefined
    }),
    create: (input, ownerSessionID, authorizedPlan) => Effect.gen(function* () {
      const definition = yield* validated(() => prepare(input))
      if (options.admit) yield* options.admit(ownerSessionID, definition, authorizedPlan)
      const createdAt = now()
      const runID = randomUUID()
      const fingerprints = fingerprintNodes(definition)
      const run: DagRunRecord = { runID, ownerSessionID, ...(authorizedPlan ? { authorizedPlan, authorizedAtlasNodes: Object.fromEntries(definition.nodes.filter((node) => node.agent === "atlas").map((node) => [node.id, nodeFingerprint(node)])) } : {}), name: definition.name, definition, fingerprint: graphFingerprint(definition), generation: 1, status: "running", nodes: definition.nodes.map((node) => ({ definition: node, fingerprint: fingerprints.get(node.id)!, status: "pending", attempt: 0, createdAt, updatedAt: createdAt })), createdAt, updatedAt: createdAt }
      store.createRun(run); event(run, "run.started")
      yield* schedule(runID)
      return yield* current(runID)
    }),
    list: (ownerSessionID) => Effect.sync(() => store.listRuns(ownerSessionID)),
    snapshot: (runID, ownerSessionID) => owned(runID, ownerSessionID).pipe(Effect.map((run) => ({ run, events: store.events(runID), steering: store.steering(runID), notices: store.notices(runID) }))),
    node: (runID, ownerSessionID, nodeID) => owned(runID, ownerSessionID).pipe(Effect.flatMap((run) => {
      const record = run.nodes.find((candidate) => candidate.definition.id === nodeID)
      return record ? Effect.succeed(record) : Effect.fail(new DagValidationError(`Unknown DAG node: ${nodeID}`))
    })),
    wait: (runID, ownerSessionID) => Effect.gen(function* () {
      const run = yield* owned(runID, ownerSessionID)
      if (terminal(run.status)) return run
      const waiter = yield* Deferred.make<DagRunRecord>()
      const set = waiters.get(runID) ?? new Set<Deferred.Deferred<DagRunRecord>>()
      set.add(waiter); waiters.set(runID, set)
      return yield* Deferred.await(waiter)
    }),
    cancel: (runID, ownerSessionID, expectedGeneration) => operating(runID, locked(runID, Effect.gen(function* () {
      let run = yield* owned(runID, ownerSessionID)
      yield* checkGeneration(run, expectedGeneration)
      if (terminal(run.status)) return run
      const refs = run.nodes.filter((node) => node.execution && (node.status === "starting" || node.status === "running")).map((node) => node.execution!)
      // A cancelled node continues nothing, and a reserved rescue it held is spent.
      run = { ...run, status: "cancelled", updatedAt: now(), nodes: run.nodes.map((node) => node.status === "pending" || node.status === "ready" || node.status === "starting" || node.status === "running" || node.status === "needs_retry" || node.status === "waiting_approval"
        ? { ...node, status: "cancelled", ...(node.recovery ? { recovery: closedRecovery(node.recovery) } : {}), updatedAt: now() } : node) }
      save(run); event(run, "run.cancelled")
      yield* Effect.forEach(refs, (ref) => Effect.ignore(runner.cancel(ref)), { discard: true })
      notify(run)
      return run
    }))),
    retry: (runID, ownerSessionID, nodeID, expectedGeneration) => Effect.gen(function* () {
      yield* operating(runID, locked(runID, Effect.gen(function* () {
      let run = yield* owned(runID, ownerSessionID)
      yield* schedulable(run)
      yield* checkAtlas(run, run.definition)
      if (options.admit) yield* options.admit(ownerSessionID, run.definition, run.authorizedPlan)
      yield* checkGeneration(run, expectedGeneration)
      if (!terminal(run.status) && !run.nodes.some((node) => node.status === "needs_retry" || node.status === "interrupted")) return yield* Effect.fail(new DagValidationError("Retry requires a terminal run or a node needing retry"))
      const selected = nodeID ? new Set([nodeID]) : new Set(run.nodes.filter((node) => node.status === "failed" || node.status === "interrupted" || node.status === "needs_retry").map((node) => node.definition.id))
      if (run.nodes.some((node) => selected.has(node.definition.id) && (node.status === "starting" || node.status === "running"))) return yield* Effect.fail(new DagValidationError("Cannot retry a live execution"))
       if (run.nodes.some((node) => (selected.has(node.definition.id) || (!nodeID && node.status === "cancelled")) && executionRequests(runID, node).length)) return yield* Effect.fail(new DagValidationError("Cannot retry a steered execution: reconcile its delivery or create a new flow with the complete task"))
      if (run.nodes.some((node) => selected.has(node.definition.id) && node.runtime?.initial === "unresolved")) return yield* Effect.fail(new DagValidationError("Initial prompt admission is unresolved; refusing to replay the original task"))
      // Blocked nodes return to pending too; the frontier blocks them again if another dependency still failed.
      // A retried node starts again from its planned model chain; an escalated node stays on its escalation lane.
      const planned = new Map(run.definition.nodes.map((node) => [node.id, node]))
      // An explicit retry is a fresh session: it continues nothing, and a spent rescue stays spent.
      const restart = (node: DagNodeRecord): DagNodeDefinition => {
        const original = planned.get(node.definition.id)
        if (original && original.agent === node.definition.agent) return original
        const rescue = node.recovery?.rescue
        return rescue && normalizedModel(node.definition.model ?? "") === rescue.model ? rescue.preRescueDefinition : node.definition
      }
      run = { ...run, generation: run.generation + 1, status: "running", updatedAt: now(), nodes: run.nodes.map((node) => selected.has(node.definition.id) || node.status === "blocked"
        ? { ...node, definition: restart(node), ...(node.recovery ? { recovery: { ...closedRecovery(node.recovery)!, failedModels: [] } } : {}), status: "pending", error: undefined, execution: undefined, updatedAt: now() } : node) }
      save(run); event(run, "node.retrying", nodeID)
      })))
      yield* schedule(runID)
      return yield* current(runID)
    }),
    resume: (runID, ownerSessionID) => controller.retry(runID, ownerSessionID),
    approve: (runID, ownerSessionID, nodeID, note, expectedGeneration) => Effect.gen(function* () {
      yield* locked(runID, Effect.gen(function* () {
        const run = yield* owned(runID, ownerSessionID)
        yield* checkGeneration(run, expectedGeneration)
        const gate = yield* gateNode(run, nodeID)
        const payload: JsonValue = { decision: "approved", ...(note === undefined ? {} : { note }) }
        const envelope: DagResultEnvelope = { schemaVersion: 1, runID, nodeID, generation: run.generation, attempt: gate.attempt, status: "completed", payload, provenance: { parentNodeIDs: gate.definition.dependsOn, agent: "human", model: "gate" }, createdAt: now() }
        let updated = updateNode(run, nodeID, (value) => ({ ...value, status: "completed", result: envelope, error: undefined, updatedAt: now() }))
        event(updated, "node.approved", nodeID, payload)
        save(updateRunStatus(updated))
      }))
      yield* schedule(runID)
      return yield* current(runID)
    }),
    reject: (runID, ownerSessionID, nodeID, note, expectedGeneration) => locked(runID, Effect.gen(function* () {
      const run = yield* owned(runID, ownerSessionID)
      yield* checkGeneration(run, expectedGeneration)
      yield* gateNode(run, nodeID)
      const message = note?.trim() ? `Rejected by approver: ${note.trim()}` : "Rejected by approver"
      let updated = updateNode(run, nodeID, (value) => ({ ...value, status: "failed", error: message, updatedAt: now() }))
      event(updated, "node.rejected", nodeID, { decision: "rejected", ...(note === undefined ? {} : { note }) })
      const records = new Map(updated.nodes.map((node) => [node.definition.id, node]))
      for (const node of updated.nodes) {
        if (node.status !== "pending" && node.status !== "needs_retry") continue
        if (dependencyState(node.definition, records) !== "blocked") continue
        updated = updateNode(updated, node.definition.id, (value) => ({ ...value, status: "blocked", error: "A dependency did not complete successfully", updatedAt: now() }))
        event(updated, "node.blocked", node.definition.id)
      }
      return save(updateRunStatus(updated))
    })),
    amend: (runID, ownerSessionID, input) => Effect.gen(function* () {
      yield* operating(runID, locked(runID, Effect.gen(function* () {
      const previous = yield* owned(runID, ownerSessionID)
      yield* schedulable(previous)
      if (activeCount(previous) > 0) return yield* Effect.fail(new DagValidationError("Cannot amend while live executions exist"))
      if (previous.nodes.some((node) => node.runtime?.initial === "unresolved")) return yield* Effect.fail(new DagValidationError("Cannot amend with unresolved initial prompt admission"))
      if (store.steering(runID).some((request) => request.state !== "delivered")) return yield* Effect.fail(new DagValidationError("Cannot amend with unresolved steering deliveries"))
      const definition = yield* validated(() => prepare(input))
      yield* checkAtlas(previous, definition)
      if (options.admit) yield* options.admit(ownerSessionID, definition, previous.authorizedPlan)
      const previousByID = new Map(previous.nodes.map((node) => [node.definition.id, node]))
      const fingerprints = fingerprintNodes(definition)
      const affected = new Set(store.steering(runID).map((request) => request.nodeID))
      let changed = true
      while (changed) {
        changed = false
        for (const node of [...previous.definition.nodes, ...definition.nodes]) {
          if (!affected.has(node.id) && node.dependsOn.some((id) => affected.has(id))) { affected.add(node.id); changed = true }
        }
      }
      const nextNodes = definition.nodes.map((node) => {
        const old = previousByID.get(node.id)
        const same = old && !affected.has(node.id) && old.fingerprint === fingerprints.get(node.id) && (old.status === "completed" || old.status === "reused")
        // A removed and re-added node keeps its spent rescue; an amended node continues nothing.
        const recovery = closedRecovery(old?.recovery ?? store.recovery(runID, node.id))
        return { definition: node, fingerprint: fingerprints.get(node.id)!, status: same ? "reused" as const : "pending" as const, attempt: same ? old.attempt : 0, ...(recovery ? { recovery } : {}), ...(same && old.result ? { result: old.result } : {}), createdAt: old?.createdAt ?? now(), updatedAt: now() }
      })
      const next: DagRunRecord = { ...previous, definition, fingerprint: graphFingerprint(definition), generation: previous.generation + 1, status: "running", nodes: nextNodes, updatedAt: now() }
      save(next)
      })))
      yield* schedule(runID)
      return yield* current(runID)
    }),
    steer: (runID, ownerSessionID, nodeID, text, requestID) => Effect.gen(function* () {
      if (!text.trim() || !requestID.trim()) return yield* Effect.fail(new DagValidationError("text and request_id are required"))
      const reserved = yield* locked(runID, Effect.gen(function* () {
        const run = yield* owned(runID, ownerSessionID)
        const previous = store.steering(runID).find((request) => request.requestID === requestID)
        if (previous) {
          if (previous.nodeID !== nodeID || previous.text !== text) return yield* Effect.fail(new DagValidationError("request_id already identifies a different steering request"))
          const node = run.nodes.find((value) => value.definition.id === nodeID)
          if (!node) return yield* Effect.fail(new DagValidationError("The steering target was removed"))
          yield* authorizeSteer(run, node)
          return { request: previous, fresh: false }
        }
        const node = yield* steeringNode(run, nodeID)
        if (executionRequests(runID, node).some((request) => request.state === "unresolved")) return yield* Effect.fail(new DagValidationError("Steering delivery is unresolved; no additional input can be admitted"))
        const revision = node.runtime!.inputRevision + 1
        const request: DagSteerRequest = { runID, nodeID, requestID, text, execution: node.execution!, generation: run.generation, revision, messageID: `msg_${randomUUID().replaceAll("-", "")}`, state: "reserved", createdAt: now() }
        const next = updateNode(run, nodeID, (value) => ({ ...value, runtime: { ...value.runtime!, inputRevision: revision } }))
        store.saveRun(next, [], [request])
        return { request, fresh: true }
      }))
      if (!reserved.fresh) return reserved.request
      return yield* operating(runID, Effect.gen(function* () {
        const request = reserved.request
        const admission = yield* Effect.exit(Effect.gen(function* () {
          yield* locked(runID, Effect.gen(function* () {
            const run = yield* owned(runID, ownerSessionID)
            const node = yield* steeringNode(run, nodeID)
            if (node.runtime!.identity.token !== request.execution.identity?.token) return yield* Effect.fail(new DagValidationError("Steering execution changed before admission"))
          }))
          return yield* runner.steer!(request.execution, request).pipe(Effect.mapError((error) => new DagValidationError(error.message)))
        }))
        const finalized = yield* locked(runID, Effect.gen(function* () {
          const run = yield* owned(runID, ownerSessionID)
          const checked = yield* Effect.exit(steeringNode(run, nodeID))
          const error = Exit.isFailure(admission) ? errorMessage(Cause.squash(admission.cause))
            : Exit.isFailure(checked) ? errorMessage(Cause.squash(checked.cause))
            : checked.value.runtime!.identity.token !== request.execution.identity?.token ? "Steering execution changed during admission" : undefined
          const updated: DagSteerRequest = { ...request, state: error ? "unresolved" : "admitted", ...(Exit.isSuccess(admission) ? { receipt: admission.value } : {}), ...(error ? { error } : {}) }
          store.saveSteering(updated)
          event(run, "node.steering", nodeID, { requestID, state: updated.state, ...(error ? { error } : {}) })
          return { request: updated, node: Exit.isSuccess(checked) ? checked.value : run.nodes.find((node) => node.definition.id === nodeID) }
        }))
        if (finalized.node) {
          if (finalized.request.state === "unresolved") {
            yield* runner.cancel(request.execution).pipe(Effect.catch((error) => Effect.sync(() => trace("iolaus.dag.steering.cancel-failed", { runID, nodeID, error: error.message }))))
            yield* interrupt(runID, finalized.node, `Steering delivery unresolved: ${finalized.request.error}`)
            yield* schedule(runID)
          } else if (finalized.node.runtime?.inputRevision === request.revision) {
            const node = finalized.node
            const requests = executionRequests(runID, node)
            yield* Effect.forkIn(Effect.gen(function* () {
              const outcome = yield* Effect.exit(runner.wait(request.execution, requests).pipe(Effect.map((result) => ({ ref: request.execution, payload: result.payload }))))
              yield* finish(runID, nodeID, node, outcome)
            }), scope)
          }
        }
        return finalized.request
      }))
    }).pipe((dispatch) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const fiber = yield* Effect.forkIn(restore(dispatch), scope)
      return yield* restore(Fiber.join(fiber))
    }))),
    // Both bodies are synchronous against the store, so they never interleave with other controller state transitions.
    observe: (input) => Effect.sync(() => {
      const at = now()
      const batch = input.batch ?? { kind: "call" as const, id: randomUUID() }
      const run = input.runID ? store.getRun(input.runID) : store.listRuns(input.ownerSessionID).find((candidate) =>
        candidate.definition.observed && candidate.definition.observedBatch?.kind === batch.kind && candidate.definition.observedBatch.id === batch.id)
      if (input.runID && (!run?.definition.observed || run.ownerSessionID !== input.ownerSessionID)) throw new Error("Unknown observed batch")
      if (input.parentNodeID && !run?.nodes.some((node) => node.definition.id === input.parentNodeID)) throw new Error("Parent must belong to the observed batch")
      const nodeID = `${(run?.nodes.length ?? 0) + 1}-${slug(input.title)}`
      const definition: DagNodeDefinition = { id: nodeID, title: input.title, agent: input.agent, ...(input.model ? { model: input.model } : {}), prompt: input.prompt, dependsOn: input.parentNodeID ? [input.parentNodeID] : [] }
      const record: DagNodeRecord = { definition, fingerprint: nodeFingerprint(definition), status: "running", attempt: 1, ...(input.sessionID ? { execution: { nodeID, attempt: 1, sessionID: input.sessionID } } : {}), createdAt: at, updatedAt: at }
      if (!run) {
        const created: DagDefinition = { schemaVersion: 1, name: "Subagent calls", observed: true, observedBatch: batch, nodes: [definition] }
        const next: DagRunRecord = { runID: randomUUID(), ownerSessionID: input.ownerSessionID, name: created.name, definition: created, fingerprint: graphFingerprint(created), generation: 1, status: "running", nodes: [record], createdAt: at, updatedAt: at }
        store.createRun(next); event(next, "run.started"); event(next, "node.started", nodeID)
        return { runID: next.runID, nodeID }
      }
      const grown: DagDefinition = { ...run.definition, nodes: [...run.definition.nodes, definition] }
      const next: DagRunRecord = { ...run, definition: grown, fingerprint: graphFingerprint(grown), status: "running", nodes: [...run.nodes, record], updatedAt: at }
      save(next); event(next, "node.started", nodeID)
      return { runID: run.runID, nodeID }
    }),
    observed: (runID, nodeID, update) => Effect.sync(() => {
      const run = store.getRun(runID)
      const node = run?.nodes.find((candidate) => candidate.definition.id === nodeID)
      if (!run || !node || !run.definition.observed) return
      const at = now()
      // A child's settle can arrive twice (its idle event and the tool result); the first one wins, a later one only fills a missing model.
      if (update.status !== "running" && node.status !== "running") {
        if (update.status !== "completed" || !update.model || node.definition.model) return
        const definition = { ...node.definition, model: update.model }
        const patched: DagRunRecord = { ...run, definition: { ...run.definition, nodes: run.definition.nodes.map((candidate) => candidate.id === nodeID ? definition : candidate) },
          nodes: run.nodes.map((candidate) => candidate.definition.id === nodeID ? { ...candidate, definition, updatedAt: at } : candidate), updatedAt: at }
        save(patched)
        return
      }
      let next: DagNodeRecord
      if (update.status === "running") {
        const execution = update.sessionID ? { nodeID, attempt: node.attempt, sessionID: update.sessionID } : node.execution
        const definition = update.model && !node.definition.model ? { ...node.definition, model: update.model } : node.definition
        if (node.status === "running") {
          if (execution === node.execution && definition === node.definition) return
          next = { ...node, definition, ...(execution ? { execution } : {}), updatedAt: at }
        } else {
          const attempt = node.attempt + 1
          next = { ...node, definition, status: "running", attempt, error: undefined, ...(execution ? { execution: { ...execution, attempt } } : {}), updatedAt: at }
        }
      } else if (update.status === "completed") {
        const model = node.definition.model ?? update.model
        const result: DagResultEnvelope = { schemaVersion: 1, runID, nodeID, generation: run.generation, attempt: node.attempt, status: "completed", payload: { text: update.text }, provenance: { parentNodeIDs: node.definition.dependsOn, ...(node.execution ? { execution: node.execution } : {}), agent: node.definition.agent ?? "", model: model ?? "" }, createdAt: at }
        next = { ...node, ...(model && !node.definition.model ? { definition: { ...node.definition, model } } : {}), status: "completed", result, error: undefined, updatedAt: at }
      } else next = { ...node, status: update.status, error: update.error, updatedAt: at }
      const nodes = run.nodes.map((candidate) => candidate.definition.id === nodeID ? next : candidate)
      const definitionNodes = next.definition === node.definition ? run.definition.nodes : run.definition.nodes.map((candidate) => candidate.id === nodeID ? next.definition : candidate)
      const active = nodes.some((candidate) => candidate.status === "running")
      const status: DagRunRecord["status"] = active ? "running" : run.status === "cancelled" ? "cancelled"
        : nodes.some((candidate) => candidate.status === "failed" || candidate.status === "interrupted") ? "failed" : "completed"
      const definition = definitionNodes === run.definition.nodes ? run.definition : { ...run.definition, nodes: definitionNodes }
      const updated: DagRunRecord = { ...run, definition, nodes, status, updatedAt: at }
      save(updated)
      event(updated, update.status === "running" ? "node.started" : update.status === "completed" ? "node.completed" : "node.failed", nodeID,
        update.status === "completed" ? { text: update.text } : update.status === "running" ? undefined : { message: update.error, status: update.status })
      if (status !== run.status && (status === "completed" || status === "failed")) event(updated, status === "completed" ? "run.completed" : "run.failed")
      notify(updated)
    }),
    observedChild: (sessionID) => Effect.sync(() => {
      const found = store.observedNode(sessionID)
      return found ? { runID: found.runID, nodeID: found.nodeID, owner: found.ownerSessionID } : undefined
    }),
    close: Effect.sync(() => {
      closed = true
      Effect.runFork(Scope.close(scope, Exit.void))
      for (const set of waiters.values()) for (const waiter of set) Deferred.doneUnsafe(waiter, Exit.fail(new DagValidationError("Iolaus DAG controller closed")) as never)
      waiters.clear()
      store.close()
    }),
  }
  const shared: SharedController = { controller, refs: 1 }
  sharedControllers.set(key, shared)
  if (options.notifier) Effect.runFork(Effect.forkIn(Effect.forEach(store.notices(), (notice) => deliverNotice(notice.eventID), { discard: true }), scope))
  Effect.runFork(Effect.forkIn(Effect.forEach(store.listRuns().filter((run) => !terminal(run.status)), recover, { discard: true }), scope))
  return { ...controller, close: Effect.sync(() => releaseSharedController(key, shared)) }
}

function releaseSharedController(path: string, shared: SharedController): void {
  shared.refs -= 1
  if (shared.refs > 0) return
  sharedControllers.delete(path)
  Effect.runSync(shared.controller.close)
}

export { fingerprint }
