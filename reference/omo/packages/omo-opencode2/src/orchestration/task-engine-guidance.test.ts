import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"

import { createTaskEngine } from "./task-engine"
import { TaskRegistry } from "./task-registry"

type EngineEvent = {
  readonly type: string
  readonly data?: Readonly<Record<string, unknown>>
}

function createContext(events: readonly EngineEvent[]): Context {
  return {
    event: {
      subscribe: async function* () {
        for (const event of events) yield event
      },
    },
  } as Context
}

describe("createTaskEngine background guidance", () => {
  test("#given a background child with no text #when it succeeds #then the parent callback and registry receive guidance", async () => {
    // given
    const registry = new TaskRegistry()
    const task = registry.create({
      parentSessionID: "parent-1",
      agent: "explore",
      model: "zhipuai/glm-4.7",
      description: "empty child",
      background: true,
    })
    registry.update(task.id, { childSessionID: "child-1", status: "running" })
    const traceEvents: Array<{ event: string; detail?: Record<string, unknown> }> = []
    let resolveTerminal: ((text: string) => void) | undefined
    const terminal = new Promise<string>((resolve) => {
      resolveTerminal = resolve
    })

    // when
    const engine = createTaskEngine({
      ctx: createContext([
        { type: "session.execution.succeeded", data: { sessionID: "child-1" } },
      ]),
      registry,
      trace: (event, detail) => {
        traceEvents.push(detail === undefined ? { event } : { event, detail })
      },
      onBackgroundTerminal: ({ text }) => {
        resolveTerminal?.(text)
      },
    })
    const terminalText = await terminal
    engine.dispose()

    // then
    expect(terminalText.trim().length).toBeGreaterThan(0)
    expect(registry.output(task.id)).toBe(terminalText)
    expect(traceEvents).toContainEqual({
      event: "omo.task.unusable-output-detected",
      detail: { reason: "empty_response" },
    })
  })
})
