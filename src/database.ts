import { mkdirSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { resolveHome } from "./home"

export function databasePath(project: string): string {
  return resolveHome(project).database
}

export function canonicalProject(directory: string): string {
  const path = resolve(directory)
  try { return realpathSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path
    throw error
  }
}

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;")
  db.exec(`
    CREATE TABLE IF NOT EXISTS dag_runs (
      run_id TEXT PRIMARY KEY, project TEXT NOT NULL, owner_session_id TEXT NOT NULL, name TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS dag_authorizations (
      run_id TEXT PRIMARY KEY REFERENCES dag_runs(run_id) ON DELETE CASCADE,
      plan TEXT NOT NULL, atlas_nodes_json TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS session_state (
      session_id TEXT NOT NULL, kind TEXT NOT NULL, value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, kind)
    );
    CREATE INDEX IF NOT EXISTS dag_runs_project_owner ON dag_runs(project, owner_session_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS dag_nodes_status ON dag_nodes(run_id, status);
    CREATE INDEX IF NOT EXISTS dag_events_run ON dag_events(run_id, sequence);
  `)
  return db
}

export class SessionStateStore {
  private readonly db: Database
  constructor(path: string) { this.db = openDatabase(path) }
  read(kind: "role" | "goal", sessionID: string): unknown {
    const row = this.db.query("SELECT value_json FROM session_state WHERE session_id = ? AND kind = ?").get(sessionID, kind) as { value_json: string } | null
    if (!row) return undefined
    try { return JSON.parse(row.value_json) as unknown } catch { return undefined }
  }
  save(kind: "role" | "goal", sessionID: string, value: unknown): void {
    this.db.run("INSERT INTO session_state VALUES (?, ?, ?, ?) ON CONFLICT(session_id, kind) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at", [sessionID, kind, JSON.stringify(value), Date.now()])
  }
  close(): void { this.db.close() }
}
