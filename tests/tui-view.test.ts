import { expect, test } from "bun:test"
import { activityLine, depths, elapsed, orderNodes, progressBar, settledCount, statusColor, statusGlyph, summarize, type DagViewRun } from "../src/tui/view"

const theme = { success: "green", warning: "yellow", accent: "purple", error: "red", textMuted: "gray", text: "white" }
const node = (id: string, status: string, dependsOn: string[] = [], extra: Partial<DagViewRun["nodes"][number]> = {}) =>
  ({ id, status, kind: "agent", agent: "iolaus-sisyphus", model: "openai/gpt-5.5", attempt: 1, dependsOn, ...extra })
const run: DagViewRun = { runID: "r1", name: "plan-review: task", generation: 2, status: "paused", updatedAt: 0, nodes: [
  node("plan", "completed"), node("review", "completed", ["plan"], { kind: "judge" }), node("revise", "skipped", ["review"]),
  node("approve", "waiting_approval", ["review", "rereview"], { kind: "gate", prompt: "Approve?" }), node("execute", "pending", ["approve"]),
] }

test("glyphs and colours map every status; unknown falls back to text", () => {
  expect(statusGlyph("completed")).toBe("✓"); expect(statusGlyph("running")).toBe("▶"); expect(statusGlyph("waiting_approval")).toBe("⏸")
  expect(statusGlyph("failed")).toBe("✗"); expect(statusGlyph("skipped")).toBe("↷"); expect(statusGlyph("weird")).toBe("·")
  expect(statusColor("completed", theme)).toBe("green"); expect(statusColor("running", theme)).toBe("yellow")
  expect(statusColor("waiting_approval", theme)).toBe("purple"); expect(statusColor("failed", theme)).toBe("red")
  expect(statusColor("pending", theme)).toBe("gray"); expect(statusColor("weird", theme)).toBe("white")
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
