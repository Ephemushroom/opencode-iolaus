import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Deferred, Effect, Queue, type Schema } from "effect"
import { createExecutor } from "./executor"
import type { Settlement } from "./runtime"

export const caller = Session.ID.create()

export const fixture = Effect.gen(function* () {
  const values = new Map<string, Schema.Json>()
  const storage: Context["storage"] = {
    get: (key) => Effect.sync(() => values.get(key)),
    set: (key, value) => Effect.sync(() => { values.set(key, structuredClone(value)) }),
    remove: (key) => Effect.sync(() => { values.delete(key) }),
    scan: ({ prefix }) => Effect.sync(() => ({ entries: [...values]
      .filter(([key]) => key.startsWith(prefix ?? "")).map(([key, value]) => ({ key, value })) })),
  }
  const started = yield* Queue.unbounded<{ readonly id: string; readonly text: string; readonly finish: Deferred.Deferred<Settlement> }>()
  const launches: string[] = []
  const executor = yield* createExecutor({
    prefix: "execution/", writer: "test", storage, limits: { model: 2, team: 2 },
    driver: {
      run: (record, request) => Effect.gen(function* () {
        const finish = yield* Deferred.make<Settlement>()
        launches.push(record.description)
        yield* Queue.offer(started, { id: record.description, text: request.text, finish })
        return yield* Deferred.await(finish)
      }),
      drain: () => Effect.void,
    },
  })
  return { storage, started, launches, values, executor }
})
