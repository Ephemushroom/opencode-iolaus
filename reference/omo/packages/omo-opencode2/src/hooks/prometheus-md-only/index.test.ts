/// <reference types="bun-types" />

import { beforeEach, describe, expect, test } from "bun:test"
import { registerPrometheusMdOnly } from "./index"
import { PLANNING_CONSULT_WARNING, PROMETHEUS_WORKFLOW_REMINDER } from "./constants"
import { Effect } from "effect"

interface GuardEvent {
  agent?: string
  tool: string
  status?: string
  sessionID: string
  input: unknown
  result?: { content: string }
}

type GuardHandler = (event: GuardEvent) => Effect.Effect<void, unknown, never>
type TraceRecord = { evt: string; det?: Record<string, unknown> }

describe("prometheus-md-only hook", () => {
  let beforeHook: GuardHandler
  let afterHook: GuardHandler
  const traceMsgs: TraceRecord[] = []

  beforeEach(async () => {
    traceMsgs.length = 0
    const ctx = {
      tool: {
          hook: (name: string, handler: GuardHandler) => {
            if (name === "execute.before") beforeHook = handler
            if (name === "execute.after") afterHook = handler
            return Effect.succeed({ dispose: Effect.void })
          },
      },
    }

    await Effect.runPromise(Effect.scoped(registerPrometheusMdOnly(ctx, (evt, det) =>
      traceMsgs.push({ evt, det }),
    )))
  })

  test("#when agent is prometheus and writes non-md, #then blocks", async () => {
    await expect(
      Effect.runPromise(beforeHook({ agent: "prometheus", tool: "write", sessionID: "sess-1", input: { filePath: "src/index.ts" } })),
    ).rejects.toThrow("File operations restricted to .omo/*.md plan files only")
  })

  test("#when agent is prometheus and writes outside .omo, #then blocks", async () => {
    await expect(
      Effect.runPromise(beforeHook({ agent: "prometheus", tool: "write", sessionID: "sess-1", input: { filePath: "test.md" } })),
    ).rejects.toThrow("File operations restricted to .omo/*.md plan files only")
  })

  // Isolates the extension rule from the .omo rule: this path satisfies the
  // .omo requirement and must still be rejected on its extension alone. The
  // live QA cannot prove this branch, because prometheus declines to attempt a
  // non-markdown write at all rather than being stopped by the hook.
  test("#when agent is prometheus and writes a non-md extension inside .omo, #then blocks", async () => {
    await expect(
      Effect.runPromise(beforeHook({ agent: "prometheus", tool: "write", sessionID: "sess-1", input: { filePath: ".omo/notes.txt" } })),
    ).rejects.toThrow("File operations restricted to .omo/*.md plan files only")
  })

  test("#when agent is prometheus and writes .omo plan, #then allows", async () => {
    await expect(
      Effect.runPromise(beforeHook({ agent: "prometheus", tool: "write", sessionID: "sess-1", input: { filePath: ".omo/plans/design.md" } })),
    ).resolves.toBeUndefined()
  })

  test("#when agent is NOT prometheus and writes non-md, #then allows", async () => {
    await expect(
      Effect.runPromise(beforeHook({ agent: "sisyphus", tool: "write", sessionID: "sess-1", input: { filePath: "src/index.ts" } })),
    ).resolves.toBeUndefined()
  })

  test("#when prometheus writes to .omo/plans, #then execute.after injects reminder", async () => {
    const event: GuardEvent = {
      agent: "prometheus",
      tool: "write",
      status: "completed",
      sessionID: "sess-1",
      input: { filePath: ".omo/plans/test.md" },
      result: { content: "written" },
    }
    await Effect.runPromise(afterHook(event))
    expect(event.result?.content).toBe("written" + PROMETHEUS_WORKFLOW_REMINDER)
  })

  test("#when prometheus delegates with task tool, #then injects planning warning", async () => {
    const input = { prompt: "do this" }
    const event: GuardEvent = {
      agent: "prometheus",
      tool: "task",
      sessionID: "sess-1",
      input,
    }
    await Effect.runPromise(beforeHook(event))
    expect(input.prompt).toBe(PLANNING_CONSULT_WARNING + "do this")
  })
})
