import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { caller, fixture, node } from "./fixture"
import { createWorkflowTool, WorkflowInput } from "./tool"

test("#given malformed tool input #when decoding the boundary #then refuse missing node fields", async () => {
  const result = await Effect.runPromise(Effect.result(Schema.decodeUnknownEffect(WorkflowInput)({
    action: "start", key: "bad", nodes: [{ id: "a" }],
  })))
  expect(result._tag).toBe("Failure")
})

test("#given a cyclic graph #when executing the native tool #then return Tool.Error and launch nothing", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture
    const tool = createWorkflowTool(f.workflow)
    const result = yield* Effect.result(tool.execute({ action: "start", key: "cycle", nodes: [
      { id: "a", prompt: "a", agent: "build", model: "openai/test", dependsOn: ["b"] },
      { id: "b", prompt: "b", agent: "build", model: "openai/test", dependsOn: ["a"] },
    ] }, {
      sessionID: caller, agent: Agent.ID.make("build"), messageID: SessionMessage.ID.create(),
      id: Tool.CallID.make("workflow-test"), progress: () => Effect.void,
    }))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(Tool.Error)
    expect(yield* f.executor.list()).toEqual([])
    expect(f.values.size).toBe(0)
  })))
})
