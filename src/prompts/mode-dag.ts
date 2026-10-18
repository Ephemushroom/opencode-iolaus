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

export const DAG_CHILD_MARKER = "<iolaus-dag-child>"

/**
 * `mass-ulw`: unlike the template modes, nobody hands the agent a graph. The
 * agent writes the dependency graph itself and drives it through iolaus_flow,
 * one run per phase, because the phases gate each other: a later phase consumes
 * the settled results of the earlier one.
 */
export const MASS_ULW_MODE_PROMPT = `<iolaus-mass-ulw-mode>
Mass ultrawork: the task is large enough that its parts must be ordered. You define the dependency graph, then drive it through \`iolaus_flow\` - not through a prose plan and not through a single long turn.

- Split the task into phases where each phase's output is the next phase's input. Independent work inside a phase is one run with parallel nodes joined by a downstream node that binds \`inputs: [{"node": "*"}]\`.
- One run per phase. A phase starts only after the previous run settled; pass its results into the new run's node prompts through \`inputs\`, never by restating them in prose.
- Give every node the completion condition of the step it owns, and an agent from the advertised ids.
- A gate is the user's decision: pause the run, show the pending node's result, and wait.
- Report the settled result of every node, and the verdict of any review node.
</iolaus-mass-ulw-mode>`

/** Appended to a mode prompt: what the first tool call must be, per mode. */
export function modeDagInstruction(mode: ModeName): string | undefined {
  if (mode === "mass-ulw") {
    return `<iolaus-mode-dag mode="mass-ulw">
This mode runs through iolaus_flow. Write the dependency graph first and create it with action "create": one run per phase, every edge an explicit \`dependsOn\`, every node's completion condition in the node that consumes its result. Create the first phase, then wait for it; when it settles, create the next phase with the previous results bound through \`inputs\`. Do not start implementing inside this turn before the first run exists.
</iolaus-mode-dag>`
  }
  const template = DAG_MODE_TEMPLATES[mode]
  if (!template) return undefined
  return `<iolaus-mode-dag template="${template}">
This mode runs as an Iolaus DAG. Your first tool call is iolaus_flow with action "create" and template {"template": "${template}", "task": <the user's task, verbatim>}; do not start the work yourself. Creation returns while the flow continues: report its run_id and remain available for the user. Use snapshot or node on demand; wait is optional and blocks until terminal, including across gates. Gate and terminal notices are queued without waking this conversation. A run that pauses at a gate is waiting for the user: show them the pending node's result and ask for a decision before you call approve or reject. When the run completes, inspect its committed results before reporting completion.${template === "team" ? " Pass members (and lead) in the template when the task calls for other lanes than the defaults. Report the integration branch; merging it is the user's decision." : ""}${template === "hyperplan" ? " The approved plan is in .iolaus/plans/<plan>/; tell the user that /start-work <plan> hands it to Atlas." : ""}
</iolaus-mode-dag>`
}
