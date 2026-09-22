import { describe, expect, test } from "bun:test"

import { registerBtwToolGuard } from "./tool-guard"
import type { Context } from "@opencode/plugin/promise/plugin"
type Message = { role: string; content: unknown[]; metadata?: Record<string, unknown> }

type ContextEvent = {
  sessionID: string
  messages: Message[]
  tools: Record<string, { description: string; input: unknown }>
}

function userMessage(metadata?: Record<string, unknown>): Message {
  return {
    role: "user",
    content: [{ type: "text", text: "q" }],
    ...(metadata ? { metadata } : {}),
  } as unknown as Message
}

function createContext(): { ctx: Context; events: ContextEvent[] } {
  const events: ContextEvent[] = []
  const ctx = {
    session: {
      hook: (name: string, callback: (event: ContextEvent) => void | Promise<void>) => {
        events.push({ sessionID: "ses_x", messages: [], tools: {} })
        // The registry pattern: run the callback against the last event pushed.
        const target = { get events() { return events }, run: (event: ContextEvent) => callback(event) }
        ;(ctx as unknown as Record<string, unknown>)["__run"] = target.run
        return Promise.resolve({ dispose: () => undefined })
      },
    },
    options: {},
  } as unknown as Context
  return { ctx, events }
}

function fire(ctx: Context, event: ContextEvent): void {
  const run = (ctx as unknown as Record<string, unknown>)["__run"] as (event: ContextEvent) => void
  run(event)
}

const ALL_TOOLS = {
  task: { description: "d", input: {} },
  btw_start: { description: "d", input: {} },
  monitor_start: { description: "d", input: {} },
  read: { description: "d", input: {} },
  edit: { description: "d", input: {} },
}

describe("btw tool guard", () => {
  test("strips delegation tools from a tagged side session", async () => {
    const { ctx } = createContext()
    await registerBtwToolGuard(ctx)

    const tools = { ...ALL_TOOLS }
    fire(ctx, {
      sessionID: "ses_side",
      messages: [userMessage({ omo_btw: { version: 1, parent_session_id: "ses_parent" } })],
      tools,
    })

    expect(tools.task).toBeUndefined()
    expect(tools.btw_start).toBeUndefined()
    expect(tools.monitor_start).toBeUndefined()
    expect(tools.read).toBeDefined()
    expect(tools.edit).toBeDefined()
  })

  test("leaves a normal session untouched", async () => {
    const { ctx } = createContext()
    await registerBtwToolGuard(ctx)

    const tools = { ...ALL_TOOLS }
    fire(ctx, {
      sessionID: "ses_main",
      messages: [userMessage()],
      tools,
    })

    expect(tools.task).toBeDefined()
    expect(tools.btw_start).toBeDefined()
  })

  test("ignores a malformed omo_btw tag", async () => {
    const { ctx } = createContext()
    await registerBtwToolGuard(ctx)

    const tools = { ...ALL_TOOLS }
    fire(ctx, {
      sessionID: "ses_main",
      messages: [userMessage({ omo_btw: { version: 9 } })],
      tools,
    })

    expect(tools.task).toBeDefined()
  })

  test("assistant-only history is not treated as tagged", async () => {
    const { ctx } = createContext()
    await registerBtwToolGuard(ctx)

    const tools = { ...ALL_TOOLS }
    fire(ctx, {
      sessionID: "ses_main",
      messages: [
        userMessage({ omo_btw: { version: 1, parent_session_id: "ses_parent" } }),
        { role: "assistant", content: [{ type: "text", text: "a" }] } as unknown as Message,
      ],
      tools,
    })

    // The first (and only) user message carries the tag -> still a side session.
    expect(tools.task).toBeUndefined()
  })
})
