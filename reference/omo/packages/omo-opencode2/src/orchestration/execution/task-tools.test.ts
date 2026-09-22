import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Queue, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { caller, fixture } from "./test-fixture"
import { createExecutionTaskTools, TaskInput } from "./task-tools"
import type { ConfiguredAgentRegistration } from "../../agents/register-configured"

const agents: ConfiguredAgentRegistration = {
  primaries: new Set(["sisyphus"]), subagents: new Set(["explore"]), categories: new Set(["quick"]),
  sisyphusPrompt: undefined, models: new Map([["explore", "openai/test"], ["quick", "openai/test"]]),
}

test("#given shipped task arguments #when decoding #then no replacement agent/model/background fields are required", () => {
  const input = { prompt: "inspect", category: "quick", load_skills: ["skill-a"], run_in_background: true }
  expect(Schema.decodeUnknownSync(TaskInput)(input)).toEqual(input)
})

test("#given a held child #when background task submits #then task_id is returned and output reads without waiting", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const tools = createExecutionTaskTools(f.executor, agents)
    const accepted = yield* tools.task.execute({ prompt: "held", subagent_type: "explore", run_in_background: true }, { sessionID: caller })
    const records = yield* f.executor.list()
    const record = records[0]
    if (!record) throw new Error("Expected saved task")
    expect(accepted.content).toContain(record.ref.taskID)
    const running = yield* tools.output.execute({ task_id: record.ref.taskID }, { sessionID: caller })
    expect(running.content).toContain("is still")
    const child = yield* Queue.take(f.started)
    yield* Deferred.succeed(child.finish, { status: "completed", output: "child-result" })
    yield* f.executor.wait(record.ref)
    const output = yield* tools.output.execute({ task_id: record.ref.taskID }, { sessionID: caller })
    expect(output.content).toContain("child-result")
  })).pipe(Effect.timeout("3 seconds")))
})

test("#given a foreground category task #when its child completes #then the caller receives its result and requested skills", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const tools = createExecutionTaskTools(f.executor, agents)
    const pending = yield* Effect.forkChild(tools.task.execute({ prompt: "inspect", category: "quick", load_skills: ["skill-a"] }, { sessionID: caller }))
    const child = yield* Queue.take(f.started)
    expect(child.text).toContain("skill-a")
    yield* Deferred.succeed(child.finish, { status: "completed", output: "category-result" })
    expect((yield* Fiber.join(pending)).content).toContain("category-result")
  })).pipe(Effect.timeout("3 seconds")))
})

test("#given a failed foreground child #when a fallback model exists #then Executor admits one replacement run", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const tools = createExecutionTaskTools(f.executor, agents)
    const pending = yield* Effect.forkChild(tools.task.execute({ prompt: "fallback", subagent_type: "explore" }, { sessionID: caller }))
    const first = yield* Queue.take(f.started)
    yield* Deferred.succeed(first.finish, { status: "failed", output: "provider failed", reason: "provider failed" })
    const replacement = yield* Queue.take(f.started)
    yield* Deferred.succeed(replacement.finish, { status: "completed", output: "fallback result" })
    expect((yield* Fiber.join(pending)).content).toContain("fallback result")
    const records = yield* f.executor.list()
    expect(records).toHaveLength(2)
    expect(records[0]?.model).not.toEqual(records[1]?.model)
  })).pipe(Effect.timeout("3 seconds")))
})

test("#given a running foreground child #when the caller interrupts #then cancellation drains the Executor run", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const tools = createExecutionTaskTools(f.executor, agents)
    const pending = yield* Effect.forkChild(tools.task.execute({ prompt: "interrupt", category: "quick" }, { sessionID: caller }))
    const child = yield* Queue.take(f.started)
    yield* Fiber.interrupt(pending)
    yield* Deferred.succeed(child.finish, { status: "completed", output: "late" })
    const record = (yield* f.executor.list())[0]
    if (!record) throw new Error("Expected drained task")
    expect((yield* f.executor.snapshot(record.ref)).status).toBe("cancelled")
  })).pipe(Effect.timeout("3 seconds")))
})

test("#given another caller's task #when reading cancelling or continuing #then deny without modifying it", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const tools = createExecutionTaskTools(f.executor, agents)
    yield* tools.task.execute({ prompt: "held", category: "quick", run_in_background: true }, { sessionID: caller })
    const record = (yield* f.executor.list())[0]
    if (!record) throw new Error("Expected task")
    const stranger = { sessionID: Session.ID.create() }
    for (const action of [tools.output.execute, tools.cancel.execute]) {
      expect((yield* Effect.result(action({ task_id: record.ref.taskID }, stranger)))._tag).toBe("Failure")
    }
    expect((yield* Effect.result(tools.task.execute({ prompt: "continue", task_id: record.ref.taskID }, stranger)))._tag).toBe("Failure")
    expect((yield* f.executor.list())).toHaveLength(1)
    expect((yield* f.executor.snapshot(record.ref)).status).not.toBe("cancelled")
  })).pipe(Effect.timeout("3 seconds")))
})

test("#given invalid task routing #when submitting #then reject before creating any child", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const tools = createExecutionTaskTools(f.executor, agents)
    for (const input of [{ prompt: "work" }, { prompt: "work", category: "quick", subagent_type: "explore" }, { prompt: "work", subagent_type: "sisyphus" }]) {
      expect((yield* Effect.result(tools.task.execute(input, { sessionID: caller })))._tag).toBe("Failure")
    }
    expect(yield* f.executor.list()).toEqual([])
  })))
})
