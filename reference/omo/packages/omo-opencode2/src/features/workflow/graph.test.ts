import { expect, test } from "bun:test"
import { Schema, Effect } from "effect"
import { Model } from "@opencode/schema/model"
import { validateGraph } from "./graph"
import { Node } from "./types"

const node = (id: string, dependsOn: readonly string[] = []) => Schema.decodeUnknownSync(Node)({
  id, dependsOn, prompt: id, agent: "build", model: Model.Ref.parse("openai/test"),
})

for (const [code, nodes] of [
  ["empty", []],
  ["duplicate", [node("a"), node("a")]],
  ["unknown-dependency", [node("a", ["missing"])]],
  ["self-dependency", [node("a", ["a"])]],
  ["cycle", [node("a", ["b"]), node("b", ["c"]), node("c", ["a"])]],
] as const) {
  test(`#given ${code} graph #when validating #then reject before execution`, async () => {
    const result = await Effect.runPromise(Effect.result(validateGraph(nodes)))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe(code)
  })
}

test("#given an unordered diamond #when validating #then accept the acyclic graph", async () => {
  const result = await Effect.runPromise(Effect.result(validateGraph([
    node("join", ["left", "right"]), node("right", ["root"]), node("root"), node("left", ["root"]),
  ])))
  expect(result._tag).toBe("Success")
})
