import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGoalAutoStartHandler, type GoalContextEvent } from "./auto-start"
import { createGoalController } from "./controller"

test("#given nullable compaction content #when auto-start processes the first user turn #then only user text becomes the objective", async () => {
  // given
  const projectDir = mkdtempSync(join(tmpdir(), "oc2-goal-sdk-"))
  const controller = createGoalController({ projectDir })
  const handleContext = createGoalAutoStartHandler({
    controller,
    getSessionInfo: async () => ({}),
  })
  const event = {
    sessionID: "main",
    messages: [{
      role: "user",
      content: [
        { type: "compaction", text: null },
        { type: "text", text: "Keep the requested objective" },
      ],
    }],
  } satisfies GoalContextEvent

  try {
    // when
    await handleContext(event)

    // then
    expect(controller.getGoal("main")?.objective).toBe("Keep the requested objective")
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})
