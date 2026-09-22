/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CheckResult, RunCommentCheckerInput } from "@oh-my-opencode/comment-checker-core"
import {
  createCommentCheckerAfterHandler,
  type CommentCheckerAfterEvent,
  type CommentCheckerRuntime,
} from "./register"

type TraceRecord = {
  readonly event: string
  readonly detail?: Record<string, unknown>
}

function createCompletedEvent(overrides: Partial<CommentCheckerAfterEvent> = {}): CommentCheckerAfterEvent {
  return {
    tool: "write",
    sessionID: "session-1",
    agent: "sisyphus",
    status: "completed",
    input: {
      filePath: "src/example.ts",
      content: "const value = 1\n",
    },
    result: { content: "written" },
    ...overrides,
  }
}

function createRuntime(
  result: CheckResult = { hasComments: false, message: "" },
  binaryPath: string | null = "/fake/comment-checker",
): {
  readonly calls: RunCommentCheckerInput[]
  readonly state: { resolveCalls: number }
  readonly runtime: CommentCheckerRuntime
} {
  const calls: RunCommentCheckerInput[] = []
  const state = { resolveCalls: 0 }
  return {
    calls,
    state,
    runtime: {
      resolveBinary: () => {
        state.resolveCalls += 1
        return binaryPath
      },
      run: async (input) => {
        calls.push(input)
        return result
      },
    },
  }
}

function createHandler(runtime: CommentCheckerRuntime): {
  readonly traces: TraceRecord[]
  readonly handle: ReturnType<typeof createCommentCheckerAfterHandler>
} {
  const traces: TraceRecord[] = []
  return {
    traces,
    handle: createCommentCheckerAfterHandler(runtime, (event, detail) => traces.push({ event, detail })),
  }
}

describe("OpenCode2 comment-checker post-tool hook", () => {
  it("#given a completed write with a checker violation #when the hook runs #then feedback and a detection trace reach the model", async () => {
    // given
    const { runtime, calls } = createRuntime({
      hasComments: true,
      message: "src/example.ts:1: AI slop comment",
    })
    const { handle, traces } = createHandler(runtime)
    const event = createCompletedEvent({
      input: {
        filePath: "src/example.ts",
        content: "// obviously increment the counter\nconst value = 1\n",
      },
    })

    // when
    await handle(event)

    // then
    expect(calls).toHaveLength(1)
    expect(calls[0]?.hookInput.tool_input.content).toBe(
      "// obviously increment the counter\nconst value = 1\n",
    )
    expect(event.result.content).toBe("written\n\nsrc/example.ts:1: AI slop comment")
    expect(traces.map((record) => record.event)).toEqual([
      "omo.comment-checker.checked",
      "omo.comment-checker.detected",
    ])
  })

  it("#given a completed clean write #when the hook runs #then output is unchanged and no detection trace appears", async () => {
    // given
    const { runtime } = createRuntime()
    const { handle, traces } = createHandler(runtime)
    const event = createCompletedEvent()

    // when
    await handle(event)

    // then
    expect(event.result.content).toBe("written")
    expect(traces).toEqual([
      {
        event: "omo.comment-checker.checked",
        detail: expect.objectContaining({ outcome: "clean", tool: "write" }),
      },
    ])
  })

  it("#given an array-shaped tool result #when a violation is found #then feedback is appended as a text part", async () => {
    // given
    const { runtime } = createRuntime({ hasComments: true, message: "remove filler comment" })
    const { handle } = createHandler(runtime)
    const event = createCompletedEvent({
      result: { content: [{ type: "text", text: "written" }, { type: "file", uri: "file:///src/example.ts" }] },
    })

    // when
    await handle(event)

    // then
    expect(event.result.content).toEqual([
      { type: "text", text: "written" },
      { type: "file", uri: "file:///src/example.ts" },
      { type: "text", text: "\n\nremove filler comment" },
    ])
  })

  it("#given the v1 line escape #when the checker accepts it #then @allow is forwarded unchanged and no feedback is injected", async () => {
    // given
    const calls: RunCommentCheckerInput[] = []
    const runtime: CommentCheckerRuntime = {
      resolveBinary: () => "/fake/comment-checker",
      run: async (input) => {
        calls.push(input)
        const content = input.hookInput.tool_input.content ?? ""
        return content.includes("// @allow")
          ? { hasComments: false, message: "" }
          : { hasComments: true, message: "unexpected unescaped content" }
      },
    }
    const { handle, traces } = createHandler(runtime)
    const lineEscape = "// @allow - protocol explanation is required\nconst value = 1\n"
    const lineEvent = createCompletedEvent({ input: { path: "src/line.ts", content: lineEscape } })

    // when
    await handle(lineEvent)

    // then
    expect(calls.map((call) => call.hookInput.tool_input.content)).toEqual([lineEscape])
    expect(lineEvent.result.content).toBe("written")
    expect(traces.some((record) => record.event === "omo.comment-checker.detected")).toBe(false)
  })

  it("#given the v1 file escape at the first line #when a write completes #then the adapter bypasses the checker", async () => {
    // given
    const directory = mkdtempSync(join(tmpdir(), "omo-oc2-comment-checker-"))
    const filePath = join(directory, "fixture.ts")
    const content = "// comment-checker-disable-file\n// generated fixture comments are intentional\n"
    writeFileSync(filePath, content)
    const { runtime, calls } = createRuntime({ hasComments: true, message: "must not run" })
    const { handle, traces } = createHandler(runtime)
    const event = createCompletedEvent({ input: { filePath, content } })

    try {
      // when
      await handle(event)

      // then
      expect(calls).toHaveLength(0)
      expect(event.result.content).toBe("written")
      expect(traces).toEqual([
        {
          event: "omo.comment-checker.checked",
          detail: expect.objectContaining({ outcome: "disabled", filePath }),
        },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("#given a completed edit #when the hook runs #then old and new strings are mapped to the core contract", async () => {
    // given
    const { runtime, calls } = createRuntime()
    const { handle } = createHandler(runtime)
    const event = createCompletedEvent({
      tool: "edit",
      input: {
        file_path: "src/edit.ts",
        old_string: "const value = 1\n",
        new_string: "// reason\nconst value = 1\n",
      },
    })

    // when
    await handle(event)

    // then
    expect(calls[0]?.hookInput.tool_input).toEqual({
      file_path: "src/edit.ts",
      old_string: "const value = 1\n",
      new_string: "// reason\nconst value = 1\n",
    })
  })

  it("#given apply_patch input without metadata #when the hook runs #then core patch extraction checks the edited file", async () => {
    // given
    const { runtime, calls } = createRuntime()
    const { handle } = createHandler(runtime)
    const event = createCompletedEvent({
      tool: "apply_patch",
      input: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: src/patched.ts",
          "@@",
          "-const value = 1",
          "+// reason",
          "+const value = 1",
          "*** End Patch",
        ].join("\n"),
      },
    })

    // when
    await handle(event)

    // then
    expect(calls).toHaveLength(1)
    expect(calls[0]?.hookInput.tool_input).toEqual({
      file_path: "src/patched.ts",
      old_string: "const value = 1\n",
      new_string: "// reason\nconst value = 1\n",
    })
  })

  it("#given the optional binary is unavailable #when completed writes repeat #then the hook stays inert and resolves once", async () => {
    // given
    const { runtime, calls, state } = createRuntime({ hasComments: true, message: "must not run" }, null)
    const { handle, traces } = createHandler(runtime)
    const first = createCompletedEvent()
    const second = createCompletedEvent({ sessionID: "session-2" })

    // when
    await handle(first)
    await handle(second)

    // then
    expect(state.resolveCalls).toBe(1)
    expect(calls).toHaveLength(0)
    expect(first.result.content).toBe("written")
    expect(traces.map((record) => record.detail?.["outcome"])).toEqual(["unavailable", "unavailable"])
  })

  it("#given failed or non-mutation tools #when the hook runs #then the checker does not execute", async () => {
    // given
    const { runtime, calls } = createRuntime()
    const { handle, traces } = createHandler(runtime)
    const failed = {
      tool: "write",
      sessionID: "session-1",
      agent: "sisyphus",
      status: "error",
      input: { filePath: "src/example.ts", content: "// comment" },
      error: { message: "write failed" },
    } satisfies CommentCheckerAfterEvent
    const read = createCompletedEvent({ tool: "read" })

    // when
    await handle(failed)
    await handle(read)

    // then
    expect(calls).toHaveLength(0)
    expect(traces).toHaveLength(0)
  })
})
