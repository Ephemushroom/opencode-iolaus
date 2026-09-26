import { randomUUID } from "node:crypto"
import { Deferred, Effect, Exit, Scope, Semaphore } from "effect"
import { evaluateCondition } from "./condition"
import { DagRunnerError, DagValidationError, errorMessage } from "./errors"
import { dependencyState, isGate, validateDefinition } from "./graph"
import { growLoop } from "./loop"
import { fingerprint, graphFingerprint, nodeFingerprint } from "./fingerprint"
import type { DagRunner } from "./runner"
import { DagStore, resolveDagDatabasePath } from "./store"
import type { DagDefinition, DagEvent, DagNodeRecord, DagResolvedInput, DagResultEnvelope, DagRunRecord, DagSnapshot, JsonValue } from "./types"

export { DagValidationError }

/**
 * Every operation is an Effect. Failures are typed (`DagValidationError`); node
 * execution failures never escape, they become node retry/failure state.
 */
export interface DagController {
  readonly create: (definition: DagDefinition, ownerSessionID: string) => Effect.Effect<DagRunRecord, DagValidationError>
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
  readonly close: Effect.Effect<void>
}

export interface DagControllerOptions {
  readonly directory: string
  readonly runner: DagRunner
  /** Returns the configured "provider/model[#variant]" for an agent ID, or undefined. */
  readonly defaultModel?: (agent: string) => string | undefined
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
      provenance: result ? { agent: result.provenance.agent, model: result.provenance.model, attempt: result.attempt, status: result.status, sessionID: result.provenance.execution?.sessionID ?? null } : null,
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
export function applyDefaultModels(definition: DagDefinition, defaultModel: DagControllerOptions["defaultModel"]): DagDefinition {
  const missing: string[] = []
  const nodes = definition.nodes.map((node) => {
    if (isGate(node) || node.model !== undefined || node.agent === undefined) return node
    const model = defaultModel?.(node.agent)
    if (model === undefined) { missing.push(`${node.id} (${node.agent})`); return node }
    return { ...node, model }
  })
  if (missing.length) throw new DagValidationError(`model_unavailable: no configured model for ${missing.join(", ")}; set model on the node or configure the lane in .iolaus/models.json`)
  return { ...definition, nodes }
}

/** Runs synchronous validation code as a typed Effect failure. */
function validated<A>(compute: () => A): Effect.Effect<A, DagValidationError> {
  return Effect.try({ try: compute, catch: (error) => error instanceof DagValidationError ? error : new DagValidationError(error instanceof Error ? error.message : String(error)) })
}

export function createDagController(options: DagControllerOptions): DagController {
  const databasePath = resolveDagDatabasePath(options.directory)
  const existing = sharedControllers.get(databasePath)
  if (existing) {
    existing.refs += 1
    return { ...existing.controller, close: Effect.sync(() => releaseSharedController(databasePath, existing)) }
  }
  const store = new DagStore(databasePath)
  const runner = options.runner
  const now = options.now ?? Date.now
  const maxParallel = options.maxParallel ?? 4
  const locks = new Map<string, Semaphore.Semaphore>()
  const waiters = new Map<string, Set<Deferred.Deferred<DagRunRecord>>>()
  // Every launch fiber lives in this scope; closing the controller interrupts them.
  const scope = Scope.makeUnsafe()
  let closed = false

  const trace = (event: string, data: Record<string, unknown> = {}) => options.trace?.(event, data)
  const emit = (event: DagEvent, ownerSessionID: string): void => {
    const result = options.onEvent?.(event, ownerSessionID)
    if (result && typeof result === "object" && "then" in result) void (result as Promise<void>).catch(() => undefined)
    else if (result && Effect.isEffect(result)) Effect.runFork(Effect.ignore(result as Effect.Effect<void, unknown>))
  }
  const event = (run: DagRunRecord, type: DagEvent["type"], nodeID?: string, payload?: JsonValue) => {
    store.appendAction({ runID: run.runID, ...(nodeID ? { nodeID } : {}), kind: type, idempotencyKey: `${type}:${nodeID ?? "run"}:${run.generation}:${now()}`, ...(payload === undefined ? {} : { payload }), createdAt: now() })
    const created = store.appendEvent({ schemaVersion: 1, runID: run.runID, generation: run.generation, type, createdAt: now(), ...(nodeID ? { nodeID } : {}), ...(payload === undefined ? {} : { payload }) })
    trace(`iolaus.dag.${type}`, { runID: run.runID, generation: run.generation, ...(nodeID ? { nodeID } : {}), sequence: created.sequence })
    emit(created, run.ownerSessionID)
  }
  /** Per-run critical section. Each run has one permit, so state transitions never interleave. */
  const locked = <A, E>(runID: string, task: Effect.Effect<A, E>): Effect.Effect<A, E> => {
    let lock = locks.get(runID)
    if (!lock) { lock = Semaphore.makeUnsafe(1); locks.set(runID, lock) }
    return lock.withPermit(task)
  }
  const owned = (runID: string, ownerSessionID: string): Effect.Effect<DagRunRecord, DagValidationError> => Effect.suspend(() => {
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
        if (activeCount(run) + launches.length >= Math.min(maxParallel, run.definition.maxParallel ?? maxParallel)) continue
        const next = updateNode(run, node.definition.id, (current) => ({ ...current, status: "starting", attempt: current.attempt + 1, updatedAt: now() }))
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
      Effect.flatMap((launches) => Effect.forEach(launches, (node) => Effect.forkIn(launch(runID, node.definition.id), scope), { discard: true })),
    )
  })

  const settle = (runID: string, nodeID: string, node: DagNodeRecord, outcome: Exit.Exit<{ ref: import("./types").DagExecutionRef; payload: JsonValue }, DagRunnerError>): Effect.Effect<void> =>
    locked(runID, Effect.sync(() => {
      const current = store.getRun(runID)
      if (!current) return
      if (Exit.isSuccess(outcome)) {
        const { ref, payload } = outcome.value
        const envelope: DagResultEnvelope = { schemaVersion: 1, runID, nodeID, generation: current.generation, attempt: node.attempt, status: "completed", payload, provenance: { parentNodeIDs: node.definition.dependsOn, execution: ref, agent: node.definition.agent ?? "", model: node.definition.model ?? "" }, createdAt: now() }
        let updated = updateNode(current, nodeID, (value) => ({ ...value, status: "completed", result: envelope, error: undefined, updatedAt: now() }))
        event(updated, "node.completed", nodeID, envelope.payload)
        save(updateRunStatus(updated))
        return
      }
      const message = errorMessage(Exit.isFailure(outcome) ? (outcome.cause as { failures?: unknown }) : outcome)
      const attempts = current.nodes.find((candidate) => candidate.definition.id === nodeID)?.attempt ?? node.attempt
      const maxAttempts = node.definition.maxAttempts ?? 1
      const status: DagNodeRecord["status"] = attempts < maxAttempts ? "needs_retry" : "failed"
      const updated = updateNode(current, nodeID, (value) => ({ ...value, status, error: message, updatedAt: now() }))
      event(updated, "node.failed", nodeID, { message, status })
      save(updateRunStatus(updated))
    }))

  const launch = (runID: string, nodeID: string): Effect.Effect<void> => Effect.gen(function* () {
    const run = store.getRun(runID)
    const node = run?.nodes.find((candidate) => candidate.definition.id === nodeID)
    if (!run || !node || node.status !== "starting") return
    const execution = Effect.gen(function* () {
      const ref = yield* runner.start({ node: node.definition, prompt: buildPrompt(node, run), attempt: node.attempt })
      yield* locked(runID, Effect.sync(() => {
        const current = store.getRun(runID)
        if (!current) return
        const updated = updateNode(current, nodeID, (value) => ({ ...value, status: "running", execution: ref, updatedAt: now() }))
        save(updated); event(updated, "node.started", nodeID)
      }))
      const result = yield* runner.wait(ref)
      return { ref, payload: result.payload }
    })
    const outcome = yield* Effect.exit(execution)
    yield* settle(runID, nodeID, node, outcome)
    yield* grow(runID, nodeID)
    yield* schedule(runID)
  })

  /** Dynamic review loop: after a review settles FAIL with rounds left, append the next fix/review pair. */
  const grow = (runID: string, nodeID: string): Effect.Effect<void> => locked(runID, Effect.sync(() => {
    const run = store.getRun(runID)
    if (!run || !run.definition.loop || terminal(run.status)) return
    const next = growLoop(run, nodeID)
    if (!next) return
    const definition = applyDefaultModels(next, options.defaultModel)
    validateDefinition(definition)
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

  const controller: DagController = {
    create: (input, ownerSessionID) => Effect.gen(function* () {
      const definition = yield* validated(() => { const d = applyDefaultModels(input, options.defaultModel); validateDefinition(d); return d })
      const createdAt = now()
      const runID = randomUUID()
      const fingerprints = fingerprintNodes(definition)
      const run: DagRunRecord = { runID, ownerSessionID, name: definition.name, definition, fingerprint: graphFingerprint(definition), generation: 1, status: "running", nodes: definition.nodes.map((node) => ({ definition: node, fingerprint: fingerprints.get(node.id)!, status: "pending", attempt: 0, createdAt, updatedAt: createdAt })), createdAt, updatedAt: createdAt }
      store.createRun(run); event(run, "run.started")
      yield* schedule(runID)
      return yield* current(runID)
    }),
    list: (ownerSessionID) => Effect.sync(() => store.listRuns(ownerSessionID)),
    snapshot: (runID, ownerSessionID) => owned(runID, ownerSessionID).pipe(Effect.map((run) => ({ run, events: store.events(runID) }))),
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
    cancel: (runID, ownerSessionID, expectedGeneration) => Effect.gen(function* () {
      let run = yield* owned(runID, ownerSessionID)
      yield* checkGeneration(run, expectedGeneration)
      if (terminal(run.status)) return run
      const refs = run.nodes.filter((node) => node.execution && (node.status === "starting" || node.status === "running")).map((node) => node.execution!)
      run = { ...run, status: "cancelled", updatedAt: now(), nodes: run.nodes.map((node) => node.status === "pending" || node.status === "ready" || node.status === "needs_retry" || node.status === "waiting_approval" ? { ...node, status: "cancelled", updatedAt: now() } : node) }
      save(run); event(run, "run.cancelled")
      yield* Effect.forEach(refs, (ref) => Effect.ignore(runner.cancel(ref)), { discard: true })
      notify(run)
      return run
    }),
    retry: (runID, ownerSessionID, nodeID, expectedGeneration) => Effect.gen(function* () {
      let run = yield* owned(runID, ownerSessionID)
      yield* checkGeneration(run, expectedGeneration)
      if (!terminal(run.status) && !run.nodes.some((node) => node.status === "needs_retry")) return yield* Effect.fail(new DagValidationError("Retry requires a terminal run or a node needing retry"))
      const selected = nodeID ? new Set([nodeID]) : new Set(run.nodes.filter((node) => node.status === "failed" || node.status === "interrupted" || node.status === "needs_retry").map((node) => node.definition.id))
      run = { ...run, generation: run.generation + 1, status: "running", updatedAt: now(), nodes: run.nodes.map((node) => selected.has(node.definition.id) ? { ...node, status: "pending", error: undefined, execution: undefined, updatedAt: now() } : node) }
      save(run); event(run, "node.retrying", nodeID)
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
      const definition = yield* validated(() => { const d = applyDefaultModels(input, options.defaultModel); validateDefinition(d); return d })
      const previous = yield* owned(runID, ownerSessionID)
      const previousByID = new Map(previous.nodes.map((node) => [node.definition.id, node]))
      const fingerprints = fingerprintNodes(definition)
      const nextNodes = definition.nodes.map((node) => {
        const old = previousByID.get(node.id)
        const same = old && old.fingerprint === fingerprints.get(node.id) && (old.status === "completed" || old.status === "reused")
        return { definition: node, fingerprint: fingerprints.get(node.id)!, status: same ? "reused" as const : "pending" as const, attempt: same ? old.attempt : 0, ...(same && old.result ? { result: old.result } : {}), createdAt: old?.createdAt ?? now(), updatedAt: now() }
      })
      const next: DagRunRecord = { ...previous, definition, fingerprint: graphFingerprint(definition), generation: previous.generation + 1, status: "running", nodes: nextNodes, updatedAt: now() }
      save(next)
      yield* schedule(runID)
      return yield* current(runID)
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
  sharedControllers.set(databasePath, shared)
  return { ...controller, close: Effect.sync(() => releaseSharedController(databasePath, shared)) }
}

function releaseSharedController(path: string, shared: SharedController): void {
  shared.refs -= 1
  if (shared.refs > 0) return
  sharedControllers.delete(path)
  Effect.runSync(shared.controller.close)
}

export { fingerprint }
