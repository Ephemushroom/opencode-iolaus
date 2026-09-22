import { describe, expect, test } from "bun:test"

import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import type { TodoItem, TodoStatus } from "../../orchestration/todo-store"
import { createTodoContinuationRuntime } from "./runtime"

const SESSION = "ses_test"
const idleEvent = { type: "session.idle", data: { sessionID: SESSION } }

function todos(...statuses: readonly TodoStatus[]): readonly TodoItem[] {
  return statuses.map((status, index) => ({
    id: `t${index}`,
    content: `task ${index}`,
    status,
    priority: "medium" as const,
  }))
}

function harness(initial: readonly TodoItem[], maxConsecutive?: number) {
  let current = initial
  const prompts: string[] = []
  const runtime = createTodoContinuationRuntime({
    getTodos: () => current,
    sessionExists: async () => true,
    dispatchContinuation: async (_sessionID, prompt) => {
      prompts.push(prompt)
    },
    settle: async () => undefined,
    gate: createSessionDispatchGate({ postDispatchHoldMs: 1 }),
    maxConsecutive,
  })
  return {
    prompts,
    runtime,
    setTodos: (next: readonly TodoItem[]) => {
      current = next
    },
  }
}

// The gate holds a session briefly after a dispatch, so consecutive idle edges
// in a test need that hold to lapse before the next one can be admitted.
const afterHold = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe("todo continuation runtime", () => {
  test("#given unfinished todos #when the session goes idle #then a continuation is injected", async () => {
    // given
    const { prompts, runtime } = harness(todos("pending", "completed"))

    // when
    await runtime.handleEvent(idleEvent)

    // then
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("1 unfinished todo")
  })

  test("#given an in_progress todo #when the session goes idle #then it still counts as unfinished", async () => {
    // given
    const { prompts, runtime } = harness(todos("in_progress"))

    // when
    await runtime.handleEvent(idleEvent)

    // then
    expect(prompts).toHaveLength(1)
  })

  test("#given every todo is completed #when the session goes idle #then nothing is injected", async () => {
    // given
    const { prompts, runtime } = harness(todos("completed", "completed"))

    // when
    await runtime.handleEvent(idleEvent)

    // then
    expect(prompts).toEqual([])
  })

  test("#given no todos at all #when the session goes idle #then nothing is injected", async () => {
    // given
    const { prompts, runtime } = harness([])

    // when
    await runtime.handleEvent(idleEvent)

    // then
    expect(prompts).toEqual([])
  })

  test("#given a stuck session #when it idles past the budget #then continuations stop", async () => {
    // given
    const { prompts, runtime } = harness(todos("pending"), 2)

    // when
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await runtime.handleEvent(idleEvent)
      await afterHold()
    }

    // then
    expect(prompts).toHaveLength(2)
  })

  test("#given the budget is spent #when the remaining count drops #then the budget resets", async () => {
    // given
    const { prompts, runtime, setTodos } = harness(todos("pending", "pending"), 1)
    await runtime.handleEvent(idleEvent)
    await afterHold()
    await runtime.handleEvent(idleEvent)
    await afterHold()
    expect(prompts).toHaveLength(1)

    // when
    setTodos(todos("pending", "completed"))
    await runtime.handleEvent(idleEvent)

    // then
    expect(prompts).toHaveLength(2)
  })
})
