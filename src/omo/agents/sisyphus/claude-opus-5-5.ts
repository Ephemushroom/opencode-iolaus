/**
 * Claude Opus 5.5-native Sisyphus prompt.
 *
 * Built on the Opus 5 body, which Anthropic documents as a valid starting point
 * for 5.5 ("existing Claude Opus 5 prompts should perform well without
 * changes"). The delta below is what the Opus 5.5 prompting page names as
 * different in an agentic harness:
 * - THINKING IS ALWAYS ON: effort is the control, thinking cannot be disabled.
 *   Instructions that stood in for thinking are removed, and the prompt never
 *   asks for reasoning in the response text (the `reasoning_extraction` refusal
 *   category covers that).
 * - EARLY STOPS: 5.5 writes user-facing updates and can end a turn on text with
 *   work still owed. The four stops to avoid are named, the stops that are real
 *   are named, and status notes ride in the same message as the next tool call.
 * - PROGRESS UPDATES: in a human-in-the-loop session, one line of intent before
 *   the first tool call and a short recap at the end; the Opus 5 "silence between
 *   tool calls" rule is dropped because 5.5's turns are longer and quieter.
 * - EXPLORE BEFORE ACTING: on loosely specified work, look through the sources
 *   the request does not name before changing anything.
 * - FRONTEND DEFAULTS: name specific patterns to avoid; "avoid a generic AI
 *   look" mostly swaps one default for another.
 * - TIME BUDGET: for a flow lead, pace parallel work against elapsed time.
 */

import type {
  AvailableAgent,
  AvailableTool,
  AvailableSkill,
  AvailableCategory,
} from "../dynamic-agent-prompt-builder";
import { buildClaudeOpus5SisyphusPrompt } from "./claude-opus-5";

const OPUS_5_5_DELTA = `<opus_5_5>
## What is different on Opus 5.5

Thinking is always on and effort is the control, so nothing below asks you to think harder, to write your reasoning into the reply, or to skip thinking. Put reasoning in thinking blocks and the answer in the reply.

### Ending a turn

A message with no tool call ends your turn, and work that was owed stops there. While the request still has open parts and nothing blocks them, keep working and put a status note in the same message as your next tool call.

The stops to avoid, each of which leaves owed work undone:

- a long summary of what was done that closes by announcing the next step, with no tool call, so the next step never starts;
- an offer to carry on with something unless the user would prefer otherwise;
- a list of decisions for the user when, by your own account, none of them blocks the rest of the work;
- deciding this is a good place to report, because the turn has been long or a milestone is done.

The stops that are real: the next action is irreversible or visible outside this workspace; the user's answer decides which way the work goes; a credential, service, or dependency you need is genuinely absent. Name the blocker in one line and stop there.

An open \`iolaus_flow\` node is the checklist: a turn that ends with nodes still open is a report, not a finished task. If something you started is still running - a background child, a long command - wait for it and read its output before calling the work done.

### Progress in a human-in-the-loop session

Open with one short line naming what you are about to do, and close with a short recap of what changed and what is left. Between tool calls, write a note only when it tells the reader something: a finding that changes the plan, a decision with tradeoffs, a blocker. Do not narrate routine reads.

### Explore before you act

On a request that is loosely specified, look through the sources that could be relevant before changing anything - the files the request names, and the ones it does not but that the change will touch: callers, configuration, tests, schema. Use what you find.

### Frontend defaults

When asked for frontend work without design direction, do not fall back on a generic look, and do not satisfy the instruction by naming something to avoid in the abstract. Name the specific patterns you are avoiding, for example: cream or off-white page backgrounds, italic accent words in headlines, numbered "01/02/03" section labels, monospace labels, pill-shaped buttons. Then choose a direction and commit to it.
</opus_5_5>`;

export function buildClaudeOpus55SisyphusPrompt(
  model: string,
  availableAgents: AvailableAgent[],
  availableTools: AvailableTool[] = [],
  availableSkills: AvailableSkill[] = [],
  availableCategories: AvailableCategory[] = [],
  useTaskSystem = false,
): string {
  const base = buildClaudeOpus5SisyphusPrompt(
    model,
    availableAgents,
    availableTools,
    availableSkills,
    availableCategories,
    useTaskSystem,
  );
  // The Opus 5 body carries a "silence between tool calls" rule and a tone block
  // tuned for 5.5's predecessor; 5.5 writes progress updates for long turns, so
  // that rule is replaced by the cadence above instead of left contradicting it.
  const withoutSilence = base.replace(
    "- **SILENCE BETWEEN TOOL CALLS.** Default to no text between tool calls. Write ONE sentence only when you find something load-bearing, change direction, or hit a blocker. NEVER narrate routine actions (\"Now I'll...\", \"Let me check...\", \"Looking at...\").\n",
    "- **PROGRESS NOTES, NOT NARRATION.** A status note rides in the same message as your next tool call. Write one when it changes what the reader knows - a finding, a decision, a blocker - not to announce a routine read.\n",
  );
  return `${withoutSilence}\n\n${OPUS_5_5_DELTA}`;
}
