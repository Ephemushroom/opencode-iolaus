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
 * `iolaus_flow` is good at and, more importantly, what it can do that a plain
 * `subagent` call cannot. Size alone is not the discriminator: several
 * independent children that the orchestrator merges itself are cheaper as
 * subagents, because a flow would only add a join node that does the
 * orchestrator's own job. The discriminator is shape - work that is ordered by
 * quality rather than by time: a verdict that sends work back, a step that
 * consumes another's result as input, a human gate, or a step that may need
 * re-running on its own.
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
- **The right lane per node.** Every node names its own \`agent\` lane, and each lane carries its own pinned model, so one run can put reading on \`explore\`, implementation on \`deep-low\`, review on a \`momus\` judge and escalation on \`deep-high\` - without your own session changing model.
- **Dependency order.** A node can declare \`dependsOn\` and receive an upstream result through \`inputs: [{"node": "<id>"}]\` instead of having it pasted into a prompt.
- **Parallel work that joins.** Independent nodes run at the same time; a downstream node binds \`inputs: [{"node": "*"}]\` and sees every upstream result with its producer.
- **Retry without restating.** A failed or interrupted node is rerun on its own.
- **A decision point.** A \`kind: "gate"\` node pauses the run until the user answers.

## Pick the shape, not the size

Three levels, ascending cost. **Do it yourself** when it is one file and the context is already in your hands. **\`subagent\`** when it is one child, or several independent children whose results you merge yourself - use \`background: true\` for the parallel case. **\`iolaus_flow\`** when the parts are ordered by quality, not just by time.

A flow earns its cost when the work has one of these shapes, whatever its size:

- **Work → review → fix.** Something must be judged and a FAIL must send the work back. A \`loop\` grows the next fix/review round by itself when the review settles FAIL; a subagent cannot act on a verdict.
- **A step consumes another's result as input.** Declare \`dependsOn\` and bind the upstream with \`inputs: [{"node": "<id>"}]\`; the payload arrives with its provenance instead of being pasted into the next prompt by hand.
- **A human decides mid-way.** A \`kind: "gate"\` node pauses the run in \`waiting_approval\` until the user answers.
- **A step may need re-running alone.** \`retry\` re-runs one node and keeps every other result. An observed native \`subagent\` run can never be retried, resumed or amended - it is a read-only trace once it settles.
- **The parts need different lanes.** Reading, implementing, reviewing and escalating are different jobs with different lane contracts and, usually, different models. One flow composes them; a sequence of subagent calls makes you carry each result across by hand.

If none of those hold - the parts are independent and you are the one merging them - \`subagent\` is the right tool. A flow would only add a join node that does your own job.

## Each node runs on the lane you choose

A node's \`agent\` is a lane: a category lane (\`deep-low\`, \`deep-high\`, \`ultrabrain\`, \`quick\`, \`visual-engineering\`, \`writing\`, \`artistry\`, \`unspecified-low\`, \`unspecified-high\`) or a specialist (\`explore\`, \`librarian\`, \`oracle\`, \`metis\`, \`momus\`, \`sisyphus-junior\`, \`multimodal-looker\`). Each lane is pinned to its own model in \`IOLAUS_HOME/iolaus.json\`; omit \`model\` on the node and it runs on that lane's configured model. A lane with no configured model is refused at create time rather than discovered when the child fails to start.

The lane carries the worker's contract, so choose by the work:

- \`explore\`, \`librarian\` and \`oracle\` are read-only; \`metis\` analyses and \`multimodal-looker\` only reads. Use them for gathering, never for editing.
- \`momus\` is the natural review lane for a \`judge\` node.
- The category lanes are one-goal workers with no delegation of their own: give each the completion condition of its own step, not the whole plan.
- \`sisyphus-junior\` implements a scoped change without spawning anything further.
- A \`deep-low\` node whose central decision cannot be settled from what it can read and run should end its reply with the line \`ESCALATE: deep-high\`; it is then rerun in place on \`deep-high\` with its findings attached. Reserve \`deep-high\` for exactly that case rather than reaching for it up front.

Nodes that write in parallel and might touch the same files set \`worktree: true\`; each gets its own branch cut from the run directory's HEAD, and nothing touches the user's working tree.

## Review is a judge, not a child

\`kind: "judge"\` makes one model call with no session and returns the reply. Use it for review, verification or a second opinion inside a flow: it costs a fraction of a child session and needs no context of its own. Reserve \`agent\` nodes for work that edits files or runs commands.

Give a node the completion condition of the step it owns, so the child can tell when it is done. Reserve \`deep-high\` for a node whose central decision cannot be settled from what it can read and run.

${FLOW_EXAMPLE}

Read \`snapshot\` or \`wait\` before reporting a node's outcome, and report what the node actually returned. A gate is the user's decision: approve or reject only on their word.
</Iolaus_Flow>`;
}
