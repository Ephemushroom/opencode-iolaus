import type { ModeName } from "./catalog"

/** Modes that run as a DAG template rather than as a prompt alone. */
export const DAG_MODE_TEMPLATES: Partial<Record<ModeName, "ultrawork" | "hyperplan">> = { ultrawork: "ultrawork", hyperplan: "hyperplan" }

/**
 * Appended to the mode prompt of the session that received the command. The
 * DAG's own worker children carry the mode marker in their prompt too, but they
 * must do the work, not spawn another run, so the block is omitted for them.
 */
export function modeDagInstruction(mode: ModeName): string | undefined {
  const template = DAG_MODE_TEMPLATES[mode]
  if (!template) return undefined
  return `<iolaus-mode-dag template="${template}">
This mode runs as an Iolaus DAG. Your first tool call is iolaus_dag with action "create" and template {"template": "${template}", "task": <the user's task, verbatim>}; do not start the work yourself. Then call action "wait". A run that pauses at a gate is waiting for the user: show them the pending node's result and ask for a decision before you call approve or reject. When the run completes, report the final node results and the verdict of the last review.
</iolaus-mode-dag>`
}

export const DAG_CHILD_MARKER = "<iolaus-dag-child>"
