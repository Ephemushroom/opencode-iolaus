import { describe, expect, test } from "bun:test"

import { createIdleInjector } from "./idle-injector"
import type { IdleInjectorDependencies } from "./idle-injector"
import { createSessionDispatchGate } from "./session-dispatch-gate"

const SESSION = "ses_test"
const idleEvent = { type: "session.idle", data: { sessionID: SESSION } }
const busyEvent = { type: "session.execution.started", data: { sessionID: SESSION } }

function harness(overrides: Partial<IdleInjectorDependencies> = {}) {
  const dispatched: string[] = []
  const injector = createIdleInjector({
    name: "omo.test",
    gate: createSessionDispatchGate(),
    sessionExists: async () => true,
    dispatch: async (_sessionID, prompt) => {
      dispatched.push(prompt)
    },
    settle: async () => undefined,
    resolve: () => ({ prompt: "continue" }),
    ...overrides,
  })
  return { dispatched, injector }
}

describe("idle injector", () => {
  test("#given a session with work left #when it goes idle #then it dispatches once", async () => {
    // given
    const { dispatched, injector } = harness()

    // when
    await injector.handleEvent(idleEvent)

    // then
    expect(dispatched).toEqual(["continue"])
  })

  test("#given resolve declines #when the session goes idle #then nothing is dispatched", async () => {
    // given
    const { dispatched, injector } = harness({ resolve: () => null })

    // when
    await injector.handleEvent(idleEvent)

    // then
    expect(dispatched).toEqual([])
  })

  test("#given the session goes busy while settling #when settle finishes #then the dispatch is abandoned", async () => {
    // given
    let injector: ReturnType<typeof createIdleInjector> | undefined
    const built = harness({
      settle: async () => {
        await injector?.handleEvent(busyEvent)
      },
    })
    injector = built.injector

    // when
    await built.injector.handleEvent(idleEvent)

    // then
    expect(built.dispatched).toEqual([])
  })

  test("#given the session no longer exists #when it goes idle #then nothing is dispatched", async () => {
    // given
    const { dispatched, injector } = harness({ sessionExists: async () => false })

    // when
    await injector.handleEvent(idleEvent)

    // then
    expect(dispatched).toEqual([])
  })

  // A throwing dispatch still counts as dispatched, because markDispatched runs
  // before the call: the message may have been queued and only the ack failed,
  // so the hold is kept to avoid a duplicate injection. What must never happen
  // is the reservation leaking past that hold.
  test("#given a dispatch threw #when the hold lapses #then the reservation does not leak", async () => {
    // given
    const gate = createSessionDispatchGate({ postDispatchHoldMs: 1 })
    const { injector } = harness({
      gate,
      dispatch: async () => {
        throw new Error("boom")
      },
    })

    // when
    await injector.handleEvent(idleEvent)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))

    // then
    expect(injector.hasReservation(SESSION)).toBe(false)
  })

  test("#given a dispatch threw #when it is caught #then the error does not escape the pump", async () => {
    // given
    const { injector } = harness({
      dispatch: async () => {
        throw new Error("boom")
      },
    })

    // when
    const settled = injector.handleEvent(idleEvent)

    // then
    expect(settled).resolves.toBeUndefined()
  })

  test("#given a deleted session #when the event arrives #then the gate is released and cleanup runs", async () => {
    // given
    const gate = createSessionDispatchGate()
    const deleted: string[] = []
    const { injector } = harness({ gate, onSessionDeleted: (id) => deleted.push(id) })

    // when
    await injector.handleEvent({ type: "session.deleted", id: SESSION })

    // then
    expect(deleted).toEqual([SESSION])
    expect(gate.isReserved(SESSION)).toBe(false)
  })

  test("#given a disposed injector #when a session goes idle #then nothing is dispatched", async () => {
    // given
    const { dispatched, injector } = harness()
    injector.dispose()

    // when
    await injector.handleEvent(idleEvent)

    // then
    expect(dispatched).toEqual([])
  })

  // The property PR-4 exists to guarantee, now exercised through two real
  // injectors rather than the gate alone. This is what makes a second
  // idle-injecting feature safe to add.
  test("#given two injectors sharing one gate #when one idle edge fires #then exactly one dispatches", async () => {
    // given
    const gate = createSessionDispatchGate()
    const dispatched: string[] = []
    const build = (name: string) =>
      createIdleInjector({
        name,
        gate,
        sessionExists: async () => true,
        dispatch: async () => {
          dispatched.push(name)
        },
        settle: async () => undefined,
        resolve: () => ({ prompt: "continue" }),
      })
    const first = build("omo.first")
    const second = build("omo.second")

    // when
    await Promise.all([first.handleEvent(idleEvent), second.handleEvent(idleEvent)])

    // then
    expect(dispatched).toHaveLength(1)
  })

  test("#given two injectors with separate gates #when one idle edge fires #then both dispatch, which is the bug", async () => {
    // given
    const dispatched: string[] = []
    const build = (name: string) =>
      createIdleInjector({
        name,
        gate: createSessionDispatchGate(),
        sessionExists: async () => true,
        dispatch: async () => {
          dispatched.push(name)
        },
        settle: async () => undefined,
        resolve: () => ({ prompt: "continue" }),
      })
    const first = build("omo.first")
    const second = build("omo.second")

    // when
    await Promise.all([first.handleEvent(idleEvent), second.handleEvent(idleEvent)])

    // then
    expect(dispatched).toHaveLength(2)
  })
})
