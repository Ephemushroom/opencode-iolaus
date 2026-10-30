import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { canonicalProject, databasePath, openDatabase } from "../database"
import { canonicalJson } from "./canonical-json"
import type { DagAction, DagDefinition, DagEvent, DagNodeRecord, DagNotice, DagRunRecord, DagSteerRequest, JsonValue } from "./types"
import { noticeFor } from "./notices"

type RunRow = { run_id: string; owner_session_id: string; name: string; definition_json: string; fingerprint: string; generation: number; status: DagRunRecord["status"]; created_at: number; updated_at: number }
type NodeRow = { run_id: string; node_id: string; node_json: string; fingerprint: string; status: DagNodeRecord["status"]; attempt: number; result_json: string | null; error: string | null; execution_json: string | null; created_at: number; updated_at: number }

function parse<T>(value: string): T {
  return JSON.parse(value) as T
}

export function resolveDagDatabasePath(directory: string): string {
  return databasePath(directory)
}

export class DagStore {
  readonly path: string
  readonly project: string
  private readonly db: Database

  constructor(path: string, project: string) {
    this.path = path
    this.project = canonicalProject(project)
    this.db = openDatabase(path)
  }

  close(): void { this.db.close() }

  createRun(run: DagRunRecord): void {
    this.transaction(() => {
      this.db.run("INSERT INTO dag_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [run.runID, this.project, run.ownerSessionID, run.name, canonicalJson(run.definition), run.fingerprint, run.generation, run.status, run.createdAt, run.updatedAt])
      if (run.authorizedPlan && run.authorizedAtlasNodes) this.db.run("INSERT INTO dag_authorizations VALUES (?, ?, ?)", [run.runID, run.authorizedPlan, canonicalJson(run.authorizedAtlasNodes)])
      for (const node of run.nodes) this.writeNode(run.runID, node)
    })
  }

  saveRun(run: DagRunRecord, events: readonly Omit<DagEvent, "eventID" | "sequence">[] = [], steering: readonly DagSteerRequest[] = [], notices = false): readonly DagEvent[] {
    if (!this.owns(run.runID)) throw new Error("Unknown DAG run in this project")
    const committed: DagEvent[] = []
    this.transaction(() => {
      this.db.run("UPDATE dag_runs SET definition_json = ?, fingerprint = ?, generation = ?, status = ?, updated_at = ? WHERE run_id = ? AND project = ?", [canonicalJson(run.definition), run.fingerprint, run.generation, run.status, run.updatedAt, run.runID, this.project])
      this.db.run("DELETE FROM dag_nodes WHERE run_id = ?", [run.runID])
      this.db.run("DELETE FROM dag_node_runtime WHERE run_id = ?", [run.runID])
      for (const node of run.nodes) this.writeNode(run.runID, node)
      for (const request of steering) this.saveSteering(request)
      for (const event of events) {
        const entry = this.appendEvent(event)
        this.appendAction({ runID: run.runID, nodeID: event.nodeID, kind: event.type,
          idempotencyKey: entry.eventID, payload: event.payload, createdAt: event.createdAt })
        const notice = notices ? noticeFor(entry, run) : undefined
        if (notice) this.saveNotice(notice)
        committed.push(entry)
      }
    })
    return committed
  }

  /** `anyProject` reads a run another project's controller owns; only lineage uses it, for runs working in this project. */
  getRun(runID: string, anyProject = false): DagRunRecord | undefined {
    const row = (anyProject ? this.db.query("SELECT * FROM dag_runs WHERE run_id = ?").get(runID) : this.db.query("SELECT * FROM dag_runs WHERE run_id = ? AND project = ?").get(runID, this.project)) as RunRow | null
    if (!row) return undefined
    const nodeRows = this.db.query("SELECT * FROM dag_nodes WHERE run_id = ? ORDER BY node_id").all(runID) as NodeRow[]
    const definition = parse<DagDefinition>(row.definition_json)
    const positions = new Map(definition.nodes.map((node, index) => [node.id, index]))
    nodeRows.sort((left, right) => (positions.get(left.node_id) ?? Infinity) - (positions.get(right.node_id) ?? Infinity))
    const runtimeRows = this.db.query("SELECT node_id, value_json FROM dag_node_runtime WHERE run_id = ?").all(runID) as Array<{ node_id: string; value_json: string }>
    const runtime = new Map(runtimeRows.map((row) => [row.node_id, parse<NonNullable<DagNodeRecord["runtime"]>>(row.value_json)]))
    const recoveryRows = this.db.query("SELECT node_id, value_json FROM dag_node_recovery WHERE run_id = ?").all(runID) as Array<{ node_id: string; value_json: string }>
    const recovery = new Map(recoveryRows.map((row) => [row.node_id, parse<NonNullable<DagNodeRecord["recovery"]>>(row.value_json)]))
    const authorization = this.db.query("SELECT plan, atlas_nodes_json FROM dag_authorizations WHERE run_id = ?").get(runID) as { plan: string; atlas_nodes_json: string } | null
    return {
      runID: row.run_id, ownerSessionID: row.owner_session_id, name: row.name,
      ...(authorization ? { authorizedPlan: authorization.plan, authorizedAtlasNodes: parse<Record<string, string>>(authorization.atlas_nodes_json) } : {}),
      definition, fingerprint: row.fingerprint,
      generation: row.generation, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      nodes: nodeRows.map((node) => ({
        definition: parse<DagNodeRecord["definition"]>(node.node_json), fingerprint: node.fingerprint,
        status: node.status, attempt: node.attempt,
        ...(runtime.has(node.node_id) ? { runtime: runtime.get(node.node_id)! } : {}),
        ...(recovery.has(node.node_id) ? { recovery: recovery.get(node.node_id)! } : {}),
        ...(node.result_json ? { result: parse<NonNullable<DagNodeRecord["result"]>>(node.result_json) } : {}),
        ...(node.error ? { error: node.error } : {}),
        ...(node.execution_json ? { execution: parse<NonNullable<DagNodeRecord["execution"]>>(node.execution_json) } : {}),
        createdAt: node.created_at, updatedAt: node.updated_at,
      })),
    }
  }

  listRuns(ownerSessionID?: string): readonly DagRunRecord[] {
    const rows = ownerSessionID === undefined
      ? this.db.query("SELECT run_id FROM dag_runs WHERE project = ? ORDER BY updated_at DESC").all(this.project) as Array<{ run_id: string }>
      : this.db.query("SELECT run_id FROM dag_runs WHERE project = ? AND owner_session_id = ? ORDER BY updated_at DESC").all(this.project, ownerSessionID) as Array<{ run_id: string }>
    return rows.map((row) => this.getRun(row.run_id)).filter((run): run is DagRunRecord => run !== undefined)
  }

  recovery(runID: string, nodeID: string): DagNodeRecord["recovery"] {
    if (!this.owns(runID)) return undefined
    const row = this.db.query("SELECT value_json FROM dag_node_recovery WHERE run_id = ? AND node_id = ?").get(runID, nodeID) as { value_json: string } | null
    return row ? parse<NonNullable<DagNodeRecord["recovery"]>>(row.value_json) : undefined
  }

  steering(runID: string): readonly DagSteerRequest[] {
    if (!this.owns(runID)) return []
    const rows = this.db.query("SELECT value_json FROM dag_steering WHERE run_id = ? ORDER BY rowid").all(runID) as Array<{ value_json: string }>
    return rows.map((row) => parse<DagSteerRequest>(row.value_json))
  }

  saveSteering(request: DagSteerRequest): void {
    if (!this.owns(request.runID)) throw new Error("Unknown DAG run in this project")
    this.db.run("INSERT INTO dag_steering VALUES (?, ?, ?) ON CONFLICT(run_id, request_id) DO UPDATE SET value_json = excluded.value_json", [request.runID, request.requestID, canonicalJson(request)])
  }

  notices(runID?: string): readonly DagNotice[] {
    const rows = this.db.query(`SELECT n.value_json FROM dag_notices n JOIN dag_runs r ON r.run_id = n.run_id
      WHERE r.project = ? AND (? IS NULL OR n.run_id = ?) ORDER BY n.rowid`).all(this.project, runID ?? null, runID ?? null) as Array<{ value_json: string }>
    return rows.map((row) => parse<DagNotice>(row.value_json))
  }

  saveNotice(notice: DagNotice): void {
    if (!this.owns(notice.runID)) throw new Error("Unknown DAG run in this project")
    this.db.run("INSERT INTO dag_notices VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET value_json = excluded.value_json", [notice.eventID, notice.runID, canonicalJson(notice)])
    if (notice.state === "admitted") this.db.run("UPDATE dag_events SET delivered_at = ? WHERE event_id = ? AND run_id = ?", [Date.now(), notice.eventID, notice.runID])
  }

  /** The observed-run node whose child is this session, newest first. */
  observedNode(sessionID: string): { readonly runID: string; readonly nodeID: string; readonly ownerSessionID: string } | undefined {
    const row = this.db.query(`SELECT n.run_id, n.node_id, r.owner_session_id FROM dag_nodes n JOIN dag_runs r ON r.run_id = n.run_id
      WHERE r.project = ? AND json_extract(r.definition_json, '$.observed') = 1 AND json_extract(n.execution_json, '$.sessionID') = ?
      ORDER BY n.updated_at DESC LIMIT 1`).get(this.project, sessionID) as { run_id: string; node_id: string; owner_session_id: string } | null
    return row ? { runID: row.run_id, nodeID: row.node_id, ownerSessionID: row.owner_session_id } : undefined
  }

  appendAction(action: Omit<DagAction, "actionID">): boolean {
    if (!this.owns(action.runID)) return false
    const result = this.db.run("INSERT OR IGNORE INTO dag_actions VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), action.runID, action.nodeID ?? null, action.kind, action.idempotencyKey, action.payload === undefined ? null : canonicalJson(action.payload), action.createdAt])
    return result.changes > 0
  }

  appendEvent(event: Omit<DagEvent, "eventID" | "sequence">): DagEvent {
    if (!this.owns(event.runID)) throw new Error("Unknown DAG run in this project")
    const row = this.db.query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM dag_events WHERE run_id = ?").get(event.runID) as { sequence: number }
    const full = { ...event, eventID: randomUUID(), sequence: row.sequence + 1 }
    this.db.run("INSERT INTO dag_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)", [full.eventID, full.runID, full.sequence, full.type, full.nodeID ?? null, full.generation, full.payload === undefined ? null : canonicalJson(full.payload), full.createdAt])
    return full
  }

  events(runID: string, after = 0): readonly DagEvent[] {
    if (!this.owns(runID)) return []
    const rows = this.db.query("SELECT * FROM dag_events WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(runID, after) as Array<{ event_id: string; run_id: string; sequence: number; event_type: DagEvent["type"]; node_id: string | null; generation: number; payload_json: string | null; created_at: number }>
    return rows.map((row) => ({ schemaVersion: 1, eventID: row.event_id, runID: row.run_id, sequence: row.sequence, type: row.event_type, generation: row.generation, createdAt: row.created_at, ...(row.node_id ? { nodeID: row.node_id } : {}), ...(row.payload_json ? { payload: parse<JsonValue>(row.payload_json) } : {}) }))
  }

  /** Every run read or write is limited to this store's project. */
  private owns(runID: string): boolean {
    return this.db.query("SELECT 1 FROM dag_runs WHERE run_id = ? AND project = ?").get(runID, this.project) !== null
  }

  private writeNode(runID: string, node: DagNodeRecord): void {
    if (node.recovery) this.db.run("INSERT INTO dag_node_recovery VALUES (?, ?, ?) ON CONFLICT(run_id, node_id) DO UPDATE SET value_json = excluded.value_json", [runID, node.definition.id, canonicalJson(node.recovery)])
    if (node.runtime) this.db.run("INSERT INTO dag_node_runtime VALUES (?, ?, ?)", [runID, node.definition.id, canonicalJson(node.runtime)])
    this.db.run("INSERT INTO dag_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [runID, node.definition.id, canonicalJson(node.definition), node.fingerprint, node.status, node.attempt, node.result ? canonicalJson(node.result) : null, node.error ?? null, node.execution ? canonicalJson(node.execution) : null, node.createdAt ?? Date.now(), node.updatedAt ?? Date.now()])
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE")
    try { fn(); this.db.exec("COMMIT") } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
}
