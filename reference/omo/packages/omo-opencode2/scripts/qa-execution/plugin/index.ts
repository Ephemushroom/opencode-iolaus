import { appendFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Effect, Schema } from "effect"
import { createExecutor } from "../../../src/orchestration/execution/executor"
import { createSessionDriver } from "../../../src/orchestration/execution/session-run"
import { RunRef } from "../../../src/orchestration/execution/types"

const Input = Schema.Union([
  Schema.Struct({ action: Schema.Literal("submit"), text: Schema.String, team: Schema.optional(Schema.String) }),
  Schema.Struct({ action: Schema.Literals(["wait", "snapshot", "cancel"]), ref: RunRef }),
])

export default Plugin.define({
  id: "omo-execution-qa",
  effect: (ctx) => Effect.gen(function* () {
    const trace = process.env.OMO_SPIKE_TRACE
    if (!trace) return yield* Effect.die(new Error("QA trace path is required"))
    const executor = yield* createExecutor({
      driver: createSessionDriver(ctx), storage: ctx.storage,
      prefix: "qa-execution/", writer: "isolated-qa", limits: { model: 2, team: 1 },
    })
    yield* ctx.command.transform((editor) => editor.add({
      name: "qa-execution", description: "Isolated executor verification transport",
      execute: (invocation) => Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Input))(invocation.prompt.text)
        let result
        switch (input.action) {
          case "submit": {
            const caller = { callerSessionID: invocation.sessionID, rootSessionID: invocation.sessionID }
            const ref = yield* executor.submit({ kind: "fresh", text: input.text, description: input.text,
              agent: Agent.ID.make("build"), model: Model.Ref.parse("openai/gpt-explore"), background: true,
              owner: input.team ? { kind: "team", ...caller, teamRunID: input.team, member: input.text } : { kind: "task", ...caller },
            })
            result = yield* executor.snapshot(ref)
            break
          }
          case "snapshot": result = yield* executor.snapshot(input.ref); break
          case "wait": result = yield* executor.wait(input.ref); break
          case "cancel": yield* executor.cancel(input.ref); result = yield* executor.snapshot(input.ref); break
        }
        yield* Effect.sync(() => appendFileSync(trace, JSON.stringify({ action: input.action, result }) + "\n"))
      }),
    }))
    yield* Effect.addFinalizer(() => Effect.sync(() => appendFileSync(trace, JSON.stringify({ action: "scope-closed" }) + "\n")))
  }).pipe(Effect.orDie),
})
