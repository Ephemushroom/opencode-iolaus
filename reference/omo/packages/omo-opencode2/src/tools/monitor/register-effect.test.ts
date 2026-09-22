import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Stream } from "effect"
import { registerMonitorToolsEffect } from "./register"

const sessionID = Session.ID.make("ses_monitor_native")
const toolContext: Tool.Context = {
  sessionID, agent: Agent.ID.make("sisyphus"),
  messageID: SessionMessage.ID.make("msg_monitor"), id: Tool.CallID.make("call-monitor"),
  progress: () => Effect.void,
}

function fixture(options: Context["options"]) {
  const tools: Tool.Info[] = []
  const calls: string[] = []
  const delivered = Promise.withResolvers<void>()
  const unexpected = () => Effect.die("unexpected host operation")
  const ctx: Pick<Context, "options" | "session" | "event"> & { readonly tool: Pick<Context["tool"], "transform"> } = {
    options,
    session: {
      create: unexpected, get: unexpected, switchAgent: unexpected, switchModel: unexpected,
      prompt: unexpected, generate: unexpected, command: unexpected, interrupt: unexpected,
      rename: unexpected, move: unexpected, wait: unexpected, context: unexpected,
      hook: () => Effect.succeed({ dispose: Effect.void }),
      synthetic: (input) => Effect.sync(() => { calls.push(input.sessionID); delivered.resolve() }).pipe(Effect.flatMap(unexpected)),
    },
    tool: { transform: (transform) => Effect.sync(() => {
      transform({ add: (tool) => { tools.push(tool) }, list: () => [], get: () => undefined,
        namespace: () => undefined, update: () => undefined, remove: () => undefined })
      return { dispose: Effect.void }
    }) },
    event: { subscribe: () => Stream.never },
  }
  return { ctx, tools, calls, delivered }
}

describe("native monitor registration", () => {
  test.each([
    { monitor: { enabled: false } },
    { monitor: { enabled: true }, disabled_hooks: ["monitor"] },
  ])("#given disabled config %j #when registered #then tools remain absent", async (options) => {
    const f = fixture(options)
    const result = await Effect.runPromise(Effect.scoped(registerMonitorToolsEffect(f.ctx, { cwd: process.cwd() })))
    expect(result).toBeUndefined()
    expect(f.tools).toEqual([])
  })

  test("#given an empty allowlist #when monitor_start executes #then no process starts", async () => {
    const f = fixture({ monitor: { enabled: true, allowed_commands: [] } })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const registration = yield* registerMonitorToolsEffect(f.ctx, { cwd: process.cwd() })
      const start = f.tools.find((tool) => tool.name === "monitor_start")
      if (!start || !registration) throw new Error("monitor not registered")
      const result = yield* start.execute({ command: "bun --version" }, toolContext)
      expect(result.content).toContain("denied")
      expect(registration.manager.list(sessionID)).toEqual([])
      expect(f.tools.map((tool) => tool.name)).toEqual(["monitor_start", "monitor_stop", "monitor_list", "monitor_output"])
    })))
  })

  test.each([true, false])("#given managed routing returns %s #when a real watcher emits #then delivery uses the selected owner and shutdown stops it", async (managed) => {
    const f = fixture({ monitor: { enabled: true, allowed_commands: ["bun"], batch_max_lines: 1 } })
    const routed = Promise.withResolvers<void>()
    const managedCalls: string[] = []
    const registration = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const registered = yield* registerMonitorToolsEffect(f.ctx, {
        cwd: process.cwd(),
        dispatchManaged: (input) => Effect.sync(() => {
          managedCalls.push(input.sessionID)
          if (managed) routed.resolve()
          return managed
        }),
      })
      const start = f.tools.find((tool) => tool.name === "monitor_start")
      if (!start || !registered) throw new Error("monitor not registered")
      yield* start.execute({ command: "bun -e 'console.log(42); setInterval(() => {}, 1000)'" }, toolContext)
      yield* Effect.promise(() => managed ? routed.promise : f.delivered.promise)
      return registered
    })))
    expect(managedCalls).toEqual([sessionID])
    expect(f.calls).toEqual(managed ? [] : [sessionID])
    expect(registration.manager.list(sessionID)).toEqual([])
  })
})
