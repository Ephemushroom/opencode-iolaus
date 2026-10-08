import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { createDagController as createEffectController } from "../src/dag/controller"
import { dagView, nodeSummary, resultExcerpt, viewNodeStatus } from "../src/dag/register-rpc"
import { DagStore } from "../src/dag/store"
import type { DagExecutionRef, DagRunRecord } from "../src/dag/types"
import { runnerFromPromise } from "../src/dag/runner"

let directory: string | undefined
function createDagController(options: Parameters<typeof createEffectController>[0]) {
  return createEffectController({ ...options, databasePath: options.databasePath ?? join(options.directory, "iolaus.db") })
}
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

test("a node's title wins; otherwise the first meaningful prompt line summarises it", () => {
  expect(nodeSummary("设计更好的 UI 界面", "<iolaus-mode:ultrawork>\nlong prompt")).toBe("设计更好的 UI 界面")
  expect(nodeSummary(undefined, "<iolaus-mode:ultrawork>\n<iolaus-dag-child>\nAchieve this goal end to end.")).toBe("Achieve this goal end to end.")
  expect(nodeSummary(undefined, "TASK: Read-only recommend a design")).toBe("Read-only recommend a design")
  expect(nodeSummary("  ", "")).toBeUndefined()
})

test("a long reply is cut inside its text, so the excerpt stays JSON the dialog renders as Markdown", () => {
  const parsed = JSON.parse(resultExcerpt({ text: `# Report\n${"x".repeat(20000)}` }))
  expect(parsed.text.startsWith("# Report\n")).toBe(true)
  expect(parsed.text.endsWith("…")).toBe(true)
  expect(parsed.text.length).toBe(16001)
  expect(resultExcerpt({ text: "short" })).toBe('{"text":"short"}')
  expect(resultExcerpt({ decision: "x".repeat(20000) })).toHaveLength(16000)
})

test("a finished run never reports nodes as in flight", () => {
  expect(viewNodeStatus("cancelled", "starting")).toBe("cancelled")
  expect(viewNodeStatus("failed", "running")).toBe("interrupted")
  expect(viewNodeStatus("running", "running")).toBe("running")
  expect(viewNodeStatus("completed", "completed")).toBe("completed")
})

test("cancel settles running nodes, a late child outcome cannot reopen them, and the view carries titles", async () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-dag-view-"))
  const release = Promise.withResolvers<void>()
  const runner = runnerFromPromise({
    async start(input) { return { nodeID: input.node.id, attempt: input.attempt, sessionID: `s-${input.node.id}` } },
    async wait(_ref: DagExecutionRef) { await release.promise; return { payload: { text: "late" } } },
    async cancel() {},
  })
  const controller = createDagController({ directory, runner })
  const run = await Effect.runPromise(controller.create({ schemaVersion: 1, name: "t", nodes: [
    { id: "design", title: "设计更好的 UI 界面", agent: "sisyphus", model: "p/m", prompt: "do it", dependsOn: [] },
    { id: "build", agent: "sisyphus", model: "p/m", prompt: "GOAL:\nBuild the thing", dependsOn: ["design"] },
  ] }, "owner"))
  await new Promise((done) => setTimeout(done, 30))
  const cancelled = await Effect.runPromise(controller.cancel(run.runID, "owner"))
  expect(cancelled.nodes.map((node) => node.status)).toEqual(["cancelled", "cancelled"])
  release.resolve()
  await new Promise((done) => setTimeout(done, 30))
  const view = await Effect.runPromise(dagView(controller, "owner"))
  expect(view.runs[0].status).toBe("cancelled")
  expect(view.runs[0].nodes.map((node) => [node.id, node.status, node.title]).sort()).toEqual([["build", "cancelled", "Build the thing"], ["design", "cancelled", "设计更好的 UI 界面"]])
  expect(typeof view.runs[0].createdAt).toBe("number")
  await Effect.runPromise(controller.close)

  // Rows written by an older build (cancelled run, node still "starting") are shown settled.
  const store = new DagStore(join(directory, "iolaus.db"), directory)
  const legacy = store.getRun(run.runID)!
  store.saveRun({ ...legacy, nodes: legacy.nodes.map((node) => ({ ...node, status: "starting" })) } as DagRunRecord)
  store.close()
  const reopened = createDagController({ directory, runner })
  const again = await Effect.runPromise(dagView(reopened, "owner"))
  expect(again.runs[0].nodes.every((node) => node.status === "cancelled")).toBe(true)
  await Effect.runPromise(reopened.close)
})
