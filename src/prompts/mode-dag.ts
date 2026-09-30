import type { ModeName } from "./catalog"

/** Modes that run as a DAG template rather than as a prompt alone. */
export const DAG_MODE_TEMPLATES: Partial<Record<ModeName, "ultrawork" | "hyperplan" | "team">> = { ultrawork: "ultrawork", hyperplan: "hyperplan", team: "team" }

/**
 * Iolaus's team mode prompt. OMO's team mode drives its own team_* tools, which
 * Iolaus does not have; here a team is the DAG template of the same name.
 */
export const TEAM_DAG_MODE_PROMPT = `<iolaus-team-mode>
Team mode: the task is built by several workers in parallel, each on its own git branch, and integrated on one branch the user merges. The team is an Iolaus DAG: a lead splits the task, members build their assignments in separate worktrees, the lead merges their branches in an integration worktree and runs the checks, a reviewer judges the result, and the user accepts it. Choose members by the work (repeat a lane for two workers of the same kind; default two deep-low) and the lead only when the default unspecified-high does not fit.
</iolaus-team-mode>`

/**
 * Appended to the mode prompt of the session that received the command. The
 * DAG's own worker children carry the mode marker in their prompt too, but they
 * must do the work, not spawn another run, so the block is omitted for them.
 */
export function modeDagInstruction(mode: ModeName): string | undefined {
  const template = DAG_MODE_TEMPLATES[mode]
  if (!template) return undefined
  return `<iolaus-mode-dag template="${template}">
This mode runs as an Iolaus DAG. Your first tool call is iolaus_dag with action "create" and template {"template": "${template}", "task": <the user's task, verbatim>}; do not start the work yourself. Then call action "wait". A run that pauses at a gate is waiting for the user: show them the pending node's result and ask for a decision before you call approve or reject. When the run completes, report the final node results and the verdict of the last review.${template === "team" ? " Pass members (and lead) in the template when the task calls for other lanes than the defaults. Report the integration branch; merging it is the user's decision." : ""}${template === "hyperplan" ? " The approved plan is in .iolaus/plans/<plan>/; tell the user that /start-work <plan> hands it to Atlas." : ""}
</iolaus-mode-dag>`
}

export const DAG_CHILD_MARKER = "<iolaus-dag-child>"
