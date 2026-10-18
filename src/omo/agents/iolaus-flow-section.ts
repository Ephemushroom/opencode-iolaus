/**
 * Orchestration capability, not a progress ledger.
 *
 * OpenCode 2 has no todo tool. The retained OMO guidance pointed at
 * `todowrite` / `TaskCreate` and at a `[SYSTEM REMINDER - TODO CONTINUATION]`
 * hook this harness never registers; that guidance was removed because a
 * bookkeeping list does not add capability and costs context on every turn.
 *
 * Replacing it with an equivalent "the flow is your checklist" rule would be the
 * same mistake under a new name. This section therefore describes what
 * `iolaus_flow` is good at - ordering dependent work, running independent work
 * in parallel, rerunning a failed step, pausing for a decision - and leaves it
 * to the model to decide when that pays for its coordination cost. Each node
 * starts a fresh session and returns only its result, which is the real reason a
 * flow is cheaper than carrying a long transcript in one context.
 */

export interface IolausFlowSectionOptions {
  /**
   * A long-running worker (Hephaestus, a category lane) owns one part of the
   * work; it gets the completion contract and does not orchestrate.
   */
  readonly worker?: boolean;
}

const FLOW_EXAMPLE = `<flow_example>
iolaus_flow action="create" definition={
  "schemaVersion": 1,
  "name": "port the settings page",
  "nodes": [
    { "id": "read",   "agent": "explore", "prompt": "Map how src/settings renders today and which tests cover it." },
    { "id": "port",   "agent": "deep-low", "dependsOn": ["read"],
      "prompt": "Rewrite src/settings against the new schema. Done means: types compile, the page renders with the existing data, and the layout is unchanged.",
      "inputs": [{ "node": "read" }] },
    { "id": "verify", "agent": "deep-low", "dependsOn": ["port"],
      "prompt": "Run the settings tests and the dev server, load the page, and report what you saw." }
  ]
}
</flow_example>`;

export function buildIolausFlowSection(options: IolausFlowSectionOptions = {}): string {
  if (options.worker) {
    return `<completion>
Work one part of a larger flow. Your prompt carries what done means for that part; finish it, including running the code you changed and reporting what you observed. If a real blocker stops you - a missing credential, a failing dependency outside your scope - say which one in a line and stop. Do not create a flow of your own.
</completion>`;
  }

  return `<Iolaus_Flow>
\`iolaus_flow\` is the harness's orchestration tool. It is not a checklist and it is not required for multi-step work: a task you can carry to the end yourself is cheaper done yourself.

## What it gives you

- **Fresh context per node.** Each node runs in a new session and returns only its result, so the orchestrator holds conclusions instead of every file it read and every command it ran.
- **Dependency order.** A node can declare \`dependsOn\` and receive an upstream result through \`inputs: [{"node": "<id>"}]\` instead of having it pasted into a prompt.
- **Parallel work that joins.** Independent nodes run at the same time; a downstream node binds \`inputs: [{"node": "*"}]\` and sees every upstream result with its producer.
- **Retry without restating.** A failed or interrupted node is rerun on its own.
- **A decision point.** A \`kind: "gate"\` node pauses the run until the user answers.

## When that is worth its coordination cost

Use a flow when at least one of those properties is load-bearing: several parts where one consumes another's output, work wide enough that running it in parallel materially shortens it, a step likely to fail and need a rerun, or a decision only the user can make. Otherwise call \`subagent\` directly for one child, or just do the work.

Give a node the completion condition of the step it owns, so the child can tell when it is done. Reserve \`deep-high\` for a node whose central decision cannot be settled from what it can read and run.

${FLOW_EXAMPLE}

Read \`snapshot\` or \`wait\` before reporting a node's outcome, and report what the node actually returned. A gate is the user's decision: approve or reject only on their word.
</Iolaus_Flow>`;
}
