import type { TodoItem } from "../../orchestration/todo-store"

const MAX_LISTED = 10

export function buildTodoContinuationPrompt(remaining: readonly TodoItem[]): string {
  const listed = remaining.slice(0, MAX_LISTED)
  const lines = listed.map((item) => `- [${item.status}] ${item.content}`)
  const overflow = remaining.length - listed.length
  if (overflow > 0) lines.push(`- ...and ${overflow} more`)

  return [
    "<omo-todo-continuation>",
    `You went idle with ${remaining.length} unfinished todo${remaining.length === 1 ? "" : "s"}:`,
    ...lines,
    "",
    "Continue working. Pick up the next item and drive it to completion.",
    "If an item is genuinely blocked or no longer applies, call todowrite to",
    "update its status and say why, rather than leaving it pending.",
    "If every item is actually done, mark them completed with todowrite.",
    "</omo-todo-continuation>",
  ].join("\n")
}
