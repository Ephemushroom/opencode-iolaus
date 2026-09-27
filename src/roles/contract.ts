import type { AgentName } from "../prompts/catalog"
import { GOAL_MAX_CONTINUATIONS, GOAL_STAGNATION_LIMIT } from "./goal"
import { PLAN_FORMAT, PLANS_DIR } from "./plan"

/**
 * Appended to a primary's rendered prompt. The retained OMO prose names tools,
 * skills and commands this host does not have; these blocks say what Iolaus
 * enforces instead. The enforcement itself is in the guard and the prompt hook.
 */
export const ROLE_CONTRACTS: Partial<Record<AgentName, string>> = {
  prometheus: `<iolaus-planner>
Iolaus enforces the planner role in code: file writes are allowed only under ${PLANS_DIR}/, CONTEXT.md, CONTEXT-MAP.md and docs/adr/; shell is off; subagents and DAG nodes you start run read-only; the only template you may start is hyperplan. Where the retained prompt loads the ulw-plan skill, use the grilling, domain-modeling, to-spec and to-tickets skills when they are installed, and write the result as files in the format below rather than to an issue tracker. Execution starts when the user runs /start-work <plan>, which hands each ticket to Atlas in a fresh session; /ulw-execute in the retained prompt means /start-work here.
${PLAN_FORMAT}
</iolaus-planner>`,
  atlas: `<iolaus-atlas>
Iolaus gates Atlas in code. Without a plan Atlas only reads: edits, shell, delegation and new DAG runs are refused; tell the user to plan with Prometheus and run /start-work <plan>. /start-work compiles the plan's tickets into an iolaus_dag run: each ticket runs in its own fresh Atlas session, then Momus reviews the Standards and Spec axes side by side, one fix pass runs when either fails, and an accept gate waits for the user.
- In the session that ran /start-work you operate that run with iolaus_dag (wait, snapshot, node, retry; approve or reject only on the user's word) and change nothing yourself.
- In a ticket session you implement that one ticket. The retained prompt's task(), boulder and Final Verification Wave map to this ticket's acceptance criteria; delegate with native subagent where it helps and verify the result yourself.
</iolaus-atlas>`,
  hephaestus: `<iolaus-goal-loop>
In a top-level session Iolaus runs you as a goal loop: each user request becomes, or extends, the session goal, and whenever you stop while the goal is active Iolaus resumes you with a continuation prompt, up to ${GOAL_MAX_CONTINUATIONS} times, pausing the goal after ${GOAL_STAGNATION_LIMIT} consecutive turns without a tool call. Keep working until the goal is met. Call update_goal with status "complete" only after a completion audit against real evidence, or "paused" with a reason when only the user can unblock you; get_goal reads the goal and create_goal replaces it when the user redefines the task. As a DAG node or a subagent there is no loop: finish and report to your caller.
</iolaus-goal-loop>`,
}
