import { describe, expect, test } from "bun:test"

import { createBtwTools } from "./tools"
import type { ChildSessionDeps } from "../../orchestration/child-session"
import type { Context } from "@opencode/plugin/promise/plugin"

type PromptCall = {
  sessionID: string
  text: string
  metadata?: Record<string, unknown>
}

function createContextStub(): {
  ctx: Context
  prompts: PromptCall[]
  createdTitles: string[]
} {
  const prompts: PromptCall[] = []
  const createdTitles: string[] = []
  let sessionCounter = 0

  const ctx = {
    session: {
      create: async (input: { title?: string }) => {
        sessionCounter += 1
        if (input.title) createdTitles.push(input.title)
        return { id: `ses_side_${sessionCounter}` }
      },
      prompt: async (input: PromptCall) => {
        prompts.push(input)
        return { id: "inbox_user_1" }
      },
    },
    options: {},
  } as unknown as Context

  return { ctx, prompts, createdTitles }
}

function createDepsStub(): { deps: ChildSessionDeps; waits: string[] } {
  const waits: string[] = []
  return {
    waits,
    deps: {
      waitChild: async (options: { sessionID: string }) => {
        waits.push(options.sessionID)
        return { ok: true, text: "side answer" }
      },
      interrupt: async () => undefined,
    },
  }
}

const resolveSessionID = (toolCtx: unknown): string | undefined => {
  const record = typeof toolCtx === "object" && toolCtx !== null ? (toolCtx as Record<string, unknown>) : {}
  return typeof record.sessionID === "string" ? record.sessionID : undefined
}

describe("btw tools", () => {
  test("btw_start creates a side session, prompts with boundary + metadata, returns the answer", async () => {
    const { ctx, prompts } = createContextStub()
    const { deps } = createDepsStub()
    const tools = createBtwTools({ ctx, deps, cwd: process.cwd(), resolveSessionID })

    const result = await tools[0]!.execute(
      { question: "what did we decide about caching?" },
      { sessionID: "ses_parent" },
    )

    expect(result.content).toContain("side answer")
    expect(prompts.length).toBe(1)
    expect(prompts[0]!.sessionID).toBe("ses_side_1")
    expect(prompts[0]!.text).toContain("Side question: what did we decide about caching?")
    expect(prompts[0]!.text).toContain("Do not delegate work to subagents")
    expect(prompts[0]!.metadata?.omo_btw).toEqual({
      version: 1,
      parent_session_id: "ses_parent",
    })
  })

  test("btw_start without a parent session reports unavailability", async () => {
    const { ctx } = createContextStub()
    const { deps } = createDepsStub()
    const tools = createBtwTools({ ctx, deps, cwd: process.cwd(), resolveSessionID })

    const result = await tools[0]!.execute({ question: "q" }, {})
    expect(result.content).toContain("unavailable")
  })

  test("btw_start rejects a missing question", async () => {
    const { ctx } = createContextStub()
    const { deps } = createDepsStub()
    const tools = createBtwTools({ ctx, deps, cwd: process.cwd(), resolveSessionID })

    const result = await tools[0]!.execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("question is required")
  })

  test("btw_reply continues a known side session and tags the parent", async () => {
    const { ctx, prompts } = createContextStub()
    const { deps, waits } = createDepsStub()
    const tools = createBtwTools({ ctx, deps, cwd: process.cwd(), resolveSessionID })

    await tools[0]!.execute({ question: "first" }, { sessionID: "ses_parent" })
    const reply = await tools[1]!.execute(
      { side_session_id: "ses_side_1", text: "and the second part?" },
      {},
    )

    expect(reply.content).toContain("side answer")
    expect(prompts.length).toBe(2)
    expect(prompts[1]!.sessionID).toBe("ses_side_1")
    expect(prompts[1]!.metadata?.omo_btw).toEqual({
      version: 1,
      parent_session_id: "ses_parent",
    })
    expect(waits).toEqual(["ses_side_1", "ses_side_1"])
  })

  test("btw_reply rejects an unknown side session", async () => {
    const { ctx } = createContextStub()
    const { deps } = createDepsStub()
    const tools = createBtwTools({ ctx, deps, cwd: process.cwd(), resolveSessionID })

    const result = await tools[1]!.execute({ side_session_id: "ses_nope", text: "hi" }, {})
    expect(result.content).toContain("Unknown BTW side conversation")
  })

  test("btw_list scopes to the current parent session", async () => {
    const { ctx } = createContextStub()
    const { deps } = createDepsStub()
    const tools = createBtwTools({ ctx, deps, cwd: process.cwd(), resolveSessionID })

    await tools[0]!.execute({ question: "one" }, { sessionID: "ses_parent_a" })
    await tools[0]!.execute({ question: "two" }, { sessionID: "ses_parent_b" })

    const listA = await tools[2]!.execute({}, { sessionID: "ses_parent_a" })
    const listC = await tools[2]!.execute({}, { sessionID: "ses_parent_c" })
    expect(listA.content).toContain("ses_side_1")
    expect(listA.content).not.toContain("ses_side_2")
    expect(listC.content).toContain("No BTW side conversations")
  })
})
