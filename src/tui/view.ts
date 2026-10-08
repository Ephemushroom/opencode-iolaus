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

/** What a run is doing with its live clock, for frame titles; a finished run states its outcome and fixed duration. */
export function runHeadline(run: DagViewRun, now: number): string {
  if (run.status === "running") return `running · ${elapsed(run.createdAt, now) || "0s"}`
  if (run.status === "paused") return `waiting approval · ${elapsed(run.updatedAt, now) || "0s"}`
  return runClock(run, now)
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

/** A fixed-width bar split into its filled and empty parts, so each can take its own colour, and the `4/8` count. */
export function progressBar(done: number, total: number, width = 12): { readonly done: string; readonly rest: string; readonly count: string } {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return { done: "━".repeat(filled), rest: "━".repeat(width - filled), count: `${done}/${total}` }
}

/** A judge reviews and a gate waits for a person; the mark sits after the label, the state stays in the status glyph. */
export function kindMark(kind: string): string {
  return kind === "judge" ? "⚖" : kind === "gate" ? "◇" : ""
}

/** Node labels stay readable and leave the status to their glyph; only failures colour the label too. */
export function labelColor(status: string, theme: DagTheme): RGBA {
  switch (status) {
    case "failed": case "blocked": case "rejected": return theme.text.feedback.error.base
    case "pending": case "ready": case "skipped": case "cancelled": return theme.text.muted
    default: return theme.text.base
  }
}

/** A border title, shortened to fit: OpenTUI draws no title longer than the box width minus 4; one column stays spare for a wide glyph. */
export function borderTitle(glyph: string, label: string, width: number, attempt = 1): string {
  const limit = width - 5
  const texts = attempt > 1 ? [`${label} · attempt ${attempt}`, `${label} · #${attempt}`, label] : [label]
  const fit = texts.find((text) => text.length + 4 <= limit)
  return ` ${glyph} ${fit ?? `${label.slice(0, Math.max(0, limit - 5))}…`} `
}

/** First column of a row of `count` cards centred in `width`, or undefined when the row would have to wrap. */
export function rowStart(count: number, card: number, width: number): number | undefined {
  const span = count * card + count - 1
  return span <= width ? Math.floor((width - span) / 2) : undefined
}

// Junctions keyed by the lines that meet there: up, down, left, right.
const JUNCTION: Readonly<Record<string, string>> = {
  "1111": "┼", "1110": "┤", "1101": "├", "1100": "│", "1011": "┴", "1010": "┘", "1001": "└", "1000": "│",
  "0111": "┬", "0110": "┐", "0101": "┌", "0100": "│", "0011": "─", "0010": "─", "0001": "─",
}

/** One horizontal bar joining the lines arriving from above at `ups` to the lines leaving below at `downs`. */
function bar(ups: readonly number[], downs: readonly number[]): string {
  const all = [...ups, ...downs], lo = Math.min(...all), hi = Math.max(...all)
  let row = " ".repeat(lo)
  for (let x = lo; x <= hi; x++) row += JUNCTION[`${+ups.includes(x)}${+downs.includes(x)}${+(x > lo)}${+(x < hi)}`] ?? " "
  return row
}

function marks(columns: readonly number[], glyph: string): string {
  let row = ""
  for (const x of [...columns].sort((a, b) => a - b)) row += `${" ".repeat(Math.max(0, x - row.length))}${glyph}`
  return row
}

/**
 * Rows of box drawing from one wave of cards to the next, given the centre column of each card. The dialog lays nodes
 * out by dependency depth, so every card above flows into the row below; the selected card marks its real upstream and
 * downstream. A wave that wraps has no reliable columns (`undefined`) and meets the others at `centre`, the column of a
 * lone card.
 */
export function connector(upper: readonly number[] | undefined, lower: readonly number[] | undefined, centre: number): string[] {
  const ups = upper ?? [centre], downs = lower ?? [centre]
  const trunk = ups.length === 1 ? ups[0] : downs.length === 1 ? downs[0] : Math.round((ups[0] + ups[ups.length - 1]) / 2)
  const rows = [ups.length === 1 ? marks([trunk], "│") : bar(ups, [trunk])]
  if (downs.length > 1) rows.push(bar([trunk], downs))
  rows.push(marks(downs, "▼"))
  return rows
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

/** Nodes grouped by dependency depth: every node in a wave can run once the waves above it settle. */
export function waves(run: DagViewRun): DagViewNode[][] {
  const levels = depths(run)
  const grouped: DagViewNode[][] = []
  for (const node of run.nodes) (grouped[levels.get(node.id) ?? 0] ??= []).push(node)
  return grouped.filter((wave) => wave !== undefined)
}

export function statusLabel(status: string): string {
  switch (status) {
    case "completed": return "Done"
    case "reused": return "Reused"
    case "running": return "Running"
    case "starting": return "Starting"
    case "ready": case "pending": return "Pending"
    case "waiting_approval": return "Waiting approval"
    case "needs_retry": return "Needs retry"
    default: return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ")
  }
}

export function topologyNodes(run: DagViewRun): DagViewNode[] {
  const levels = depths(run)
  return [...run.nodes].sort((a, b) => (levels.get(a.id) ?? 0) - (levels.get(b.id) ?? 0))
}

/** A reopened node (follow-up or retry) keeps its last result until the new attempt settles; say which attempt it came from. */
export function resultLabel(attempt: number, resultAttempt: number | undefined): string {
  return resultAttempt !== undefined && resultAttempt < attempt ? `Previous result · attempt ${resultAttempt}` : "Result"
}

/** An agent or judge reply is its text and renders as Markdown; any other result is shown as its JSON. */
export function nodeResult(result: string): { readonly text: string; readonly markdown: boolean } {
  let value: unknown
  try {
    value = JSON.parse(result)
  } catch {
    // A structured result too large for the view arrives cut in the middle of its JSON.
    return { text: result, markdown: false }
  }
  return value !== null && typeof value === "object" && "text" in value && typeof value.text === "string"
    ? { text: value.text, markdown: true }
    : { text: result, markdown: false }
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
  return { runs: runs.length, active, waiting, failed, text: runs.length ? `Flow · ${parts.join(" · ")}` : "Flow · idle" }
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
