import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { canonicalJson } from "./canonical-json"
import type { DagAction, DagDefinition, DagEvent, DagNodeRecord, DagRunRecord, JsonValue } from "./types"

type RunRow = { run_id: string; owner_session_id: string; name: string; definition_json: string; fingerprint: string; generation: number; status: DagRunRecord["status"]; created_at: number; updated_at: number }
type NodeRow = { run_id: string; node_id: string; node_json: string; fingerprint: string; status: DagNodeRecord["status"]; attempt: number; result_json: string | null; error: string | null; execution_json: string | null; created_at: number; updated_at: number }

function parse<T>(value: string): T {
  return JSON.parse(value) as T
}

export function resolveDagDatabasePath(directory: string): string {
  return process.env.IOLAUS_DAG_DB ?? join(directory, ".iolaus", "dag", "state.db")
}

export class DagStore {
  readonly path: string
  private readonly db: Database

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dag_runs (
        run_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, name TEXT NOT NULL,
        definition_json TEXT NOT NULL, fingerprint TEXT NOT NULL, generation INTEGER NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dag_nodes (
        run_id TEXT NOT NULL, node_id TEXT NOT NULL, node_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL,
        result_json TEXT, error TEXT, execution_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, node_id), FOREIGN KEY (run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS dag_actions (
        action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT,
        kind TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_json TEXT,
        created_at INTEGER NOT NULL, UNIQUE(run_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS dag_events (
        event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL, node_id TEXT, generation INTEGER NOT NULL,
        payload_json TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER,
        UNIQUE(run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS dag_nodes_status ON dag_nodes(run_id, status);
      CREATE INDEX IF NOT EXISTS dag_events_run ON dag_events(run_id, sequence);
    `)
  }

  close(): void { this.db.close() }

  createRun(run: DagRunRecord): void {
    this.transaction(() => {
      this.db.run("INSERT INTO dag_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [run.runID, run.ownerSessionID, run.name, canonicalJson(run.definition), run.fingerprint, run.generation, run.status, run.createdAt, run.updatedAt])
      for (const node of run.nodes) this.writeNode(run.runID, node)
    })
  }

  saveRun(run: DagRunRecord, events: readonly Omit<DagEvent, "eventID" | "sequence">[] = []): readonly DagEvent[] {
    const committed: DagEvent[] = []
    this.transaction(() => {
      this.db.run("UPDATE dag_runs SET definition_json = ?, fingerprint = ?, generation = ?, status = ?, updated_at = ? WHERE run_id = ?", [canonicalJson(run.definition), run.fingerprint, run.generation, run.status, run.updatedAt, run.runID])
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

  getRun(runID: string): DagRunRecord | undefined {
    const row = this.db.query("SELECT * FROM dag_runs WHERE run_id = ?").get(runID) as RunRow | null
    if (!row) return undefined
    const nodeRows = this.db.query("SELECT * FROM dag_nodes WHERE run_id = ? ORDER BY node_id").all(runID) as NodeRow[]
    return {
      runID: row.run_id, ownerSessionID: row.owner_session_id, name: row.name,
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
      ? this.db.query("SELECT run_id FROM dag_runs ORDER BY updated_at DESC").all() as Array<{ run_id: string }>
      : this.db.query("SELECT run_id FROM dag_runs WHERE owner_session_id = ? ORDER BY updated_at DESC").all(ownerSessionID) as Array<{ run_id: string }>
    return rows.map((row) => this.getRun(row.run_id)).filter((run): run is DagRunRecord => run !== undefined)
  }

  appendAction(action: Omit<DagAction, "actionID">): boolean {
    const result = this.db.run("INSERT OR IGNORE INTO dag_actions VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), action.runID, action.nodeID ?? null, action.kind, action.idempotencyKey, action.payload === undefined ? null : canonicalJson(action.payload), action.createdAt])
    return result.changes > 0
  }

  appendEvent(event: Omit<DagEvent, "eventID" | "sequence">): DagEvent {
    const row = this.db.query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM dag_events WHERE run_id = ?").get(event.runID) as { sequence: number }
    const full = { ...event, eventID: randomUUID(), sequence: row.sequence + 1 }
    this.db.run("INSERT INTO dag_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)", [full.eventID, full.runID, full.sequence, full.type, full.nodeID ?? null, full.generation, full.payload === undefined ? null : canonicalJson(full.payload), full.createdAt])
    return full
  }

  events(runID: string, after = 0): readonly DagEvent[] {
    const rows = this.db.query("SELECT * FROM dag_events WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(runID, after) as Array<{ event_id: string; run_id: string; sequence: number; event_type: DagEvent["type"]; node_id: string | null; generation: number; payload_json: string | null; created_at: number }>
    return rows.map((row) => ({ schemaVersion: 1, eventID: row.event_id, runID: row.run_id, sequence: row.sequence, type: row.event_type, generation: row.generation, createdAt: row.created_at, ...(row.node_id ? { nodeID: row.node_id } : {}), ...(row.payload_json ? { payload: parse<JsonValue>(row.payload_json) } : {}) }))
  }

  private writeNode(runID: string, node: DagNodeRecord): void {
    this.db.run("INSERT INTO dag_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [runID, node.definition.id, canonicalJson(node.definition), node.fingerprint, node.status, node.attempt, node.result ? canonicalJson(node.result) : null, node.error ?? null, node.execution ? canonicalJson(node.execution) : null, node.createdAt ?? Date.now(), node.updatedAt ?? Date.now()])
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE")
    try { fn(); this.db.exec("COMMIT") } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
}
