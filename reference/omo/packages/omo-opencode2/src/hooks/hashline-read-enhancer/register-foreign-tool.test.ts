/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test"
import { registerHashlineReadEnhancer } from "./register"

type HookHandler = (event: unknown) => unknown

function createCapturingContext(): { ctx: unknown; handler: () => HookHandler } {
  let captured: HookHandler | undefined
  const ctx = {
    tool: {
      hook: async (_name: string, callback: HookHandler) => {
        captured = callback
      },
    },
  }
  return {
    ctx,
    handler: () => {
      if (!captured) throw new Error("execute.after handler was never registered")
      return captured
    },
  }
}

describe("registerHashlineReadEnhancer on foreign tool results", () => {
  describe("#given an execute.after event for a non-read tool whose result is undefined", () => {
    it("#when the hook runs #then it returns without dereferencing the missing result", async () => {
      // given
      const { ctx, handler } = createCapturingContext()
      await registerHashlineReadEnhancer(ctx as Parameters<typeof registerHashlineReadEnhancer>[0])
      const event = { tool: "edit", status: "error", sessionID: "ses_test" }

      // when
      const run = () => handler()(event)

      // then
      expect(run).not.toThrow()
    })
  })

  describe("#given a completed non-read tool that reports no content", () => {
    it("#when the hook runs #then it leaves the result untouched and does not throw", async () => {
      // given
      const { ctx, handler } = createCapturingContext()
      await registerHashlineReadEnhancer(ctx as Parameters<typeof registerHashlineReadEnhancer>[0])
      const event = { tool: "bash", status: "completed", sessionID: "ses_test", result: {} }

      // when
      const run = () => handler()(event)

      // then
      expect(run).not.toThrow()
      expect(event.result).toEqual({})
    })
  })
})
