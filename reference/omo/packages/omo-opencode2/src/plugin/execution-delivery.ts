import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Effect, type Schema } from "effect"
import { hostError } from "../orchestration/execution/errors"
import type { Executor } from "../orchestration/execution/types"

type Delivery = {
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly metadata?: Readonly<Record<string, Schema.Json>>
  readonly id?: SessionMessage.ID
}

export function createExecutionDelivery(
  ctx: { readonly session: Pick<Context["session"], "synthetic"> },
  ready: Effect.Effect<Executor>,
) {
  const managed = (input: Delivery) => Effect.gen(function* () {
    const executor = yield* ready
    const record = yield* executor.managed(Session.ID.make(input.sessionID))
    if (!record) return false
    yield* executor.submit({
      kind: "message", previous: record.ref, owner: record.owner,
      text: input.text, description: input.description, metadata: input.metadata,
      inputID: input.id, background: false,
    })
    return true
  })
  return {
    managed,
    dispatch: (input: Delivery) => Effect.gen(function* () {
      if (yield* managed(input)) return
      yield* ctx.session.synthetic({ ...input, sessionID: Session.ID.make(input.sessionID),
        delivery: "queue", resume: true }).pipe(Effect.mapError(hostError))
    }),
  }
}
