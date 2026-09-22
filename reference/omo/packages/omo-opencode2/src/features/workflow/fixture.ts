import { Model } from "@opencode/schema/model"
import { Effect, Schema } from "effect"
import { fixture as executionFixture } from "../../orchestration/execution/test-fixture"
import { createWorkflow } from "./runtime"
import { Node } from "./types"

export { caller } from "../../orchestration/execution/test-fixture"
export const node = (id: string, dependsOn: readonly string[] = []) => Schema.decodeUnknownSync(Node)({
  id, dependsOn, prompt: id, agent: "build", model: Model.Ref.parse("openai/test"),
})

export const fixture = Effect.gen(function* () {
  const { storage, started, launches, values, executor } = yield* executionFixture
  const options = { executor, storage, prefix: "workflow/", agents: new Set(["build"]) }
  const workflow = yield* createWorkflow(options)
  return { workflow, options, started, launches, values, executor }
})
