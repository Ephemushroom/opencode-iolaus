import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type * as Solid from "solid-js"
import type * as Presence from "../src/tui/presence"
import { adjust, createSlotPresence } from "../src/tui/presence"

// `bun test` resolves solid-js to its server build, where createEffect is a no-op. The reactive tracker below is loaded
// once more against the client build so its rebinding really runs; the counting tests use the ordinary import.
const client = fileURLToPath(import.meta.resolve("solid-js")).replace(/[\\/]dist[\\/]server\.js$/, "/dist/solid.js")
const source = fileURLToPath(new URL("../src/tui/presence.ts", import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), "iolaus-presence-"))
afterAll(() => rmSync(temporary, { recursive: true, force: true }))
const rewritten = join(temporary, "presence.ts")
writeFileSync(rewritten, (await Bun.file(source).text()).replaceAll('"solid-js"', JSON.stringify(client)))
const solid = (await import(client)) as typeof Solid
const live = (await import(rewritten)) as typeof Presence

test("the test harness loads the client build of solid-js", () => {
  expect(existsSync(client)).toBe(true)
  expect(client.endsWith("/dist/solid.js")).toBe(true)
})

test("adjust counts mounts per session, drops a session at zero and never mutates its input", () => {
  const empty: ReadonlyMap<string, number> = new Map()
  const one = adjust(empty, "a", 1)
  expect([...one]).toEqual([["a", 1]])
  expect(empty.size).toBe(0)
  const two = adjust(one, "a", 1)
  expect(two.get("a")).toBe(2)
  expect(one.get("a")).toBe(1)
  expect([...adjust(adjust(two, "a", -1), "a", -1)]).toEqual([])
  expect([...adjust(empty, "a", -1)]).toEqual([])
})

test("a session is visible from enter until its release, independently of other sessions", () => {
  const presence = createSlotPresence()
  expect(presence.visible("a")).toBe(false)
  const release = presence.enter("a")
  expect(presence.visible("a")).toBe(true)
  expect(presence.visible("b")).toBe(false)
  const other = presence.enter("b")
  release()
  expect(presence.visible("a")).toBe(false)
  expect(presence.visible("b")).toBe(true)
  other()
  expect(presence.visible("b")).toBe(false)
})

test("overlapping mounts stay visible until the last release, and a stale release cannot undo a later mount", () => {
  const presence = createSlotPresence()
  const first = presence.enter("a")
  const second = presence.enter("a")
  first()
  first()
  expect(presence.visible("a")).toBe(true)
  second()
  expect(presence.visible("a")).toBe(false)
  const third = presence.enter("a")
  first()
  second()
  expect(presence.visible("a")).toBe(true)
  third()
  expect(presence.visible("a")).toBe(false)
})

test("tracked presence follows a reactive session id: the old session is released with its own id before the new one is entered", () => {
  const presence = live.createSlotPresence()
  const changes: Array<[string, boolean]> = []
  const reads: Array<[boolean, boolean]> = []
  let setSessionID!: (id: string) => void
  const dispose = solid.createRoot((dispose) => {
    const [sessionID, set] = solid.createSignal("owner")
    setSessionID = set
    live.trackSlotPresence(presence, sessionID, (id, mounted) => changes.push([id, mounted]))
    // A composer-style reader: it must settle without re-running unboundedly (Solid throws on a dependency loop).
    solid.createEffect(() => reads.push([presence.visible("owner"), presence.visible("child")]))
    return dispose
  })
  expect(changes).toEqual([["owner", true]])
  expect(presence.visible("owner")).toBe(true)
  expect(presence.visible("child")).toBe(false)

  setSessionID("child")
  expect(changes).toEqual([["owner", true], ["owner", false], ["child", true]])
  expect(presence.visible("owner")).toBe(false)
  expect(presence.visible("child")).toBe(true)

  setSessionID("child")
  expect(changes.length).toBe(3)

  dispose()
  expect(changes.at(-1)).toEqual(["child", false])
  expect(presence.visible("child")).toBe(false)
  expect(reads.length).toBeLessThanOrEqual(3)
  expect(reads.at(-1)).toEqual([false, true])
})

test("two tracked components on different sessions do not disturb each other when one moves", () => {
  const presence = live.createSlotPresence()
  let moveFirst!: (id: string) => void
  const dispose = solid.createRoot((dispose) => {
    const [first, setFirst] = solid.createSignal("a")
    const [second] = solid.createSignal("b")
    moveFirst = setFirst
    live.trackSlotPresence(presence, first)
    live.trackSlotPresence(presence, second)
    return dispose
  })
  expect([presence.visible("a"), presence.visible("b"), presence.visible("c")]).toEqual([true, true, false])
  moveFirst("c")
  expect([presence.visible("a"), presence.visible("b"), presence.visible("c")]).toEqual([false, true, true])
  moveFirst("b")
  expect([presence.visible("a"), presence.visible("b"), presence.visible("c")]).toEqual([false, true, false])
  dispose()
  expect([presence.visible("a"), presence.visible("b"), presence.visible("c")]).toEqual([false, false, false])
})
