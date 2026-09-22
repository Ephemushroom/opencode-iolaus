import { describe, expect, test } from "bun:test"

import { guideTaskResult } from "./task-result-guidance"

describe("guideTaskResult", () => {
  test("#given whitespace-only child output #when guided #then it becomes an actionable empty-response result", () => {
    // given
    const output = " \n\t"
    const events: Array<{ event: string; detail?: Readonly<Record<string, unknown>> }> = []

    // when
    const result = guideTaskResult(output, (event, detail) => events.push({ event, detail }))

    // then
    expect(result.kind).toBe("empty_response")
    expect(result.content.trim().length).toBeGreaterThan(0)
    expect(events).toEqual([
      {
        event: "omo.task.unusable-output-detected",
        detail: { reason: "empty_response" },
      },
    ])
  })

  test("#given a recognized task invocation error #when guided #then retry metadata and guidance are appended", () => {
    // given
    const output = '[ERROR] Unknown agent: "missing". Available agents: explore, oracle'
    const events: Array<{ event: string; detail?: Readonly<Record<string, unknown>> }> = []

    // when
    const result = guideTaskResult(output, (event, detail) => events.push({ event, detail }))

    // then
    expect(result.kind).toBe("retryable_error")
    if (result.kind !== "retryable_error") return
    expect(result.errorType).toBe("unknown_agent")
    expect(result.content.startsWith(output)).toBe(true)
    expect(result.content.length).toBeGreaterThan(output.length)
    expect(events).toEqual([
      {
        event: "omo.task.unusable-output-detected",
        detail: { reason: "retryable_error", errorType: "unknown_agent" },
      },
    ])
  })

  test("#given normal non-empty task output #when guided #then it remains byte-for-byte unchanged", () => {
    // given
    const output = "Task task_123 result:\nCompleted the requested analysis."
    const events: Array<{ event: string; detail?: Readonly<Record<string, unknown>> }> = []

    // when
    const result = guideTaskResult(output, (event, detail) => events.push({ event, detail }))

    // then
    expect(result).toEqual({ kind: "usable", content: output })
    expect(events).toEqual([])
  })
})
