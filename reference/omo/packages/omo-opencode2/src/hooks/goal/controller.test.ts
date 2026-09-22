import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGoalController, goalFilePath } from "./index"

function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), "oc2-goal-controller-"))
  return {
    controller: createGoalController({ projectDir }),
    projectDir,
  }
}

describe("OpenCode2 goal controller", () => {
  test("#given no goal #when a goal is created #then it persists as active per session", () => {
    // given
    const { controller, projectDir } = fixture()

    // when
    const created = controller.setGoal("session/a", "  Ship the adapter  ")
    const reloaded = createGoalController({ projectDir }).getGoal("session/a")

    // then
    expect(created.objective).toBe("Ship the adapter")
    expect(created.status).toBe("active")
    expect(reloaded).toEqual(created)
    expect(existsSync(goalFilePath(projectDir, "session/a"))).toBe(true)
  })

  test("#given goals for two sessions #when one changes #then the other is unchanged", () => {
    // given
    const { controller } = fixture()
    controller.setGoal("s1", "First")
    controller.setGoal("s2", "Second")

    // when
    controller.pauseGoal("s1")

    // then
    expect(controller.getGoal("s1")?.status).toBe("paused")
    expect(controller.getGoal("s2")?.status).toBe("active")
  })

  test("#given an active goal #when it is completed #then completion persists", () => {
    // given
    const { controller } = fixture()
    controller.setGoal("s1", "Finish")

    // when
    const completed = controller.markComplete("s1")

    // then
    expect(completed?.status).toBe("complete")
    expect(completed?.completedAt).toBeGreaterThan(0)
    expect(controller.getGoal("s1")?.status).toBe("complete")
  })

  test("#given a persisted goal #when it is cleared #then its session file is removed", () => {
    // given
    const { controller, projectDir } = fixture()
    controller.setGoal("s1", "Discard")

    // when
    const existed = controller.clearGoal("s1")

    // then
    expect(existed).toBe(true)
    expect(controller.getGoal("s1")).toBeNull()
    expect(existsSync(goalFilePath(projectDir, "s1"))).toBe(false)
  })
})
