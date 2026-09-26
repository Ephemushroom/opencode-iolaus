import type { DagView } from "../dag/rpc"

export type DagViewRun = DagView["runs"][number]
export type DagViewNode = DagViewRun["nodes"][number]

/** Theme keys the host exposes; the sidebar never hardcodes a colour. */
export type ThemeLike = Partial<Record<"primary" | "secondary" | "accent" | "error" | "warning" | "success" | "info" | "text" | "textMuted" | "border", string>>

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

export function statusColor(status: string, theme: ThemeLike): string | undefined {
  switch (status) {
    case "completed": case "reused": return theme.success
    case "running": case "starting": case "ready": return theme.warning
    case "waiting_approval": case "paused": return theme.accent
    case "failed": case "blocked": case "rejected": case "cancelled": return theme.error
    case "skipped": case "pending": return theme.textMuted
    default: return theme.text
  }
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
  return [...run.nodes].sort((a, b) => rank(a) - rank(b))
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
