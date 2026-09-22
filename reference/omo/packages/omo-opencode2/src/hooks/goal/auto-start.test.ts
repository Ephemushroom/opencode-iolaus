import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGoalAutoStartHandler, createGoalController } from "./index"

function fixture() {
  const controller = createGoalController({
    projectDir: mkdtempSync(join(tmpdir(), "oc2-goal-auto-start-")),
  })
  const traces: string[] = []
  return { controller, traces }
}

function contextEvent(sessionID: string, userTexts: readonly string[]) {
  return {
    sessionID,
    messages: userTexts.map((text) => ({
      role: "user",
      content: [{ type: "text", text }],
    })),
  }
}

describe("createGoalAutoStartHandler", () => {
  test("#given a first main-session user turn #when context runs #then it creates the goal", async () => {
    // given
    const { controller, traces } = fixture()
    const handleContext = createGoalAutoStartHandler({
      controller,
      getSessionInfo: async () => ({}),
      trace: (event) => traces.push(event),
    })

    // when
    await handleContext(contextEvent("main", ["  Ship auto-start  "]))

    // then
    expect(controller.getGoal("main")?.objective).toBe("Ship auto-start")
    expect(traces).toEqual(["omo.goal.auto-started"])
  })

  test("#given a child session #when its first user turn runs #then it does not create a goal", async () => {
    // given
    const { controller, traces } = fixture()
    const handleContext = createGoalAutoStartHandler({
      controller,
      getSessionInfo: async () => ({ parentID: "parent" }),
      trace: (event) => traces.push(event),
    })

    // when
    await handleContext(contextEvent("child", ["Delegate work"]))

    // then
    expect(controller.getGoal("child")).toBeNull()
    expect(traces).toEqual([])
  })

  test("#given multiple real user turns #when context runs #then it does not auto-start late", async () => {
    // given
    const { controller } = fixture()
    const handleContext = createGoalAutoStartHandler({
      controller,
      getSessionInfo: async () => ({}),
    })

    // when
    await handleContext(contextEvent("main", ["First", "Second"]))

    // then
    expect(controller.getGoal("main")).toBeNull()
  })

  test("#given concurrent first-context callbacks #when both run #then they create one goal", async () => {
    // given
    const { controller, traces } = fixture()
    const handleContext = createGoalAutoStartHandler({
      controller,
      getSessionInfo: async () => ({}),
      trace: (event) => traces.push(event),
    })
    const event = contextEvent("main", ["Ship once"])

    // when
    await Promise.all([handleContext(event), handleContext(event)])

    // then
    expect(controller.getGoal("main")?.objective).toBe("Ship once")
    expect(traces).toEqual(["omo.goal.auto-started"])
  })
})
