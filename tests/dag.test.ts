import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDagController } from "../src/dag/controller"
import { canonicalJson } from "../src/dag/canonical-json"
import { fingerprint, graphFingerprint } from "../src/dag/fingerprint"
import { DagValidationError, validateDefinition } from "../src/dag/graph"
import type { DagDefinition, DagExecutionRef, DagNodeDefinition } from "../src/dag/types"
import type { DagRunner } from "../src/dag/runner"

let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function node(id: string, dependsOn: readonly string[] = []): DagNodeDefinition {
  return { id, agent: "iolaus-sisyphus", model: "openai/gpt-5.5", prompt: `run ${id}`, dependsOn }
}

function definition(nodes: readonly DagNodeDefinition[]): DagDefinition {
  return { schemaVersion: 1, name: "test", nodes, maxParallel: 2 }
}

function fakeRunner(failures = new Set<string>()): DagRunner & { readonly started: string[] } {
  const started: string[] = []
  return {
    started,
    async start(input) {
      started.push(input.node.id)
      return { nodeID: input.node.id, attempt: input.attempt, sessionID: `session-${input.node.id}-${input.attempt}` }
    },
    async wait(ref: DagExecutionRef) {
      if (failures.has(ref.nodeID)) throw new Error(`failed ${ref.nodeID}`)
      return { payload: { node: ref.nodeID, attempt: ref.attempt } }
    },
    async cancel() {},
  }
}

test("canonical JSON and graph fingerprints are stable across object ordering", () => {
  expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  const left = definition([node("a"), node("b", ["a"])])
  const right = definition([node("b", ["a"]), node("a")])
  expect(graphFingerprint(left)).toBe(graphFingerprint(right))
  expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }))
})

test("graph validation rejects cycles and unknown dependencies", () => {
  expect(() => validateDefinition(definition([node("a", ["b"]), node("b", ["a"])]))).toThrow(DagValidationError)
  expect(() => validateDefinition(definition([node("a", ["missing"])]))).toThrow("Unknown dependency")
})

test("dependency frontier starts independent roots and then unlocks descendants", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-test-"))
  const runner = fakeRunner()
  const controller = createDagController({ directory, runner })
  const run = await controller.create(definition([node("a"), node("b"), node("c", ["a"])]), "caller")
  const completed = await controller.wait(run.runID, "caller")
  expect(completed.status).toBe("completed")
  expect(runner.started).toEqual(["a", "b", "c"])
  controller.close()
})

test("failed nodes are retried by generation without rerunning completed nodes", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-test-"))
  const failures = new Set(["b"])
  const runner = fakeRunner(failures)
  const controller = createDagController({ directory, runner })
  const run = await controller.create(definition([node("a"), { ...node("b"), maxAttempts: 1 }]), "caller")
  const failed = await controller.wait(run.runID, "caller")
  expect(failed.status).toBe("failed")
  failures.clear()
  const retried = await controller.retry(run.runID, "caller")
  const completed = await controller.wait(retried.runID, "caller")
  expect(completed.status).toBe("completed")
  expect(runner.started.filter((id) => id === "a")).toHaveLength(1)
  expect(runner.started.filter((id) => id === "b")).toHaveLength(2)
  controller.close()
})

test("completed DAG state survives controller restart through SQLite WAL", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-test-"))
  const first = createDagController({ directory, runner: fakeRunner() })
  const run = await first.create(definition([node("a")]), "caller")
  await first.wait(run.runID, "caller")
  first.close()

  const second = createDagController({ directory, runner: fakeRunner() })
  const restored = await second.snapshot(run.runID, "caller")
  expect(restored.run.status).toBe("completed")
  expect(restored.run.nodes[0]?.result?.payload).toEqual({ node: "a", attempt: 1 })
  expect(restored.events.some((event) => event.type === "node.completed")).toBe(true)
  second.close()
})
