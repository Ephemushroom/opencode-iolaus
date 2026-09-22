import { describe, expect, test } from "bun:test"

import { createSessionDispatchGate } from "./session-dispatch-gate"

const SESSION = "ses_test"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("session dispatch gate", () => {
  describe("#given a session already reserved by an in-flight caller", () => {
    test("#when a second caller starts #then it is blocked and its body never runs", async () => {
      // given
      const gate = createSessionDispatchGate()
      const held = deferred()
      let secondBodyRuns = 0
      const first = gate.run(SESSION, async (markDispatched) => {
        markDispatched()
        await held.promise
      })

      // when
      const second = await gate.run(SESSION, async () => {
        secondBodyRuns += 1
      })

      // then
      expect(second).toBe("blocked")
      expect(secondBodyRuns).toBe(0)
      held.resolve()
      expect(await first).toBe("ran")
    })
  })

  describe("#given two distinct features sharing one gate instance", () => {
    test("#when both observe the same idle edge #then exactly one dispatches", async () => {
      // given
      const gate = createSessionDispatchGate()
      const dispatches: string[] = []
      const inject = (feature: string) =>
        gate.run(SESSION, async (markDispatched) => {
          markDispatched()
          dispatches.push(feature)
        })

      // when
      const [goal, todo] = await Promise.all([inject("goal"), inject("todo-enforcer")])

      // then
      expect(dispatches).toEqual(["goal"])
      expect(goal).toBe("ran")
      expect(todo).toBe("blocked")
    })
  })

  describe("#given separate gate instances per feature", () => {
    test("#when both observe the same idle edge #then both dispatch, which is the bug", async () => {
      // given
      const goalGate = createSessionDispatchGate()
      const todoGate = createSessionDispatchGate()
      const dispatches: string[] = []

      // when
      await goalGate.run(SESSION, async (mark) => {
        mark()
        dispatches.push("goal")
      })
      await todoGate.run(SESSION, async (mark) => {
        mark()
        dispatches.push("todo-enforcer")
      })

      // then
      expect(dispatches).toEqual(["goal", "todo-enforcer"])
    })
  })

  describe("#given a body that returns without dispatching", () => {
    test("#when it completes #then the session is released immediately", async () => {
      // given
      const gate = createSessionDispatchGate()

      // when
      const aborted = await gate.run(SESSION, async () => undefined)

      // then
      expect(aborted).toBe("ran")
      expect(gate.isReserved(SESSION)).toBe(false)
      expect(await gate.run(SESSION, async () => undefined)).toBe("ran")
    })
  })

  describe("#given a body that dispatched", () => {
    test("#when it completes #then the hold keeps the session reserved until it expires", async () => {
      // given
      let clock = 1_000
      const gate = createSessionDispatchGate({ postDispatchHoldMs: 500, now: () => clock })
      await gate.run(SESSION, async (mark) => mark())

      // when
      const duringHold = gate.isReserved(SESSION)
      clock += 500
      const afterHold = gate.isReserved(SESSION)

      // then
      expect(duringHold).toBe(true)
      expect(afterHold).toBe(false)
    })
  })

  describe("#given a hold that has expired and a newer caller has reserved", () => {
    test("#when the older caller releases #then it does not free the newer reservation", async () => {
      // given
      let clock = 1_000
      const gate = createSessionDispatchGate({ postDispatchHoldMs: 100, now: () => clock })
      const held = deferred()
      const slow = gate.run(SESSION, async (mark) => {
        mark()
        await held.promise
      })
      clock += 100
      gate.release(SESSION)
      await gate.run(SESSION, async (mark) => mark())

      // when
      held.resolve()
      await slow

      // then
      expect(gate.isReserved(SESSION)).toBe(true)
    })
  })

  describe("#given a body that throws", () => {
    test("#when it rejects #then the reservation is released and the error propagates", async () => {
      // given
      const gate = createSessionDispatchGate()

      // when
      const attempt = gate.run(SESSION, async () => {
        throw new Error("dispatch failed")
      })

      // then
      await expect(attempt).rejects.toThrow("dispatch failed")
      expect(gate.isReserved(SESSION)).toBe(false)
    })
  })

  describe("#given distinct sessions", () => {
    test("#when each reserves #then they do not block one another", async () => {
      // given
      const gate = createSessionDispatchGate()
      const held = deferred()
      const first = gate.run("ses_a", async (mark) => {
        mark()
        await held.promise
      })

      // when
      const other = await gate.run("ses_b", async (mark) => mark())

      // then
      expect(other).toBe("ran")
      held.resolve()
      await first
    })
  })

  describe("#given a disposed gate", () => {
    test("#when a caller starts #then it is blocked", async () => {
      // given
      const gate = createSessionDispatchGate()
      gate.dispose()

      // when
      const outcome = await gate.run(SESSION, async () => undefined)

      // then
      expect(outcome).toBe("blocked")
    })
  })
})
