import { DagValidationError } from "./graph-error"
import type { DagDefinition, DagNodeDefinition } from "./types"

export const DAG_TEMPLATE_NAMES = ["plan-review", "goal-review"] as const
export type DagTemplateName = (typeof DAG_TEMPLATE_NAMES)[number]

export interface DagTemplateInput {
  readonly template: DagTemplateName
  /** The task, in the user's words. Becomes the planner's / worker's prompt body. */
  readonly task: string
  readonly name?: string
  /** Reviewer lane; defaults to `iolaus-momus` for plans and `iolaus-metis`-free `iolaus-momus` for goals. */
  readonly reviewer?: string
  /** Executor lane for the post-approval step; defaults to `iolaus-sisyphus`. */
  readonly executor?: string
  /** Set false to run the executor immediately after a passing review. Default true: a human gate sits between review and execution. */
  readonly gate?: boolean
  /** Review attempts before the run fails (planner and reviewer each get this many). Default 2. */
  readonly maxAttempts?: number
}

export const REVIEW_VERDICT_PASS = "VERDICT: PASS"
export const REVIEW_VERDICT_FAIL = "VERDICT: FAIL"

const REVIEW_INSTRUCTIONS = `You are the reviewer node of an Iolaus DAG. The upstream result is in <iolaus-dag-inputs>. Judge it against the task below. Be concrete: name each defect with where it is and what would fix it. End your reply with exactly one line, either "${REVIEW_VERDICT_PASS}" or "${REVIEW_VERDICT_FAIL}", followed by nothing else.`

function planReview(input: DagTemplateInput): DagNodeDefinition[] {
  const attempts = input.maxAttempts ?? 2
  const reviewer = input.reviewer ?? "iolaus-momus"
  const executor = input.executor ?? "iolaus-sisyphus"
  const gate = input.gate !== false
  return [
    { id: "plan", agent: "iolaus-prometheus", prompt: `Write the work plan for this task into .iolaus/plans/ and return the plan text in full.\n\nTASK:\n${input.task}`, dependsOn: [], maxAttempts: attempts },
    { id: "review", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}\n\nA plan passes only if every step is verifiable, no step depends on unstated assumptions, and the plan covers the whole task.\n\nTASK:\n${input.task}`, dependsOn: ["plan"], inputs: [{ node: "plan" }], maxAttempts: attempts },
    { id: "revise", agent: "iolaus-prometheus", prompt: `The reviewer rejected the plan. Address every defect named in the review, rewrite the plan in .iolaus/plans/, and return the revised plan in full.\n\nTASK:\n${input.task}`, dependsOn: ["review"], inputs: [{ node: "plan" }, { node: "review" }], when: { node: "review", field: "text", includes: REVIEW_VERDICT_FAIL }, maxAttempts: attempts },
    { id: "rereview", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}\n\nThis is the revised plan after your earlier review. Apply the same standard.\n\nTASK:\n${input.task}`, dependsOn: ["revise"], inputs: [{ node: "revise" }], when: { node: "revise", exists: true }, maxAttempts: attempts },
    ...(gate ? [{ id: "approve", kind: "gate" as const, prompt: `Plan for "${input.name ?? input.task.slice(0, 60)}" passed review. Approve to start execution or reject to stop.`, dependsOn: ["review", "rereview"], when: { any: [{ node: "review", field: "text", includes: REVIEW_VERDICT_PASS }, { node: "rereview", field: "text", includes: REVIEW_VERDICT_PASS }] } }] : []),
    { id: "execute", agent: executor, prompt: `Execute the approved plan exactly. The plan is in <iolaus-dag-inputs>; prefer the revised plan when present. Report what was done and how it was verified.\n\nTASK:\n${input.task}`, dependsOn: gate ? ["approve"] : ["review", "rereview"], inputs: [{ node: "plan" }, { node: "revise" }], ...(gate ? {} : { when: { any: [{ node: "review", field: "text", includes: REVIEW_VERDICT_PASS }, { node: "rereview", field: "text", includes: REVIEW_VERDICT_PASS }] } }) },
  ]
}

function goalReview(input: DagTemplateInput): DagNodeDefinition[] {
  const attempts = input.maxAttempts ?? 2
  const reviewer = input.reviewer ?? "iolaus-momus"
  const executor = input.executor ?? "iolaus-hephaestus"
  const gate = input.gate !== false
  return [
    { id: "work", agent: executor, prompt: `Achieve this goal end to end and report what changed and how you verified it.\n\nGOAL:\n${input.task}`, dependsOn: [], maxAttempts: attempts },
    { id: "review", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}\n\nThe work passes only if the goal is met, the reported verification is real (commands and outputs, not claims), and nothing out of scope was changed.\n\nGOAL:\n${input.task}`, dependsOn: ["work"], inputs: [{ node: "work" }], maxAttempts: attempts },
    { id: "fix", agent: executor, prompt: `The reviewer rejected the work. Fix every defect named in the review and report the verification again.\n\nGOAL:\n${input.task}`, dependsOn: ["review"], inputs: [{ node: "work" }, { node: "review" }], when: { node: "review", field: "text", includes: REVIEW_VERDICT_FAIL }, maxAttempts: attempts },
    { id: "rereview", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}\n\nThis is the fixed work after your earlier review. Apply the same standard.\n\nGOAL:\n${input.task}`, dependsOn: ["fix"], inputs: [{ node: "fix" }], when: { node: "fix", exists: true }, maxAttempts: attempts },
    ...(gate ? [{ id: "accept", kind: "gate" as const, prompt: `Work for "${input.name ?? input.task.slice(0, 60)}" passed review. Approve to accept or reject to stop.`, dependsOn: ["review", "rereview"], when: { any: [{ node: "review", field: "text", includes: REVIEW_VERDICT_PASS }, { node: "rereview", field: "text", includes: REVIEW_VERDICT_PASS }] } }] : []),
  ]
}

/** Expands a named template into an ordinary definition; the caller may edit it before `create`. */
export function expandTemplate(raw: unknown): DagDefinition {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new DagValidationError("template input must be an object")
  const input = raw as Record<string, unknown>
  if (!DAG_TEMPLATE_NAMES.includes(input.template as DagTemplateName)) throw new DagValidationError(`Unknown DAG template: ${String(input.template)}; expected ${DAG_TEMPLATE_NAMES.join(" | ")}`)
  if (typeof input.task !== "string" || !input.task.trim()) throw new DagValidationError("template task must be a nonempty string")
  for (const key of ["name", "reviewer", "executor"]) if (input[key] !== undefined && (typeof input[key] !== "string" || !(input[key] as string).trim())) throw new DagValidationError(`template ${key} must be a nonempty string`)
  if (input.gate !== undefined && typeof input.gate !== "boolean") throw new DagValidationError("template gate must be a boolean")
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || (input.maxAttempts as number) < 1)) throw new DagValidationError("template maxAttempts must be a positive integer")
  const typed = input as unknown as DagTemplateInput
  const nodes = typed.template === "plan-review" ? planReview(typed) : goalReview(typed)
  return { schemaVersion: 1, name: typed.name ?? `${typed.template}: ${typed.task.slice(0, 60)}`, maxParallel: 1, nodes }
}
