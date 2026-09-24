import { randomUUID } from "node:crypto"
import { evaluateCondition } from "./condition"
import { DagValidationError, dependencyState, isGate, validateDefinition } from "./graph"
import { fingerprint, graphFingerprint, nodeFingerprint } from "./fingerprint"
import type { DagRunner } from "./runner"
import { DagStore, resolveDagDatabasePath } from "./store"
import type { DagDefinition, DagEvent, DagNodeRecord, DagResolvedInput, DagResultEnvelope, DagRunRecord, DagSnapshot, JsonValue } from "./types"

export interface DagController {
  readonly create: (definition: DagDefinition, ownerSessionID: string) => Promise<DagRunRecord>
  readonly list: (ownerSessionID?: string) => Promise<readonly DagRunRecord[]>
  readonly snapshot: (runID: string, ownerSessionID: string) => Promise<DagSnapshot>
  readonly node: (runID: string, ownerSessionID: string, nodeID: string) => Promise<DagNodeRecord>
  readonly wait: (runID: string, ownerSessionID: string) => Promise<DagRunRecord>
  readonly cancel: (runID: string, ownerSessionID: string, expectedGeneration?: number) => Promise<DagRunRecord>
  readonly retry: (runID: string, ownerSessionID: string, nodeID?: string, expectedGeneration?: number) => Promise<DagRunRecord>
  readonly resume: (runID: string, ownerSessionID: string) => Promise<DagRunRecord>
  readonly approve: (runID: string, ownerSessionID: string, nodeID: string, note?: string, expectedGeneration?: number) => Promise<DagRunRecord>
  readonly reject: (runID: string, ownerSessionID: string, nodeID: string, note?: string, expectedGeneration?: number) => Promise<DagRunRecord>
  readonly amend: (runID: string, ownerSessionID: string, definition: DagDefinition) => Promise<DagRunRecord>
  readonly close: () => void
}

export interface DagControllerOptions {
  readonly directory: string
  readonly runner: DagRunner
  /** Returns the configured "provider/model[#variant]" for an agent ID, or undefined. */
  readonly defaultModel?: (agent: string) => string | undefined
  readonly maxParallel?: number
  readonly now?: () => number
  readonly trace?: (event: string, data?: Record<string, unknown>) => void
  readonly onEvent?: (event: DagEvent, ownerSessionID: string) => void | Promise<void>
}

type Waiter = { readonly resolve: (run: DagRunRecord) => void; readonly reject: (error: unknown) => void }
type SharedController = { readonly controller: DagController; refs: number }
const sharedControllers = new Map<string, SharedController>()

function terminal(status: DagRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function nodeTerminal(status: DagNodeRecord["status"]): boolean {
  return status === "completed" || status === "reused" || status === "failed" || status === "blocked" || status === "cancelled"
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

export function applyDefaultModels(definition: DagDefinition, defaultModel: DagControllerOptions["defaultModel"]): DagDefinition {
  if (!defaultModel) return definition
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (isGate(node) || node.model !== undefined || node.agent === undefined) return node
      const model = defaultModel(node.agent)
      return model === undefined ? node : { ...node, model }
    }),
  }
}

export function createDagController(options: DagControllerOptions): DagController {
  const databasePath = resolveDagDatabasePath(options.directory)
  const existing = sharedControllers.get(databasePath)
  if (existing) {
    existing.refs += 1
    return { ...existing.controller, close: () => releaseSharedController(databasePath, existing) }
  }
  const store = new DagStore(databasePath)
  const runner = options.runner
  const now = options.now ?? Date.now
  const maxParallel = options.maxParallel ?? 4
  const queues = new Map<string, Promise<void>>()
  const waiters = new Map<string, Set<Waiter>>()
  let closed = false

  const trace = (event: string, data: Record<string, unknown> = {}) => options.trace?.(event, data)
  const event = (run: DagRunRecord, type: DagEvent["type"], nodeID?: string, payload?: JsonValue) => {
    store.appendAction({ runID: run.runID, ...(nodeID ? { nodeID } : {}), kind: type, idempotencyKey: `${type}:${nodeID ?? "run"}:${run.generation}:${now()}`, ...(payload === undefined ? {} : { payload }), createdAt: now() })
    const created = store.appendEvent({ schemaVersion: 1, runID: run.runID, generation: run.generation, type, createdAt: now(), ...(nodeID ? { nodeID } : {}), ...(payload === undefined ? {} : { payload }) })
    trace(`iolaus.dag.${type}`, { runID: run.runID, generation: run.generation, ...(nodeID ? { nodeID } : {}), sequence: created.sequence })
    void options.onEvent?.(created, run.ownerSessionID)
  }
  const withQueue = async <T>(runID: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(runID) ?? Promise.resolve()
    let release: () => void = () => undefined
    const turn = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => turn)
    queues.set(runID, queued)
    await previous
    try { return await task() } finally { release(); if (queues.get(runID) === queued) queues.delete(runID) }
  }
  const owned = (runID: string, ownerSessionID: string): DagRunRecord => {
    const run = store.getRun(runID)
    if (!run) throw new DagValidationError(`Unknown Iolaus DAG run: ${runID}`)
    if (run.ownerSessionID !== ownerSessionID) throw new DagValidationError("Iolaus DAG run belongs to another session")
    return run
  }
  const notify = (run: DagRunRecord) => {
    if (!terminal(run.status)) return
    const pending = waiters.get(run.runID)
    if (!pending) return
    waiters.delete(run.runID)
    for (const waiter of pending) waiter.resolve(run)
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
  const schedule = async (runID: string): Promise<void> => {
    if (closed) return
    return withQueue(runID, async () => {
    if (closed) return
    let run = store.getRun(runID)
    if (!run || closed || terminal(run.status)) return
    const records = new Map(run.nodes.map((node) => [node.definition.id, node]))
    const launches: DagNodeRecord[] = []
    for (const node of run.nodes) {
      if (node.status !== "pending" && node.status !== "needs_retry") continue
      const state = dependencyState(node.definition, records)
      if (state === "blocked") {
        run = updateNode(run, node.definition.id, (current) => ({ ...current, status: "blocked", error: "A dependency did not complete successfully", updatedAt: now() }))
        event(run, "node.blocked", node.definition.id)
        continue
      }
      if (state !== "ready") continue
      if (node.definition.when && !evaluateCondition(node.definition.when, conditionSource(run))) {
        run = updateNode(run, node.definition.id, (current) => ({ ...current, status: "skipped", error: undefined, updatedAt: now() }))
        event(run, "node.skipped", node.definition.id, { reason: "condition_false" })
        records.set(node.definition.id, run.nodes.find((candidate) => candidate.definition.id === node.definition.id)!)
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
    run = updateRunStatus(run)
    save(run)
    for (const node of launches) void launch(runID, node.definition.id)
    })
  }
  const launch = async (runID: string, nodeID: string): Promise<void> => {
    let run = store.getRun(runID)
    const node = run?.nodes.find((candidate) => candidate.definition.id === nodeID)
    if (!run || !node || node.status !== "starting") return
    try {
      const ref = await runner.start({ node: node.definition, prompt: buildPrompt(node, run), attempt: node.attempt })
      await withQueue(runID, async () => {
        const current = store.getRun(runID)
        if (!current) return
        const updated = updateNode(current, nodeID, (value) => ({ ...value, status: "running", execution: ref, updatedAt: now() }))
        save(updated); event(updated, "node.started", nodeID)
      })
      const result = await runner.wait(ref)
      await withQueue(runID, async () => {
        const current = store.getRun(runID)
        if (!current) return
        const envelope: DagResultEnvelope = { schemaVersion: 1, runID, nodeID, generation: current.generation, attempt: node.attempt, status: "completed", payload: result.payload, provenance: { parentNodeIDs: node.definition.dependsOn, execution: ref, agent: node.definition.agent ?? "", model: node.definition.model ?? "" }, createdAt: now() }
        let updated = updateNode(current, nodeID, (value) => ({ ...value, status: "completed", result: envelope, error: undefined, updatedAt: now() }))
        event(updated, "node.completed", nodeID, envelope.payload)
        updated = updateRunStatus(updated); save(updated)
      })
      await schedule(runID)
    } catch (error) {
      await withQueue(runID, async () => {
        const current = store.getRun(runID)
        if (!current) return
        const message = error instanceof Error ? error.message : String(error)
        const attempts = current.nodes.find((candidate) => candidate.definition.id === nodeID)?.attempt ?? node.attempt
        const maxAttempts = node.definition.maxAttempts ?? 1
        const status: DagNodeRecord["status"] = attempts < maxAttempts ? "needs_retry" : "failed"
        const updated = updateNode(current, nodeID, (value) => ({ ...value, status, error: message, updatedAt: now() }))
        event(updated, "node.failed", nodeID, { message, status })
        save(updateRunStatus(updated))
      })
      await schedule(runID)
    }
  }

  const controller: DagController = {
    async create(input, ownerSessionID) {
      const definition = applyDefaultModels(input, options.defaultModel)
      validateDefinition(definition)
      const createdAt = now()
      const runID = randomUUID()
      const fp = graphFingerprint(definition)
      const fingerprints = new Map<string, string>()
      for (const node of definition.nodes) fingerprints.set(node.id, nodeFingerprint(node, node.dependsOn.map((dependency) => fingerprints.get(dependency) ?? "")))
      const run: DagRunRecord = { runID, ownerSessionID, name: definition.name, definition, fingerprint: fp, generation: 1, status: "running", nodes: definition.nodes.map((node) => ({ definition: node, fingerprint: fingerprints.get(node.id)!, status: "pending", attempt: 0, createdAt, updatedAt: createdAt })), createdAt, updatedAt: createdAt }
      store.createRun(run); event(run, "run.started"); await schedule(runID); return store.getRun(runID)!
    },
    async list(ownerSessionID) { return store.listRuns(ownerSessionID) },
    async snapshot(runID, ownerSessionID) { const run = owned(runID, ownerSessionID); return { run, events: store.events(runID) } },
    async node(runID, ownerSessionID, nodeID) {
      const record = owned(runID, ownerSessionID).nodes.find((candidate) => candidate.definition.id === nodeID)
      if (!record) throw new DagValidationError(`Unknown DAG node: ${nodeID}`)
      return record
    },
    async wait(runID, ownerSessionID) {
      const current = owned(runID, ownerSessionID)
      if (terminal(current.status)) return current
      return await new Promise<DagRunRecord>((resolve, reject) => { const set = waiters.get(runID) ?? new Set<Waiter>(); set.add({ resolve, reject }); waiters.set(runID, set) })
    },
    async cancel(runID, ownerSessionID, expectedGeneration) {
      let run = owned(runID, ownerSessionID)
      if (expectedGeneration !== undefined && run.generation !== expectedGeneration) throw new DagValidationError("DAG generation has changed")
      if (terminal(run.status)) return run
      const refs = run.nodes.filter((node) => node.execution && (node.status === "starting" || node.status === "running")).map((node) => node.execution!)
      run = { ...run, status: "cancelled", updatedAt: now(), nodes: run.nodes.map((node) => node.status === "pending" || node.status === "ready" || node.status === "needs_retry" || node.status === "waiting_approval" ? { ...node, status: "cancelled", updatedAt: now() } : node) }
      save(run); event(run, "run.cancelled"); for (const ref of refs) await runner.cancel(ref); notify(run); return run
    },
    async retry(runID, ownerSessionID, nodeID, expectedGeneration) {
      let run = owned(runID, ownerSessionID)
      if (expectedGeneration !== undefined && run.generation !== expectedGeneration) throw new DagValidationError("DAG generation has changed")
      if (!terminal(run.status) && !run.nodes.some((node) => node.status === "needs_retry")) throw new DagValidationError("Retry requires a terminal run or a node needing retry")
      const selected = nodeID ? new Set([nodeID]) : new Set(run.nodes.filter((node) => node.status === "failed" || node.status === "interrupted" || node.status === "needs_retry").map((node) => node.definition.id))
      run = { ...run, generation: run.generation + 1, status: "running", updatedAt: now(), nodes: run.nodes.map((node) => selected.has(node.definition.id) ? { ...node, status: "pending", error: undefined, execution: undefined, updatedAt: now() } : node) }
      save(run); event(run, "node.retrying", nodeID); await schedule(runID); return store.getRun(runID)!
    },
    async resume(runID, ownerSessionID) { return this.retry(runID, ownerSessionID) },
    async approve(runID, ownerSessionID, nodeID, note, expectedGeneration) {
      await withQueue(runID, async () => {
        const run = owned(runID, ownerSessionID)
        if (expectedGeneration !== undefined && run.generation !== expectedGeneration) throw new DagValidationError("DAG generation has changed")
        const gate = run.nodes.find((node) => node.definition.id === nodeID)
        if (!gate || !isGate(gate.definition)) throw new DagValidationError(`Not a gate node: ${nodeID}`)
        if (gate.status !== "waiting_approval") throw new DagValidationError(`Gate is not waiting for approval: ${nodeID}`)
        const payload: JsonValue = { decision: "approved", ...(note === undefined ? {} : { note }) }
        const envelope: DagResultEnvelope = { schemaVersion: 1, runID, nodeID, generation: run.generation, attempt: gate.attempt, status: "completed", payload, provenance: { parentNodeIDs: gate.definition.dependsOn, agent: "human", model: "gate" }, createdAt: now() }
        let updated = updateNode(run, nodeID, (value) => ({ ...value, status: "completed", result: envelope, error: undefined, updatedAt: now() }))
        event(updated, "node.approved", nodeID, payload)
        updated = updateRunStatus(updated); save(updated)
      })
      await schedule(runID)
      return store.getRun(runID)!
    },
    async reject(runID, ownerSessionID, nodeID, note, expectedGeneration) {
      return withQueue(runID, async () => {
        const run = owned(runID, ownerSessionID)
        if (expectedGeneration !== undefined && run.generation !== expectedGeneration) throw new DagValidationError("DAG generation has changed")
        const gate = run.nodes.find((node) => node.definition.id === nodeID)
        if (!gate || !isGate(gate.definition)) throw new DagValidationError(`Not a gate node: ${nodeID}`)
        if (gate.status !== "waiting_approval") throw new DagValidationError(`Gate is not waiting for approval: ${nodeID}`)
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
        updated = updateRunStatus(updated); save(updated)
        return updated
      })
    },
    async amend(runID, ownerSessionID, input) {
      const definition = applyDefaultModels(input, options.defaultModel)
      validateDefinition(definition)
      const previous = owned(runID, ownerSessionID)
      const previousByID = new Map(previous.nodes.map((node) => [node.definition.id, node]))
      const fingerprints = new Map<string, string>()
      for (const node of definition.nodes) fingerprints.set(node.id, nodeFingerprint(node, node.dependsOn.map((dependency) => fingerprints.get(dependency) ?? "")))
      const nextNodes = definition.nodes.map((node) => {
        const old = previousByID.get(node.id)
        const same = old && old.fingerprint === fingerprints.get(node.id) && (old.status === "completed" || old.status === "reused")
        return { definition: node, fingerprint: fingerprints.get(node.id)!, status: same ? "reused" as const : "pending" as const, attempt: same ? old.attempt : 0, ...(same && old.result ? { result: old.result } : {}), createdAt: old?.createdAt ?? now(), updatedAt: now() }
      })
      const next: DagRunRecord = { ...previous, definition, fingerprint: graphFingerprint(definition), generation: previous.generation + 1, status: "running", nodes: nextNodes, updatedAt: now() }
      save(next); await schedule(runID); return store.getRun(runID)!
    },
    close() { closed = true; store.close() },
  }
  const shared: SharedController = { controller, refs: 1 }
  sharedControllers.set(databasePath, shared)
  return { ...controller, close: () => releaseSharedController(databasePath, shared) }
}

function releaseSharedController(path: string, shared: SharedController): void {
  shared.refs -= 1
  if (shared.refs > 0) return
  sharedControllers.delete(path)
  shared.controller.close()
}
