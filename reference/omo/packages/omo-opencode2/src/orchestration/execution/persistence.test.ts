import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Schema } from "effect"
import { createExecutor } from "./executor"
import { ExecutionRecord, TaskID, runKey } from "./types"
import { ExecutionError } from "./errors"

const caller = Session.ID.create()
const record: ExecutionRecord = {
  version: 1, ref: { taskID: TaskID.make("saved"), generation: 1 },
  owner: { kind: "task", callerSessionID: caller, rootSessionID: caller },
  writer: "old", sessionID: Session.ID.create(), inputID: SessionMessage.ID.create(),
  agent: Agent.ID.make("explore"), model: Model.Ref.parse("provider/model"),
  description: "saved", background: true, createdAt: 1, status: "completed", output: "retained",
}

const fixture = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "execution-persistence-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
  const values = new Map<string, Schema.Json>()
  const drained: string[] = []
  const notifications: string[] = []
  const storage: Context["storage"] = {
    get: (key) => Effect.sync(() => values.get(key)),
    set: (key, value) => Effect.sync(() => { values.set(key, value) }),
    remove: (key) => Effect.sync(() => { values.delete(key) }),
    scan: ({ prefix, after }) => Effect.sync(() => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }))
      return { entries: entries.slice(0, 1), ...(entries.length > 1 ? { next: entries[0]?.key } : {}) }
    }),
  }
  const options = {
    storage, prefix: "runs/", writer: "new", lockPath: join(dir, "writer.lock"),
    driver: {
      run: () => Effect.succeed({ status: "completed" as const, output: "new-output" }),
      drain: (saved: ExecutionRecord) => Effect.sync(() => { drained.push(saved.sessionID) }),
    },
    notify: (saved: ExecutionRecord) => Effect.sync(() => { notifications.push(runKey(saved.ref)) }),
  }
  return { values, drained, notifications, options }
})

test("#given saved terminal and unfinished records #when activating #then load every page and drain without replay", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const unfinished = { ...record, ref: { ...record.ref, generation: 2 }, status: "running" as const }
    f.values.set("runs/" + runKey(record.ref), Schema.encodeSync(ExecutionRecord)(record))
    f.values.set("runs/" + runKey(unfinished.ref), Schema.encodeSync(ExecutionRecord)(unfinished))
    const executor = yield* createExecutor(f.options)
    expect((yield* executor.wait(record.ref)).output).toBe("retained")
    expect((yield* executor.wait(unfinished.ref)).status).toBe("interrupted")
    expect(f.drained).toEqual([record.sessionID])
    expect(f.notifications).toEqual([])
  })))
})

test("#given a live writer #when another controller opens the namespace #then reject the competing writer", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    yield* createExecutor(f.options)
    const second = yield* Effect.result(Effect.scoped(createExecutor({ ...f.options, writer: "competing" })))
    expect(second._tag).toBe("Failure")
  })))
})

test("#given a completed background run #when waiting and reopening #then notify once and retain output", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
      const ref = yield* Effect.scoped(Effect.gen(function* () {
      const executor = yield* createExecutor(f.options)
      const ref = yield* executor.submit({ kind: "fresh", owner: record.owner, agent: record.agent,
        model: record.model, text: "work", description: "work", background: true })
      yield* executor.wait(ref)
      return ref
      }))
    expect(f.notifications).toEqual([runKey(ref)])
    const reopened = yield* createExecutor(f.options)
    expect((yield* reopened.wait(ref)).output).toBe("new-output")
  })))
})

test.each(["failure", "defect"] as const)("#given a notification %s #when execution completes #then retain success without interrupting the completed session", async (mode) => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const executor = yield* createExecutor({ ...f.options,
      notify: () => mode === "failure" ? Effect.fail(new ExecutionError({ code: "storage", message: "notification write unavailable" }))
        : Effect.die(new Error("notification storage defect")) })
    const ref = yield* executor.submit({ kind: "fresh", owner: record.owner, agent: record.agent,
      model: record.model, text: "work", description: "work", background: true })
    const settled = yield* executor.wait(ref)
    expect(settled.status).toBe("completed")
    expect(settled.output).toBe("new-output")
    expect(f.drained).toEqual([])
  })).pipe(Effect.timeout("3 seconds")))
})

test("#given a saved queued record #when restarting #then do not interrupt a session that was never created", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    f.values.set("runs/" + runKey(record.ref), Schema.encodeSync(ExecutionRecord)({ ...record, status: "queued" }))
    const executor = yield* createExecutor(f.options)
    expect((yield* executor.wait(record.ref)).status).toBe("interrupted")
    expect(f.drained).toEqual([])
  })))
})

test("#given generations ordered lexically by storage #when restoring managed lookup #then select the newest generation numerically", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    for (const generation of [9, 10]) {
      const saved = { ...record, ref: { ...record.ref, generation } }
      f.values.set("runs/" + runKey(saved.ref), Schema.encodeSync(ExecutionRecord)(saved))
    }
    const executor = yield* createExecutor(f.options)
    expect((yield* executor.managed(record.sessionID))?.ref.generation).toBe(10)
  })))
})
