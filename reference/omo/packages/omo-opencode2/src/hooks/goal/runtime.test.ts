import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { createGoalController, createGoalRuntime } from "./index"
import type { GoalEvent, GoalRuntimeDependencies } from "./index"

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let release: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    promise,
    resolve: () => release?.(),
  }
}

function runtimeFixture(overrides: Partial<GoalRuntimeDependencies> = {}) {
  const controller = createGoalController({ projectDir: mkdtempSync(join(tmpdir(), "oc2-goal-runtime-")) })
  const dispatches: string[] = []
  const traces: string[] = []
  const runtime = createGoalRuntime({
    controller,
    gate: createSessionDispatchGate(),
    sessionExists: async () => true,
    dispatchContinuation: async (sessionID) => {
      dispatches.push(sessionID)
    },
    settle: async () => undefined,
    trace: (event) => traces.push(event),
    ...overrides,
  })
  return { controller, dispatches, runtime, traces }
}

const idle = (sessionID = "s1"): GoalEvent => ({
  type: "session.execution.succeeded",
  data: { sessionID },
})

describe("OpenCode2 goal runtime", () => {
  test("#given an active goal #when concurrent and repeated idle edges arrive #then one continuation is dispatched", async () => {
    // given
    const { controller, dispatches, runtime, traces } = runtimeFixture()
    controller.setGoal("s1", "Ship")

    // when
    await Promise.all([runtime.handleEvent(idle()), runtime.handleEvent(idle())])
    await runtime.handleEvent(idle())

    // then
    expect(dispatches).toEqual(["s1"])
    expect(traces.filter((event) => event === "omo.goal.continuation-injected")).toHaveLength(1)
  })

  test("#given an idle continuation settling #when the session becomes active #then dispatch is cancelled", async () => {
    // given
    const deferred = createDeferred()
    const { controller, dispatches, runtime } = runtimeFixture({ settle: () => deferred.promise })
    controller.setGoal("s1", "Ship")
    const pending = runtime.handleEvent(idle())

    // when
    await runtime.handleEvent({ type: "session.execution.started", data: { sessionID: "s1" } })
    deferred.resolve()
    await pending

    // then
    expect(dispatches).toEqual([])
  })

  test("#given an idle continuation settling #when its goal is paused #then dispatch is cancelled", async () => {
    // given
    const deferred = createDeferred()
    const { controller, dispatches, runtime } = runtimeFixture({ settle: () => deferred.promise })
    controller.setGoal("s1", "Ship")
    const pending = runtime.handleEvent(idle())

    // when
    controller.pauseGoal("s1")
    deferred.resolve()
    await pending

    // then
    expect(dispatches).toEqual([])
    expect(runtime.hasReservation("s1")).toBe(false)
  })

  test("#given paused and complete goals #when idle edges arrive #then neither continues", async () => {
    // given
    const { controller, dispatches, runtime } = runtimeFixture()
    controller.setGoal("paused", "Wait")
    controller.pauseGoal("paused")
    controller.setGoal("complete", "Done")
    controller.markComplete("complete")

    // when
    await runtime.handleEvent(idle("paused"))
    await runtime.handleEvent(idle("complete"))

    // then
    expect(dispatches).toEqual([])
  })

  test("#given a persisted goal #when its session is deleted #then state and reservation are cleared", async () => {
    // given
    const { controller, runtime } = runtimeFixture()
    controller.setGoal("s1", "Ship")
    await runtime.handleEvent(idle())

    // when
    await runtime.handleEvent({ type: "session.deleted", id: "s1" })

    // then
    expect(controller.getGoal("s1")).toBeNull()
    expect(runtime.hasReservation("s1")).toBe(false)
  })
})
