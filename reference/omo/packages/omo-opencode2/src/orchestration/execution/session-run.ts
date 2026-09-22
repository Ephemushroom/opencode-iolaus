import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ExecutionError, hostError } from "./errors"
import type { ExecutionDriver, Settlement } from "./runtime"
import { assertNever } from "./types"

export function createSessionDriver(ctx: Pick<Context, "session">): ExecutionDriver {
  return {
    run: (record, request) => Effect.gen(function* () {
      switch (request.kind) {
        case "fresh":
          yield* ctx.session.create({ id: record.sessionID, agent: record.agent, model: record.model, title: record.description }).pipe(Effect.mapError(hostError))
          break
        case "continuation":
        case "message":
          yield* ctx.session.wait({ sessionID: record.sessionID }).pipe(Effect.mapError(hostError))
          yield* ctx.session.switchModel({ sessionID: record.sessionID, model: record.model }).pipe(Effect.mapError(hostError))
          break
        default: return assertNever(request)
      }
      yield* ctx.session.prompt({
        sessionID: record.sessionID, id: record.inputID, text: request.text,
        metadata: request.metadata, delivery: "queue",
      }).pipe(Effect.mapError(hostError))
      yield* ctx.session.wait({ sessionID: record.sessionID }).pipe(Effect.mapError(hostError))
      const session = yield* ctx.session.get({ sessionID: record.sessionID }).pipe(Effect.mapError(hostError))
      const messages = yield* ctx.session.context({ sessionID: record.sessionID }).pipe(Effect.mapError(hostError))
      const boundary = messages.findIndex((message) => message.id === record.inputID)
      if (boundary < 0 || session.outcome === undefined) {
        return yield* new ExecutionError({ code: "host", message: "Host did not establish the admitted input's terminal outcome" })
      }
      const output = messages.slice(boundary + 1).flatMap((message) => message.type === "assistant"
        ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n").slice(-65536)
      switch (session.outcome) {
        case "succeeded": return { status: "completed", output } satisfies Settlement
        case "failed": return { status: "failed", output, reason: "Host execution failed" } satisfies Settlement
        case "interrupted": return { status: "interrupted", output, reason: "Host execution interrupted" } satisfies Settlement
        default: return assertNever(session.outcome)
      }
    }),
    drain: (record) => Effect.gen(function* () {
      yield* ctx.session.interrupt({ sessionID: record.sessionID }).pipe(Effect.mapError(hostError))
      yield* ctx.session.wait({ sessionID: record.sessionID }).pipe(Effect.mapError(hostError))
    }),
  }
}
