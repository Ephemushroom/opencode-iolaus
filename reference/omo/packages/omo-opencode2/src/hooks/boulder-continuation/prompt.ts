import type { BoulderContinuationState } from "./state"

export function buildBoulderContinuationPrompt(state: BoulderContinuationState): string {
  const { checklist, planName, planPath } = state
  const next = checklist.nextTaskLabel !== null
    ? `The next unchecked task is: ${checklist.nextTaskLabel}.`
    : "Pick up the next unchecked task in the plan."

  return [
    "<omo-boulder-continuation>",
    `You went idle with unfinished work in the active plan "${planName}".`,
    `Plan: ${planPath}`,
    `Progress: ${checklist.completed}/${checklist.total} top-level tasks complete, ${checklist.remaining} remaining.`,
    next,
    "",
    "Continue the plan: dispatch the next unit of work and drive it to",
    "completion. When a plan checkbox is done, check it off in the plan file.",
    "Do not stop while checkboxes remain.",
    "</omo-boulder-continuation>",
  ].join("\n")
}
