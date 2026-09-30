import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { canonicalProject, databasePath, openDatabase } from "../database"
import { canonicalJson } from "./canonical-json"
import type { DagAction, DagDefinition, DagEvent, DagNodeRecord, DagRunRecord, JsonValue } from "./types"

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

  saveRun(run: DagRunRecord, events: readonly Omit<DagEvent, "eventID" | "sequence">[] = []): readonly DagEvent[] {
    if (!this.owns(run.runID)) throw new Error("Unknown DAG run in this project")
    const committed: DagEvent[] = []
    this.transaction(() => {
      this.db.run("UPDATE dag_runs SET definition_json = ?, fingerprint = ?, generation = ?, status = ?, updated_at = ? WHERE run_id = ? AND project = ?", [canonicalJson(run.definition), run.fingerprint, run.generation, run.status, run.updatedAt, run.runID, this.project])
      this.db.run("DELETE FROM dag_nodes WHERE run_id = ?", [run.runID])
      for (const node of run.nodes) this.writeNode(run.runID, node)
      for (const event of events) {
        const entry = this.appendEvent(event)
        this.appendAction({ runID: run.runID, nodeID: event.nodeID, kind: event.type,
          idempotencyKey: entry.eventID, payload: event.payload, createdAt: event.createdAt })
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
    const authorization = this.db.query("SELECT plan, atlas_nodes_json FROM dag_authorizations WHERE run_id = ?").get(runID) as { plan: string; atlas_nodes_json: string } | null
    return {
      runID: row.run_id, ownerSessionID: row.owner_session_id, name: row.name,
      ...(authorization ? { authorizedPlan: authorization.plan, authorizedAtlasNodes: parse<Record<string, string>>(authorization.atlas_nodes_json) } : {}),
      definition: parse<DagDefinition>(row.definition_json), fingerprint: row.fingerprint,
      generation: row.generation, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      nodes: nodeRows.map((node) => ({
        definition: parse<DagNodeRecord["definition"]>(node.node_json), fingerprint: node.fingerprint,
        status: node.status, attempt: node.attempt,
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
    this.db.run("INSERT INTO dag_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [runID, node.definition.id, canonicalJson(node.definition), node.fingerprint, node.status, node.attempt, node.result ? canonicalJson(node.result) : null, node.error ?? null, node.execution ? canonicalJson(node.execution) : null, node.createdAt ?? Date.now(), node.updatedAt ?? Date.now()])
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE")
    try { fn(); this.db.exec("COMMIT") } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
}
