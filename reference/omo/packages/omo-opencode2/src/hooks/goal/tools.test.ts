import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGoalController, createGoalTools } from "./index"
import type { GoalToolDefinition, GoalTrace } from "./index"

function toolByName(tools: readonly GoalToolDefinition[], name: string): GoalToolDefinition {
  const selected = tools.find((tool) => tool.name === name)
  if (selected === undefined) {
    throw new Error(`Missing test tool: ${name}`)
  }
  return selected
}

describe("OpenCode2 goal tools", () => {
  test("#given the goal tool set #when create_goal runs #then it targets the calling session and traces creation", async () => {
    // given
    const controller = createGoalController({ projectDir: mkdtempSync(join(tmpdir(), "oc2-goal-tools-")) })
    const events: string[] = []
    const trace: GoalTrace = (event) => events.push(event)
    const createGoal = toolByName(createGoalTools({ controller, trace }), "create_goal")

    // when
    const result = await createGoal.execute({ objective: "Ship" }, { sessionID: "s1" })
    const response = JSON.parse(result.content)

    // then
    expect(response.goal.sessionID).toBe("s1")
    expect(response.goal.objective).toBe("Ship")
    expect(response.goal.status).toBe("active")
    expect(events).toEqual(["omo.goal.created"])
  })

  test("#given an active goal #when update_goal completes it #then completion is persisted and traced", async () => {
    // given
    const controller = createGoalController({ projectDir: mkdtempSync(join(tmpdir(), "oc2-goal-tools-")) })
    controller.setGoal("s1", "Ship")
    const events: string[] = []
    const trace: GoalTrace = (event) => events.push(event)
    const updateGoal = toolByName(createGoalTools({ controller, trace }), "update_goal")

    // when
    const result = await updateGoal.execute({ status: "complete" }, { sessionID: "s1" })
    const response = JSON.parse(result.content)

    // then
    expect(response.goal.status).toBe("complete")
    expect(controller.getGoal("s1")?.status).toBe("complete")
    expect(events).toEqual(["omo.goal.completed"])
  })

  test("#given goals in two sessions #when get_goal runs #then it reads only the calling session", async () => {
    // given
    const controller = createGoalController({ projectDir: mkdtempSync(join(tmpdir(), "oc2-goal-tools-")) })
    controller.setGoal("caller", "Caller goal")
    controller.setGoal("target", "Target goal")
    const getGoal = toolByName(createGoalTools({ controller }), "get_goal")

    // when
    const result = await getGoal.execute({}, { sessionID: "caller" })
    const response = JSON.parse(result.content)

    // then
    expect(response.goal.sessionID).toBe("caller")
    expect(response.goal.objective).toBe("Caller goal")
  })

  test("#given an explicit session_id #when a goal tool parses it #then the cross-session input is rejected", async () => {
    // given
    const controller = createGoalController({ projectDir: mkdtempSync(join(tmpdir(), "oc2-goal-tools-")) })
    const getGoal = toolByName(createGoalTools({ controller }), "get_goal")

    // when
    const operation = getGoal.execute({ session_id: "target" }, { sessionID: "caller" })

    // then
    await expect(operation).rejects.toThrow()
  })
})
