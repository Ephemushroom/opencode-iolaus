import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SessionStateStore } from "../src/database"
import { setGoal, updateGoal } from "../src/roles/goal"
import { createStateSync, sessionState, STATE_ENTRY_KEY } from "../src/session-state"
import type { DagRunRecord } from "../src/dag/types"

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const run = (status: string, observed = false) => ({ runID: `r-${status}`, ownerSessionID: "s", name: `run ${status}`, fingerprint: "f", generation: 1, createdAt: 0, updatedAt: 0,
  status, definition: { schemaVersion: 1, name: "x", nodes: [], ...(observed ? { observed: true } : {}), ...(status === "paused" ? { directory: "/repo-wt/cache" } : {}) },
  nodes: [{ definition: { id: "a", prompt: "", dependsOn: [] }, fingerprint: "", status: "completed", attempt: 1 }, { definition: { id: "accept", kind: "gate", prompt: "", dependsOn: [] }, fingerprint: "", status: "waiting_approval", attempt: 1 }] }) as never as DagRunRecord

test("session state keeps the goal, role and unfinished runs, and nothing when there is none", () => {
  const text = sessionState({ sessionID: "s", objective: "Ship the cache", status: "active", continuations: 2, stagnant: 0, createdAt: 0, updatedAt: 0 }, { role: "orchestrator", plan: "cache", runID: "r-paused" }, [run("paused"), run("completed"), run("running", true)])!
  expect(text).toContain("Session goal (active): Ship the cache")
  expect(text).toContain('Session role: orchestrator for plan "cache" (run r-paused)')
  expect(text).toContain('DAG run r-paused "run paused" is paused in /repo-wt/cache; open nodes: accept=waiting_approval (the user decides)')
  expect(text).not.toContain("r-completed")
  expect(text).not.toContain("r-running")
  expect(sessionState(null, undefined, [run("completed")])).toBeUndefined()
})

test("state sync puts the entry while there is state, removes it when there is none, and follows store saves", async () => {
  const directory = mkdtempSync(join(tmpdir(), "iolaus-state-"))
  directories.push(directory)
  const state = new SessionStateStore(join(directory, "iolaus.db"))
  const calls: Array<{ op: string; sessionID: string; key: string; value?: unknown }> = []
  let runs: DagRunRecord[] = []
  const instructions = { entry: {
    put: (input: { sessionID: string; key: string; value: unknown }) => Effect.sync(() => { calls.push({ op: "put", ...input }) }),
    remove: (input: { sessionID: string; key: string }) => Effect.sync(() => { calls.push({ op: "remove", ...input }) }),
  } } as never
  const controller = { list: () => Effect.sync(() => runs) } as never
  const sync = createStateSync(instructions, { controller, state, trace: () => undefined })

  await Effect.runPromise(sync.refresh("s"))
  expect(calls).toEqual([{ op: "remove", sessionID: "s", key: STATE_ENTRY_KEY }])

  runs = [run("paused")]
  await Effect.runPromise(sync.refresh("s"))
  expect(calls[1]).toMatchObject({ op: "put", sessionID: "s", key: STATE_ENTRY_KEY })
  expect(String(calls[1]!.value)).toContain("r-paused")

  // A goal change reaches the entry through the store, with no caller wiring.
  runs = []
  const settled = new Promise<void>((resolve) => { state.onSave = (sessionID) => { Effect.runPromise(sync.refresh(sessionID)).then(resolve) } })
  setGoal(state, "s", "Ship the cache")
  await settled
  expect(calls[2]).toMatchObject({ op: "put", value: expect.stringContaining("Session goal (active): Ship the cache") })

  const cleared = new Promise<void>((resolve) => { state.onSave = (sessionID) => { Effect.runPromise(sync.refresh(sessionID)).then(resolve) } })
  updateGoal(state, "s", "complete")
  await cleared
  expect(calls[3]).toEqual({ op: "remove", sessionID: "s", key: STATE_ENTRY_KEY })
  state.close()
})

test("a failing host call is traced, not raised", async () => {
  const traces: string[] = []
  const instructions = { entry: { put: () => Effect.fail("too large"), remove: () => Effect.void } } as never
  const sync = createStateSync(instructions, { controller: { list: () => Effect.succeed([run("paused")]) } as never, state: { read: () => undefined } as never, trace: (event) => traces.push(event) })
  await Effect.runPromise(sync.refresh("s"))
  expect(traces).toEqual(["iolaus.state.failed"])
})
