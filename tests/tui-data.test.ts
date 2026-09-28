import { expect, test } from "bun:test"
import { createDagQuery, dagTarget, matchesDagEvent, type DagState } from "../src/tui/data"
import type { DagView } from "../src/dag/rpc"

const a = { sessionID: "session-a", directory: "/project-a" }
const b = { sessionID: "session-b", directory: "/project-b" }
const view = (name: string): DagView => ({ runs: [{ runID: name, name, generation: 1, status: "running", createdAt: 1, updatedAt: 1, nodes: [] }] })

test("the viewed session location wins over plugin and server defaults without changing ownership", () => {
  const context = { location: { directory: "/plugin" }, data: {
    session: { get: (id: string) => id === "child" ? { location: { directory: "/child-project" } } : undefined },
    location: { default: () => ({ directory: "/server-default" }) },
  } }
  expect(dagTarget(context, "child")).toEqual({ sessionID: "child", directory: "/child-project" })
  expect(dagTarget(context, "unknown")).toEqual({ sessionID: "unknown", directory: "/plugin" })
  expect(dagTarget({ data: context.data }, "unknown")).toEqual({ sessionID: "unknown", directory: "/server-default" })
})

test("snapshot routes explicitly to each project's controller", async () => {
  const calls: unknown[] = []
  const states: DagState[] = []
  const query = createDagQuery(async (input, options) => {
    calls.push({ input, options })
    return view(options.location.directory)
  }, (state) => states.push(state))
  await query.refresh(a)
  await query.refresh(b)
  expect(calls).toEqual([
    { input: { sessionID: a.sessionID }, options: { location: { directory: a.directory } } },
    { input: { sessionID: b.sessionID }, options: { location: { directory: b.directory } } },
  ])
  expect(states.map((state) => state.status)).toEqual(["loading", "ready", "loading", "ready"])
  expect(states.at(-1)?.runs[0].name).toBe(b.directory)
})

test("a late reply cannot replace the newly selected session", async () => {
  const first = Promise.withResolvers<DagView>()
  const states: DagState[] = []
  const query = createDagQuery((input) => input.sessionID === a.sessionID ? first.promise : Promise.resolve(view("B")), (state) => states.push(state))
  const pending = query.refresh(a)
  await query.refresh(b)
  first.resolve(view("A"))
  await pending
  expect(states.at(-1)?.runs[0].name).toBe("B")
  expect(states.filter((state) => state.status === "ready")).toHaveLength(1)
})

test("late errors, superseded refreshes and disposed slots cannot publish stale state", async () => {
  const first = Promise.withResolvers<DagView>()
  const second = Promise.withResolvers<DagView>()
  const states: DagState[] = []
  let count = 0
  const query = createDagQuery(() => ++count === 1 ? first.promise : second.promise, (state) => states.push(state))
  const one = query.refresh(a)
  const two = query.refresh(a)
  second.resolve(view("latest"))
  await two
  first.reject(new Error("old failure"))
  await one
  expect(states.at(-1)?.runs[0].name).toBe("latest")
  const pending = Promise.withResolvers<DagView>()
  const disposed = createDagQuery(() => pending.promise, (state) => states.push(state))
  const three = disposed.refresh(b)
  const before = states.length
  disposed.dispose()
  pending.resolve(view("disposed"))
  await three
  expect(states).toHaveLength(before)
})

test("RPC failure is distinct from loaded-empty and a subsequent event can recover", async () => {
  const states: DagState[] = []
  let fail = true
  const query = createDagQuery(async () => {
    if (fail) throw new Error("RPC unavailable")
    return { runs: [] }
  }, (state) => states.push(state))
  await query.refresh(a)
  expect(states.at(-1)).toEqual({ status: "error", runs: [], error: "RPC unavailable" })
  fail = false
  await query.refresh(a)
  expect(states.at(-1)).toEqual({ status: "ready", runs: [] })
})

test("RPC event filtering reads the payload owner and matches the project location", () => {
  const event = { type: "rpc.iolaus-dag.updated", data: { sessionID: a.sessionID, type: "node.waiting" }, location: { directory: a.directory } }
  expect(matchesDagEvent(a, event)).toBe(true)
  expect(matchesDagEvent(b, event)).toBe(false)
  expect(matchesDagEvent(a, { ...event, location: { directory: b.directory } })).toBe(false)
  expect(matchesDagEvent(a, { ...event, data: { sessionID: "other" } })).toBe(false)
})
