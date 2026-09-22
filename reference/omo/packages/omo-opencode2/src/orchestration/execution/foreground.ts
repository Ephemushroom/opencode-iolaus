import { Effect, Exit } from "effect"
import type { Executor, SubmitRequest } from "./types"

export function runForeground(executor: Executor, request: SubmitRequest, timeoutMs: number) {
  return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const ref = yield* executor.submit(request)
    const record = yield* restore(executor.wait(ref).pipe(Effect.timeout(timeoutMs))).pipe(
      Effect.onExit((exit) => Exit.isFailure(exit)
        ? executor.cancel(ref).pipe(Effect.andThen(executor.wait(ref)), Effect.asVoid, Effect.orDie)
        : Effect.void),
    )
    return { ref, record }
  }))
}
