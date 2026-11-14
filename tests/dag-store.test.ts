import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { Context, Effect, Fiber, Scheduler } from "effect"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DagStore } from "../src/dag/store"
import { createKeyedLock } from "../src/keyed-lock"
import type { DagNodeRecord, DagRunRecord } from "../src/dag/types"

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

const record = (id: string, extra: Partial<DagNodeRecord> = {}): DagNodeRecord =>
  ({ definition: { id, agent: "quick", model: "o/m", prompt: id, dependsOn: [] }, fingerprint: id, status: "pending", attempt: 0, createdAt: 1, updatedAt: 1, ...extra })
const runOf = (runID: string, owner: string, nodes: readonly DagNodeRecord[], extra: Partial<DagRunRecord> = {}): DagRunRecord =>
  ({ runID, ownerSessionID: owner, name: runID, definition: { schemaVersion: 1, name: runID, nodes: nodes.map((node) => node.definition) }, fingerprint: "f", generation: 1, status: "running", nodes, createdAt: 1, updatedAt: 1, ...extra })

test("a save rewrites only the records that changed while the database is as this connection left it", () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-store-"))
  const path = join(directory, "iolaus.db")
  const store = new DagStore(path, directory)
  store.createRun(runOf("r", "owner", [record("a"), record("b"), record("c")]))
  // Another connection logs every node row the store writes.
  const raw = new Database(path)
  raw.exec(`CREATE TABLE write_log (node_id TEXT);
    CREATE TRIGGER log_insert AFTER INSERT ON dag_nodes BEGIN INSERT INTO write_log VALUES (NEW.node_id); END;
    CREATE TRIGGER log_update AFTER UPDATE ON dag_nodes BEGIN INSERT INTO write_log VALUES (NEW.node_id); END;`)
  const written = () => (raw.query("SELECT node_id FROM write_log ORDER BY rowid").all() as Array<{ node_id: string }>).map((row) => row.node_id)
  const stored = () => store.getRun("r")!.nodes.map((node) => [node.definition.id, node.status])

  const seen = store.getRun("r")!
  const a: DagNodeRecord = { ...seen.nodes[0]!, status: "completed" }
  const first = { ...seen, nodes: [a, seen.nodes[1]!, seen.nodes[2]!] }
  store.saveRun(first)
  expect(written()).toEqual(["a"])
  // A read in between returns new objects for the same rows; a record derived from the earlier read still skips them.
  store.getRun("r")
  const paused: DagRunRecord = { ...first, status: "paused" }
  store.saveRun(paused, [{ schemaVersion: 1, runID: "r", generation: 1, type: "run.paused", createdAt: 2 }])
  expect(written()).toEqual(["a"])
  expect(store.getRun("r")!.status).toBe("paused")

  const d = record("d")
  const grown = { ...paused, definition: { ...first.definition, nodes: [a.definition, seen.nodes[1]!.definition, d.definition] }, nodes: [a, seen.nodes[1]!, d] }
  store.saveRun(grown)
  expect(written()).toEqual(["a", "d"])
  expect(stored()).toEqual([["a", "completed"], ["b", "pending"], ["d", "pending"]])

  // Once another connection has written, the record is saved whole: never this writer's header over that writer's rows.
  raw.exec("UPDATE dag_nodes SET status = 'completed' WHERE node_id = 'b'")
  store.saveRun({ ...grown, generation: 2 })
  expect(written().slice(3).sort()).toEqual(["a", "b", "d"])
  expect(stored()).toEqual([["a", "completed"], ["b", "pending"], ["d", "pending"]])
  raw.close(); store.close()
})

test("a stale snapshot cannot roll back a newer generation or append events", () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-store-"))
  const store = new DagStore(join(directory, "iolaus.db"), directory)
  store.createRun(runOf("r", "owner", [record("a")], { fingerprint: "f1" }))
  const old = store.getRun("r")!
  const b = record("b")
  store.saveRun({ ...old, definition: { ...old.definition, nodes: [b.definition] }, fingerprint: "f2", generation: 2, nodes: [b] })
  expect(store.getRun("r")!.nodes.map((node) => node.definition.id)).toEqual(["b"])

  const before = store.getRun("r")!
  expect(() => store.saveRun(old, [{ schemaVersion: 1, runID: "r", generation: 1, type: "run.paused", createdAt: 3 }])).toThrow("Stale DAG run")
  const back = store.getRun("r")!
  expect(back).toEqual(before)
  expect([back.generation, back.fingerprint, back.definition.nodes.map((node) => node.id), back.nodes.map((node) => node.definition.id)]).toEqual([2, "f2", ["b"], ["b"]])
  expect(store.events("r")).toEqual([])
  store.close()
})

test.each([false, true])("same-generation stale saves are rejected with a second connection: %s", (separate) => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-store-"))
  const path = join(directory, "iolaus.db")
  const store = new DagStore(path, directory)
  const other = separate ? new DagStore(path, directory) : store
  store.createRun(runOf("r", "owner", [record("a")]))
  store.createRun(runOf("unrelated", "owner", [record("b")]))
  const stale = other.getRun("r")!
  const latest = store.getRun("r")!
  const updated: DagRunRecord = { ...latest, status: "paused", nodes: [{ ...latest.nodes[0]!, status: "completed" }] }
  store.saveRun(updated)
  const before = store.getRun("r")!
  const request = { runID: "r", nodeID: "a", requestID: "supplement", text: "keep this", execution: { nodeID: "a", attempt: 1, sessionID: "child" }, generation: 1, revision: 1, messageID: "msg_1", state: "delivered", createdAt: 2 } as const
  store.saveSteering(request)
  expect(() => other.saveRun({ ...stale, status: "failed" }, [{ schemaVersion: 1, runID: "r", generation: 1, type: "run.failed", createdAt: 2 }], [{ ...request, state: "unresolved" }], true)).toThrow("Stale DAG run")
  expect(store.getRun("r")).toEqual(before)
  expect(store.events("r")).toEqual([])
  expect(store.notices("r")).toEqual([])
  expect(store.steering("r")).toEqual([request])

  const fresh = other.getRun("r")!
  store.saveRun({ ...store.getRun("unrelated")!, status: "paused" })
  other.saveRun(fresh)
  other.saveRun(fresh, [{ schemaVersion: 1, runID: "r", generation: 1, type: "run.paused", createdAt: 3 }])
  other.saveRun({ ...fresh, status: "running" })
  expect(store.getRun("r")!.status).toBe("running")
  expect(store.events("r")).toHaveLength(1)
  if (separate) other.close()
  store.close()
})

test("a failed transaction rolls back its revision, nodes, header and side effects", () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-store-"))
  const path = join(directory, "iolaus.db")
  const store = new DagStore(path, directory)
  const original = runOf("r", "owner", [record("a")])
  store.createRun(original)
  const before = store.getRun("r")!
  const updated: DagRunRecord = { ...before, status: "failed", nodes: [{ ...before.nodes[0]!, status: "failed" }] }
  const raw = new Database(path)
  raw.exec("CREATE TRIGGER reject_notice AFTER INSERT ON dag_notices BEGIN SELECT RAISE(ABORT, 'notice refused'); END")
  const event = { schemaVersion: 1, runID: "r", generation: 1, type: "run.failed", createdAt: 2 } as const
  expect(() => store.saveRun(updated, [event], [], true)).toThrow("notice refused")
  expect(store.getRun("r")).toEqual(before)
  expect(store.events("r")).toEqual([])
  expect(store.notices("r")).toEqual([])
  expect(raw.query("SELECT * FROM dag_actions").all()).toEqual([])
  raw.exec("DROP TRIGGER reject_notice")
  store.saveRun(updated, [event], [], true)
  expect(store.getRun("r")!.nodes[0]!.status).toBe("failed")
  expect(store.events("r")).toHaveLength(1)
  expect(store.notices("r")).toHaveLength(1)
  raw.close(); store.close()
})

test("legacy databases gain revisions without changing positional run inserts", () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-store-"))
  const path = join(directory, "iolaus.db")
  const raw = new Database(path)
  raw.exec(`CREATE TABLE dag_runs (
    run_id TEXT PRIMARY KEY, project TEXT NOT NULL, owner_session_id TEXT NOT NULL, name TEXT NOT NULL,
    definition_json TEXT NOT NULL, fingerprint TEXT NOT NULL, generation INTEGER NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`)
  const definition = JSON.stringify({ schemaVersion: 1, name: "legacy", nodes: [] })
  raw.run("INSERT INTO dag_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["legacy", realpathSync(directory), "owner", "legacy", definition, "f", 1, "running", 1, 1])
  const store = new DagStore(path, directory)
  const old = store.getRun("legacy")!
  store.saveRun({ ...old, status: "paused" })
  expect(() => store.saveRun(old)).toThrow("Stale DAG run")
  raw.exec("INSERT INTO dag_runs SELECT 'copied',project,owner_session_id,name,definition_json,fingerprint,generation,status,created_at,updated_at FROM dag_runs WHERE run_id='legacy'")
  store.saveRun({ ...store.getRun("copied")!, status: "running" })
  expect(store.getRun("copied")!.status).toBe("running")
  raw.close(); store.close()
})

test("runs are listed open-only or newest-first up to a limit, and a batch or notice is found without reading the rest", () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-store-"))
  const store = new DagStore(join(directory, "iolaus.db"), directory)
  store.createRun(runOf("done", "o", [record("a", { status: "completed" })], { status: "completed", updatedAt: 1 }))
  store.createRun(runOf("live", "o", [record("a")], { updatedAt: 2 }))
  store.createRun(runOf("held", "o", [record("a", { status: "waiting_approval" })], { status: "paused", updatedAt: 3 }))
  store.createRun(runOf("theirs", "x", [record("a")], { updatedAt: 4 }))
  const batch = runOf("calls", "o", [record("1-scan", { status: "completed" })], { status: "completed", updatedAt: 5 })
  store.createRun({ ...batch, definition: { ...batch.definition, observed: true, observedBatch: { kind: "request", id: "msg_1" } } })
  const ids = (runs: readonly DagRunRecord[]) => runs.map((run) => run.runID)
  expect(ids(store.listRuns("o"))).toEqual(["calls", "held", "live", "done"])
  expect(ids(store.listRuns("o", { open: true }))).toEqual(["held", "live"])
  expect(ids(store.listRuns("o", { limit: 2 }))).toEqual(["calls", "held"])
  expect(ids(store.listRuns(undefined, { open: true }))).toEqual(["theirs", "held", "live"])
  expect(store.observedRun("o", { kind: "request", id: "msg_1" })?.runID).toBe("calls")
  expect(store.observedRun("x", { kind: "request", id: "msg_1" })).toBeUndefined()
  expect(store.observedRun("o", { kind: "flow", id: "msg_1" })).toBeUndefined()

  const notice = (eventID: string, state: "pending" | "admitted") => ({ eventID, runID: "live", ownerSessionID: "o", messageID: `msg_${eventID}`, text: eventID, state })
  store.saveNotice(notice("e1", "admitted")); store.saveNotice(notice("e2", "pending"))
  expect(store.notice("e2")?.state).toBe("pending")
  expect(store.notice("nope")).toBeUndefined()
  expect(store.undeliveredNotices().map((value) => value.eventID)).toEqual(["e2"])
  store.close()
})

test("a keyed lock serializes one key, lets other keys run, and keeps no key once nothing uses it", async () => {
  const locks = createKeyedLock()
  const order: string[] = []
  const task = (name: string, ms: number) => locks.withLock("run", Effect.promise(async () => {
    order.push(`${name}:start`); await new Promise((done) => setTimeout(done, ms)); order.push(`${name}:end`)
  }))
  await Promise.all([Effect.runPromise(task("a", 15)), Effect.runPromise(task("b", 1)), Effect.runPromise(locks.withLock("other", Effect.sync(() => { order.push("other") })))])
  expect(order.filter((entry) => entry !== "other")).toEqual(["a:start", "a:end", "b:start", "b:end"])
  expect(order.indexOf("other")).toBeLessThan(order.indexOf("a:end"))
  expect(locks.size()).toBe(0)
  await Effect.runPromise(Effect.exit(locks.withLock("run", Effect.fail("boom"))))
  expect(locks.size()).toBe(0)
})

test("a keyed lock drops its key when the caller is interrupted the moment it has registered", async () => {
  const locks = createKeyedLock()
  // Yield once, right after the key exists, so the interrupt lands between registering and running the task.
  const base = new Scheduler.MixedScheduler()
  let yielded = false
  const once: Scheduler.Scheduler = { executionMode: base.executionMode, makeDispatcher: () => base.makeDispatcher(),
    shouldYield: () => { if (yielded || locks.size() !== 1) return false; yielded = true; return true } }
  const fiber = Effect.runForkWith(Context.make(Scheduler.Scheduler, once))(locks.withLock("run", Effect.never))
  expect([yielded, locks.size()]).toEqual([true, 1])
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(locks.size()).toBe(0)
})
