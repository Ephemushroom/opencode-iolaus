import type { RGBA } from "@opentui/core"
import type { DagView } from "../dag/rpc"

export type DagViewRun = DagView["runs"][number]
export type DagViewNode = DagViewRun["nodes"][number]

/** The semantic tokens consumed from the host's resolved theme. */
export interface DagTheme {
  readonly text: {
    readonly base: RGBA
    readonly muted: RGBA
    readonly action: { readonly primary: { readonly base: RGBA } }
    readonly feedback: Readonly<Record<"success" | "warning" | "error", { readonly base: RGBA }>>
  }
}

export function statusGlyph(status: string): string {
  switch (status) {
    case "completed": case "reused": return "✓"
    case "running": case "starting": return "▶"
    case "waiting_approval": return "⏸"
    case "paused": return "⏸"
    case "skipped": return "↷"
    case "failed": case "blocked": case "rejected": return "✗"
    case "cancelled": return "×"
    case "interrupted": case "needs_retry": return "!"
    default: return "·"
  }
}

export function statusColor(status: string, theme: DagTheme): RGBA {
  switch (status) {
    case "completed": case "reused": return theme.text.feedback.success.base
    case "running": case "starting": case "ready": return theme.text.feedback.warning.base
    case "waiting_approval": case "paused": return theme.text.action.primary.base
    case "failed": case "blocked": case "rejected": case "cancelled": return theme.text.feedback.error.base
    case "skipped": case "pending": return theme.text.muted
    default: return theme.text.base
  }
}

/** Running and paused runs still need attention; everything else is history. */
export function isActiveRun(run: DagViewRun): boolean {
  return run.status === "running" || run.status === "paused"
}

/** Active runs first (newest first), then at most `history` finished runs; `hidden` counts the rest. */
export function partitionRuns(runs: readonly DagViewRun[], history = 3): { readonly active: DagViewRun[]; readonly finished: DagViewRun[]; readonly hidden: number } {
  const active = runs.filter(isActiveRun)
  const done = runs.filter((run) => !isActiveRun(run))
  return { active, finished: done.slice(0, history), hidden: Math.max(0, done.length - history) }
}

/** A live clock only while the run is active; a finished run shows its fixed duration. */
export function runClock(run: DagViewRun, now: number): string {
  if (run.status === "running") return `running ${elapsed(run.createdAt, now) || "0s"}`
  if (run.status === "paused") return `waiting ${elapsed(run.updatedAt, now) || "0s"}`
  const duration = elapsed(run.createdAt, run.updatedAt) || "0s"
  return `${run.status === "completed" ? "done" : run.status} in ${duration}`
}

/** Dashed rounded frame drawn around runs that are still in flight. */
export const DASHED_BORDER = {
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "╌", vertical: "╎",
  topT: "┬", bottomT: "┴", leftT: "├", rightT: "┤", cross: "┼",
} as const

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Glyph for a node; in-flight nodes animate with the frame counter. */
export function liveGlyph(status: string, frame: number): string {
  return status === "running" || status === "starting" ? SPINNER[frame % SPINNER.length] : statusGlyph(status)
}

/** What a run is doing right now, for the one-line status above the composer. */
export function runActivity(run: DagViewRun): string {
  const gates = run.nodes.filter((node) => node.status === "waiting_approval")
  if (gates.length) return `awaiting approval: ${gates.map((node) => node.id).join(", ")}`
  const live = run.nodes.filter((node) => node.status === "running" || node.status === "starting")
  if (live.length === 1) return `${live[0].id}${live[0].title ? ` · ${live[0].title}` : ""}`
  if (live.length) return live.map((node) => node.id).join(", ")
  return "queued"
}

export function settledCount(run: DagViewRun): number {
  return run.nodes.filter((n) => n.status === "completed" || n.status === "reused" || n.status === "skipped").length
}

/** `[████░░░░] 4/8` in a fixed width. */
export function progressBar(done: number, total: number, width = 12): string {
  if (total === 0) return `[${" ".repeat(width)}] 0/0`
  const filled = Math.round((done / total) * width)
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${done}/${total}`
}

/** Depth of each node in the dependency graph, for indentation. */
export function depths(run: DagViewRun): Map<string, number> {
  const byID = new Map(run.nodes.map((n) => [n.id, n]))
  const memo = new Map<string, number>()
  const depth = (id: string, seen: Set<string>): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 0
    seen.add(id)
    const node = byID.get(id)
    const value = node && node.dependsOn.length ? 1 + Math.max(...node.dependsOn.map((d) => depth(d, seen))) : 0
    memo.set(id, value)
    return value
  }
  for (const node of run.nodes) depth(node.id, new Set())
  return memo
}

/** Gates first (they need the user), then running, then the rest in graph order. */
export function orderNodes(run: DagViewRun): DagViewNode[] {
  const rank = (n: DagViewNode) => n.status === "waiting_approval" ? 0 : n.status === "running" || n.status === "starting" ? 1 : 2
  return topologyNodes(run).sort((a, b) => rank(a) - rank(b))
}

export function topologyNodes(run: DagViewRun): DagViewNode[] {
  const levels = depths(run)
  return [...run.nodes].sort((a, b) => (levels.get(a.id) ?? 0) - (levels.get(b.id) ?? 0))
}

export function nodeResultText(result: string): string {
  try {
    const value: unknown = JSON.parse(result)
    return value !== null && typeof value === "object" && "text" in value && typeof value.text === "string" ? value.text : result
  } catch {
    // RPC result excerpts can end in the middle of serialized JSON.
    return result
  }
}

export interface Summary {
  readonly runs: number
  readonly active: number
  readonly waiting: number
  readonly failed: number
  readonly text: string
}

export function summarize(runs: readonly DagViewRun[]): Summary {
  const active = runs.filter((r) => r.status === "running").length
  const waiting = runs.filter((r) => r.status === "paused").length
  const failed = runs.filter((r) => r.status === "failed").length
  const parts = [`${runs.length} run${runs.length === 1 ? "" : "s"}`]
  if (active) parts.push(`${active} running`)
  if (waiting) parts.push(`${waiting} waiting approval`)
  if (failed) parts.push(`${failed} failed`)
  return { runs: runs.length, active, waiting, failed, text: runs.length ? `DAG · ${parts.join(" · ")}` : "DAG · idle" }
}

/** Short one-line label for the latest assistant text of a child session. */
export function activityLine(text: string | undefined, width = 60): string | undefined {
  if (!text) return undefined
  const line = text.replace(/\s+/g, " ").trim()
  if (!line) return undefined
  return line.length > width ? `${line.slice(0, width - 1)}…` : line
}

export function elapsed(since: number | undefined, now: number): string {
  if (!since) return ""
  const s = Math.max(0, Math.round((now - since) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
