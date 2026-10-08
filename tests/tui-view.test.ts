import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { activityLine, borderTitle, connector, depths, elapsed, kindMark, labelColor, liveGlyph, nodeResult, orderNodes, partitionRuns, progressBar, resultLabel, rowStart, runActivity, runClock, runHeadline, statusLabel, waves, settledCount, statusColor, statusGlyph, summarize, topologyNodes, type DagViewRun } from "../src/tui/view"

const theme = { text: {
  base: RGBA.fromHex("#202020"), muted: RGBA.fromHex("#666666"),
  action: { primary: { base: RGBA.fromHex("#0055aa") } },
  feedback: { success: { base: RGBA.fromHex("#008800") }, warning: { base: RGBA.fromHex("#886600") }, error: { base: RGBA.fromHex("#cc0000") } },
} }
const node = (id: string, status: string, dependsOn: string[] = [], extra: Partial<DagViewRun["nodes"][number]> = {}) =>
  ({ id, status, kind: "agent", agent: "sisyphus", model: "openai/gpt-5.5", attempt: 1, dependsOn, ...extra })
const run: DagViewRun = { runID: "r1", name: "plan-review: task", generation: 2, status: "paused", createdAt: 0, updatedAt: 0, nodes: [
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
  expect(progressBar(3, 5, 10)).toEqual({ done: "━━━━━━", rest: "━━━━", count: "3/5" })
  expect(progressBar(0, 0, 4)).toEqual({ done: "", rest: "━━━━", count: "0/0" })
  const d = depths(run)
  expect([d.get("plan"), d.get("review"), d.get("revise"), d.get("approve"), d.get("execute")]).toEqual([0, 1, 2, 2, 3])
  expect(orderNodes(run).map((n) => n.id)[0]).toBe("approve")
  expect(summarize([run]).text).toBe("Flow · 1 run · 1 waiting approval")
  expect(summarize([]).text).toBe("Flow · idle")
  expect(summarize([{ ...run, status: "running" }, { ...run, runID: "r2", status: "failed" }]).text).toBe("Flow · 2 runs · 1 running · 1 failed")
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

test("dialog results render a reply's text as Markdown and keep structured or truncated data as JSON", () => {
  expect(nodeResult('{"text":"line one\\nline two"}')).toEqual({ text: "line one\nline two", markdown: true })
  expect(nodeResult('{"decision":"approved"}')).toEqual({ text: '{"decision":"approved"}', markdown: false })
  expect(nodeResult('{"text":"truncated')).toEqual({ text: '{"text":"truncated', markdown: false })
  expect(nodeResult("null")).toEqual({ text: "null", markdown: false })
})

test("a reopened node labels the result it kept from an earlier attempt", () => {
  expect(resultLabel(2, 1)).toBe("Previous result · attempt 1")
  expect(resultLabel(2, 2)).toBe("Result")
  expect(resultLabel(1, undefined)).toBe("Result")
})

test("a finished run shows a fixed duration while an active run keeps a live clock", () => {
  const done = { ...run, status: "completed", createdAt: 1_000, updatedAt: 101_000 }
  expect(runClock(done, 200_000)).toBe("done in 1m 40s")
  expect(runClock(done, 900_000)).toBe("done in 1m 40s")
  expect(runClock({ ...done, status: "cancelled" }, 900_000)).toBe("cancelled in 1m 40s")
  expect(runClock({ ...done, status: "running" }, 31_000)).toBe("running 30s")
  expect(runClock({ ...done, status: "paused", updatedAt: 21_000 }, 31_000)).toBe("waiting 10s")
  expect(runHeadline({ ...done, status: "running" }, 31_000)).toBe("running · 30s")
  expect(runHeadline({ ...done, status: "paused", updatedAt: 21_000 }, 31_000)).toBe("waiting approval · 10s")
  expect(runHeadline(done, 900_000)).toBe("done in 1m 40s")
})

test("border titles shorten to the width OpenTUI still draws", () => {
  expect(borderTitle("✓", "Done", 30)).toBe(" ✓ Done ")
  expect(borderTitle("⠋", "Running", 30, 3)).toBe(" ⠋ Running · attempt 3 ")
  expect(borderTitle("⏸", "Waiting approval", 26, 2)).toBe(" ⏸ Waiting approval ")
  expect(borderTitle("·", "waiting approval · 1h 23m", 20)).toBe(" · waiting ap… ")
  expect(borderTitle("⏸", "waiting approval · 1h 23m", 35)).toBe(" ⏸ waiting approval · 1h 23m ")
  for (const width of [12, 20, 26, 30, 35]) for (const label of ["Done", "Waiting approval", "waiting approval · 1h 23m"]) {
    expect(borderTitle("⏸", label, width, 4).length).toBeLessThanOrEqual(width - 5)
  }
})

test("node rows mark judges and gates and colour only failed labels", () => {
  expect([kindMark("judge"), kindMark("gate"), kindMark("agent")]).toEqual(["⚖", "◇", ""])
  expect(labelColor("failed", theme)).toBe(theme.text.feedback.error.base)
  expect(labelColor("pending", theme)).toBe(theme.text.muted)
  expect(labelColor("completed", theme)).toBe(theme.text.base)
  expect(labelColor("running", theme)).toBe(theme.text.base)
})

test("a row of cards is centred when it fits and wraps otherwise", () => {
  expect(rowStart(1, 30, 120)).toBe(45)
  expect(rowStart(3, 30, 100)).toBe(4)
  expect(rowStart(2, 26, 53)).toBe(0)
  expect(rowStart(4, 30, 100)).toBeUndefined()
})

test("connectors fork, join and pass straight between rows of cards", () => {
  expect(connector([10], [10], 10)).toEqual(["          │", "          ▼"])
  expect(connector([6], [2, 6, 10], 6)).toEqual(["      │", "  ┌───┼───┐", "  ▼   ▼   ▼"])
  expect(connector([2, 6, 10], [6], 6)).toEqual(["  └───┼───┘", "      ▼"])
  expect(connector([2, 10], [1, 6, 11], 6)).toEqual(["  └───┬───┘", " ┌────┼────┐", " ▼    ▼    ▼"])
  expect(connector([2], [2, 8], 2)).toEqual(["  │", "  ├─────┐", "  ▼     ▼"])
  // A row that wraps has no reliable columns and meets its neighbours at the column of a lone card.
  expect(connector([10], undefined, 10)).toEqual(["          │", "          ▼"])
  expect(connector(undefined, [2, 10, 18], 10)).toEqual(["          │", "  ┌───────┼───────┐", "  ▼       ▼       ▼"])
  expect(connector([2, 10, 18], undefined, 10)).toEqual(["  └───────┼───────┘", "          ▼"])
})

test("sidebar lists active runs first and keeps only recent history; running glyphs animate", () => {
  const at = (runID: string, status: string) => ({ ...run, runID, status })
  const groups = partitionRuns([at("f1", "failed"), at("r1", "running"), at("c1", "completed"), at("p1", "paused"), at("c2", "cancelled"), at("c3", "completed")], 2)
  expect(groups.active.map((r) => r.runID)).toEqual(["r1", "p1"])
  expect(groups.finished.map((r) => r.runID)).toEqual(["f1", "c1"])
  expect(groups.hidden).toBe(2)
  expect(liveGlyph("running", 0)).not.toBe(liveGlyph("running", 1))
  expect(liveGlyph("completed", 3)).toBe(statusGlyph("completed"))
})

test("composer status names the gate, the running node, or the queue", () => {
  expect(runActivity(run)).toBe("awaiting approval: approve")
  const live = { ...run, status: "running", nodes: [node("plan", "running", [], { title: "Write the plan" }), node("review", "pending", ["plan"])] }
  expect(runActivity(live)).toBe("plan · Write the plan")
  expect(runActivity({ ...live, nodes: [node("a", "running"), node("b", "starting")] })).toBe("a, b")
  expect(runActivity({ ...live, nodes: [node("a", "pending")] })).toBe("queued")
})

test("dialog waves group nodes by dependency depth and label statuses for people", () => {
  expect(waves(run).map((wave) => wave.map((n) => n.id))).toEqual([["plan"], ["review"], ["revise", "approve"], ["execute"]])
  expect(statusLabel("waiting_approval")).toBe("Waiting approval"); expect(statusLabel("completed")).toBe("Done"); expect(statusLabel("cancelled")).toBe("Cancelled")
})
