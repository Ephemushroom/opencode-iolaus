import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { activityLine, depths, elapsed, nodeResultText, orderNodes, progressBar, settledCount, statusColor, statusGlyph, summarize, topologyNodes, type DagViewRun } from "../src/tui/view"

const theme = { text: {
  base: RGBA.fromHex("#202020"), muted: RGBA.fromHex("#666666"),
  action: { primary: { base: RGBA.fromHex("#0055aa") } },
  feedback: { success: { base: RGBA.fromHex("#008800") }, warning: { base: RGBA.fromHex("#886600") }, error: { base: RGBA.fromHex("#cc0000") } },
} }
const node = (id: string, status: string, dependsOn: string[] = [], extra: Partial<DagViewRun["nodes"][number]> = {}) =>
  ({ id, status, kind: "agent", agent: "sisyphus", model: "openai/gpt-5.5", attempt: 1, dependsOn, ...extra })
const run: DagViewRun = { runID: "r1", name: "plan-review: task", generation: 2, status: "paused", updatedAt: 0, nodes: [
  node("plan", "completed"), node("review", "completed", ["plan"], { kind: "judge" }), node("revise", "skipped", ["review"]),
  node("approve", "waiting_approval", ["review", "rereview"], { kind: "gate", prompt: "Approve?" }), node("execute", "pending", ["approve"]),
] }

test("glyphs and colours map every status; unknown falls back to text", () => {
  expect(statusGlyph("completed")).toBe("✓"); expect(statusGlyph("running")).toBe("▶"); expect(statusGlyph("waiting_approval")).toBe("⏸")
  expect(statusGlyph("failed")).toBe("✗"); expect(statusGlyph("skipped")).toBe("↷"); expect(statusGlyph("weird")).toBe("·")
  expect(statusColor("completed", theme)).toBe(theme.text.feedback.success.base); expect(statusColor("running", theme)).toBe(theme.text.feedback.warning.base)
  expect(statusColor("waiting_approval", theme)).toBe(theme.text.action.primary.base); expect(statusColor("failed", theme)).toBe(theme.text.feedback.error.base)
  expect(statusColor("pending", theme)).toBe(theme.text.muted); expect(statusColor("weird", theme)).toBe(theme.text.base)
})

test("progress, depth, ordering and summary are derived from the run", () => {
  expect(settledCount(run)).toBe(3)
  expect(progressBar(3, 5, 10)).toBe("[██████░░░░] 3/5")
  expect(progressBar(0, 0, 4)).toBe("[    ] 0/0")
  const d = depths(run)
  expect([d.get("plan"), d.get("review"), d.get("revise"), d.get("approve"), d.get("execute")]).toEqual([0, 1, 2, 2, 3])
  expect(orderNodes(run).map((n) => n.id)[0]).toBe("approve")
  expect(summarize([run]).text).toBe("DAG · 1 run · 1 waiting approval")
  expect(summarize([]).text).toBe("DAG · idle")
  expect(summarize([{ ...run, status: "running" }, { ...run, runID: "r2", status: "failed" }]).text).toBe("DAG · 2 runs · 1 running · 1 failed")
})

test("activity line and elapsed formatting", () => {
  expect(activityLine("  Checking\n scenario 3   now ", 20)).toBe("Checking scenario 3…")
  expect(activityLine("short")).toBe("short"); expect(activityLine("   ")).toBeUndefined(); expect(activityLine(undefined)).toBeUndefined()
  expect(elapsed(1000, 46_000)).toBe("45s"); expect(elapsed(0, 100_000)).toBe(""); expect(elapsed(1, 125_001)).toBe("2m 5s"); expect(elapsed(1, 3_660_001)).toBe("1h 1m")
})

test("dialog ordering keeps both fan-in parents before their descendant regardless of status", () => {
  const graph: DagViewRun = { ...run, nodes: [node("join", "running", ["left", "right"]), node("right", "failed", ["root"]), node("root", "completed"), node("left", "completed", ["root"])] }
  expect(topologyNodes(graph).map((node) => node.id)).toEqual(["root", "right", "left", "join"])
  expect(topologyNodes(graph).at(-1)?.dependsOn).toEqual(["left", "right"])
})

test("dialog result excerpts show plain text and preserve structured or truncated data", () => {
  expect(nodeResultText('{"text":"line one\\nline two"}')).toBe("line one\nline two")
  expect(nodeResultText('{"decision":"approved"}')).toBe('{"decision":"approved"}')
  expect(nodeResultText('{"text":"truncated')).toBe('{"text":"truncated')
  expect(nodeResultText("null")).toBe("null")
})
