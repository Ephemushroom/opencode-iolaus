import { DagValidationError } from "./graph-error"
import type { DagDefinition, DagLoop, DagNodeDefinition } from "./types"
import { modeMarker } from "../prompts/catalog"
import { DAG_CHILD_MARKER } from "../prompts/mode-dag"
import { PLAN_FORMAT } from "../roles/plan"

export const DAG_TEMPLATE_NAMES = ["plan-review", "goal-review", "ultrawork", "hyperplan", "team"] as const
export type DagTemplateName = (typeof DAG_TEMPLATE_NAMES)[number]

export interface DagTemplateInput {
  readonly template: DagTemplateName
  /** The task, in the user's words. Becomes the planner's / worker's prompt body. */
  readonly task: string
  readonly name?: string
  /** Reviewer lane; defaults to `momus` for plans and `metis`-free `momus` for goals. */
  readonly reviewer?: string
  /** Executor lane for the post-approval step; defaults to `sisyphus`. */
  readonly executor?: string
  /** Set false to run the executor immediately after a passing review. Default true: a human gate sits between review and execution. */
  readonly gate?: boolean
  /** Review attempts before the run fails (planner and reviewer each get this many). Default 2. */
  readonly maxAttempts?: number
  /** ultrawork: work/review rounds before the loop gives up. Default 3. */
  readonly iterations?: number
  /** hyperplan: adversarial member lanes. Default unspecified-low, unspecified-high, ultrabrain, artistry. team: worker lanes, repeats allowed. Default two deep-low. */
  readonly members?: readonly string[]
  /** team: the lane that splits the work and integrates the branches. Default unspecified-high. */
  readonly lead?: string
}

export const REVIEW_VERDICT_PASS = "VERDICT: PASS"
export const REVIEW_VERDICT_FAIL = "VERDICT: FAIL"

const REVIEW_INSTRUCTIONS = `You are the reviewer node of an Iolaus DAG. The upstream result is in <iolaus-dag-inputs>. Judge it against the task below. Be concrete: name each defect with where it is and what would fix it. End your reply with exactly one line, either "${REVIEW_VERDICT_PASS}" or "${REVIEW_VERDICT_FAIL}", followed by nothing else.`

function planReview(input: DagTemplateInput): DagNodeDefinition[] {
  const attempts = input.maxAttempts ?? 2
  const reviewer = input.reviewer ?? "momus"
  const executor = input.executor ?? "sisyphus"
  const gate = input.gate !== false
  return [
    { id: "plan", title: "Write the plan", agent: "prometheus", prompt: `Write the work plan for this task into .iolaus/plans/ and return the plan text in full.\n${PLAN_FORMAT}\n\nTASK:\n${input.task}`, dependsOn: [], maxAttempts: attempts },
    { id: "review", title: "Review the plan", kind: "judge", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}\n\nA plan passes only if every step is verifiable, no step depends on unstated assumptions, and the plan covers the whole task.\n\nTASK:\n${input.task}`, dependsOn: ["plan"], inputs: [{ node: "plan" }], maxAttempts: attempts },
    { id: "revise", title: "Revise the plan", agent: "prometheus", prompt: `The reviewer rejected the plan. Address every defect named in the review, rewrite the plan in .iolaus/plans/, and return the revised plan in full.\n\nTASK:\n${input.task}`, dependsOn: ["review"], inputs: [{ node: "plan" }, { node: "review" }], when: { node: "review", field: "text", includes: REVIEW_VERDICT_FAIL }, maxAttempts: attempts },
    { id: "rereview", title: "Re-review the revised plan", kind: "judge", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}\n\nThis is the revised plan after your earlier review. Apply the same standard.\n\nTASK:\n${input.task}`, dependsOn: ["revise"], inputs: [{ node: "revise" }], when: { node: "revise", exists: true }, maxAttempts: attempts },
    ...(gate ? [{ id: "approve", title: "Approve the plan", kind: "gate" as const, prompt: `Plan for "${input.name ?? input.task.slice(0, 60)}" passed review. Approve to start execution or reject to stop.`, dependsOn: ["review", "rereview"], when: { any: [{ node: "review", field: "text", includes: REVIEW_VERDICT_PASS }, { node: "rereview", field: "text", includes: REVIEW_VERDICT_PASS }] } }] : []),
    { id: "execute", title: "Execute the approved plan", agent: executor, prompt: `Execute the approved plan exactly. The plan is in <iolaus-dag-inputs>; prefer the revised plan when present. Report what was done and how it was verified.\n\nTASK:\n${input.task}`, dependsOn: gate ? ["approve"] : ["review", "rereview"], inputs: [{ node: "plan" }, { node: "revise" }], ...(gate ? {} : { when: { any: [{ node: "review", field: "text", includes: REVIEW_VERDICT_PASS }, { node: "rereview", field: "text", includes: REVIEW_VERDICT_PASS }] } }) },
  ]
}

function goalReview(input: DagTemplateInput): DagNodeDefinition[] {
  const attempts = input.maxAttempts ?? 2
  const reviewer = input.reviewer ?? "momus"
  const executor = input.executor ?? "hephaestus"
  const gate = input.gate !== false
  return [
    { id: "work", title: "Do the work", agent: executor, prompt: `Achieve this goal end to end and report what changed and how you verified it.\n\nGOAL:\n${input.task}`, dependsOn: [], maxAttempts: attempts },
    { id: "review", title: "Review the work", kind: "judge", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}\n\nThe work passes only if the goal is met, the reported verification is real (commands and outputs, not claims), and nothing out of scope was changed.\n\nGOAL:\n${input.task}`, dependsOn: ["work"], inputs: [{ node: "work" }], maxAttempts: attempts },
    { id: "fix", title: "Fix the review findings", agent: executor, prompt: `The reviewer rejected the work. Fix every defect named in the review and report the verification again.\n\nGOAL:\n${input.task}`, dependsOn: ["review"], inputs: [{ node: "work" }, { node: "review" }], when: { node: "review", field: "text", includes: REVIEW_VERDICT_FAIL }, maxAttempts: attempts },
    { id: "rereview", title: "Re-review the fix", kind: "judge", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}\n\nThis is the fixed work after your earlier review. Apply the same standard.\n\nGOAL:\n${input.task}`, dependsOn: ["fix"], inputs: [{ node: "fix" }], when: { node: "fix", exists: true }, maxAttempts: attempts },
    ...(gate ? [{ id: "accept", title: "Accept the work", kind: "gate" as const, prompt: `Work for "${input.name ?? input.task.slice(0, 60)}" passed review. Approve to accept or reject to stop.`, dependsOn: ["review", "rereview"], when: { any: [{ node: "review", field: "text", includes: REVIEW_VERDICT_PASS }, { node: "rereview", field: "text", includes: REVIEW_VERDICT_PASS }] } }] : []),
  ]
}

const PASS_ANY = (reviews: readonly string[]) => ({ any: reviews.map((node) => ({ node, field: "text", includes: REVIEW_VERDICT_PASS })) })

/**
 * The ultrawork loop, unrolled: each round is fix → review guarded by the previous
 * verdict, so the graph stays static, durable and fingerprintable while behaving
 * as "keep going until the reviewer passes, at most `iterations` rounds". Worker
 * prompts start with the ultrawork mode marker so the child session gets the
 * full ultrawork prompt.
 */
/**
 * The ultrawork loop, dynamic: one work/review pair plus a `loop` spec. When the
 * newest review settles FAIL the scheduler appends `fix<n>` / `review<n>` (up to
 * `iterations` rounds) and rewires the accept gate to the newest review, so the
 * graph only grows as far as the work actually needs. The reviewer is a judge
 * node: one model call, no child session.
 */
function ultrawork(input: DagTemplateInput): { readonly nodes: DagNodeDefinition[]; readonly loop: DagLoop } {
  const attempts = input.maxAttempts ?? 2
  const rounds = input.iterations ?? 3
  const reviewer = input.reviewer ?? "momus"
  const executor = input.executor ?? "sisyphus"
  const gate = input.gate !== false
  const marker = `${modeMarker("ultrawork")}\n${DAG_CHILD_MARKER}`
  const standard = `The work passes only if every scenario in the contract is met with real evidence (commands and outputs, not claims), the real-surface artifact is present, and nothing out of scope was changed.`
  const reviewerPrompt = (intro: string) => `${REVIEW_INSTRUCTIONS}\n\n${intro}${standard}\n\nGOAL:\n${input.task}`
  const nodes: DagNodeDefinition[] = [
    { id: "work", title: "Do the work", agent: executor, prompt: `${marker}\nAchieve this goal end to end. Report the scenario contract, what changed, and the verification evidence for each scenario.\n\nGOAL:\n${input.task}`, dependsOn: [], maxAttempts: attempts },
    { id: "review", title: "Review the work", kind: "judge", agent: reviewer, prompt: reviewerPrompt(""), dependsOn: ["work"], inputs: [{ node: "work" }], maxAttempts: attempts },
    ...(gate ? [{ id: "accept", title: "Accept the work", kind: "gate" as const, prompt: `Ultrawork for "${input.name ?? input.task.slice(0, 60)}" passed review. Approve to accept or reject to stop.`, dependsOn: ["review"], when: { node: "review", field: "text", includes: REVIEW_VERDICT_PASS } }] : []),
  ]
  const loop: DagLoop = {
    review: "review", fix: "work",
    executorPrompt: `${marker}\nRound {round}: the reviewer rejected the work. Fix every defect named in the review, re-run the verification, and report the evidence again.\n\nGOAL:\n${input.task}`,
    reviewerPrompt: reviewerPrompt("Round {round}: this is the fixed work after your earlier review. Apply the same standard.\n\n"),
    failIncludes: REVIEW_VERDICT_FAIL, passIncludes: REVIEW_VERDICT_PASS,
    maxRounds: rounds,
    ...(gate ? { tail: ["accept"] } : {}),
  }
  return { nodes, loop }
}

const HYPERPLAN_MEMBERS = ["unspecified-low", "unspecified-high", "ultrabrain", "artistry"] as const

/** Adversarial planning: independent analysis, cross-attack, defend, distill, then Prometheus plans and Momus reviews. */
function hyperplan(input: DagTemplateInput): DagNodeDefinition[] {
  const attempts = input.maxAttempts ?? 2
  const members = input.members ?? HYPERPLAN_MEMBERS
  const reviewer = input.reviewer ?? "momus"
  const gate = input.gate !== false
  const short = (lane: string) => lane.replace(/^iolaus-/, "")
  const analyze = members.map((lane) => `analyze-${short(lane)}`)
  const attack = members.map((lane) => `attack-${short(lane)}`)
  const defend = members.map((lane) => `defend-${short(lane)}`)
  return [
    ...members.map((lane, i) => ({ id: analyze[i], title: `Analyse (${short(lane)})`, agent: lane, prompt: `Round 1 of an adversarial planning session. Independently analyse this planning request: constraints, risks, hidden assumptions, and the approach you would take. Do not write the plan. Be specific and cite evidence from the codebase where relevant.

REQUEST:
${input.task}`, dependsOn: [], maxAttempts: attempts })),
    ...members.map((lane, i) => ({ id: attack[i], title: `Attack the others (${short(lane)})`, agent: lane, prompt: `Round 2. The other members' analyses are in <iolaus-dag-inputs>. Attack them ruthlessly: name every weak claim, missing risk, and unverified assumption, with the reason. Do not defend your own analysis here.

REQUEST:
${input.task}`, dependsOn: analyze, inputs: [{ node: "*" }], maxAttempts: attempts })),
    ...members.map((lane, i) => ({ id: defend[i], title: `Defend the position (${short(lane)})`, agent: lane, prompt: `Round 3. The attacks are in <iolaus-dag-inputs>. For each attack on your position: defend it with evidence, refine it, or concede. End with the claims you still stand behind.

REQUEST:
${input.task}`, dependsOn: attack, inputs: [{ node: "*" }], maxAttempts: attempts })),
    { id: "distill", title: "Distill the positions", agent: "metis", prompt: `Distill the defended positions in <iolaus-dag-inputs> into a structured bundle for the planner: agreed facts, surviving risks, rejected approaches with reasons, open questions. Do not write the plan.

REQUEST:
${input.task}`, dependsOn: defend, inputs: [{ node: "*" }], maxAttempts: attempts },
    { id: "plan", title: "Write the plan", agent: "prometheus", prompt: `Write the work plan for this request into .iolaus/plans/ using the distilled bundle in <iolaus-dag-inputs>. You own sequencing, parallelisation and verification gates. Return the plan text in full.
${PLAN_FORMAT}

REQUEST:
${input.task}`, dependsOn: ["distill"], inputs: [{ node: "distill" }], maxAttempts: attempts },
    { id: "review", title: "Review the plan", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}

A plan passes only if every step is verifiable, the surviving risks from the bundle are addressed, and the plan covers the whole request.

REQUEST:
${input.task}`, dependsOn: ["plan"], inputs: [{ node: "plan" }, { node: "distill" }], maxAttempts: attempts },
    ...(gate ? [{ id: "approve", title: "Approve the plan", kind: "gate" as const, prompt: `Hyperplan for "${input.name ?? input.task.slice(0, 60)}" passed review. Approve to accept the plan or reject to stop.`, dependsOn: ["review"], when: { node: "review", field: "text", includes: REVIEW_VERDICT_PASS } }] : []),
  ]
}

const TEAM_MEMBERS = ["deep-low", "deep-low"] as const

/**
 * Team: the lead splits the task into one assignment per member; members work in
 * parallel, each in its own git worktree and branch; the lead merges their branches
 * in an integration worktree and runs the checks; a reviewer judges the integrated
 * branch; a human accepts it. The user's working tree is never touched: the
 * integration branch is theirs to merge.
 */
function team(input: DagTemplateInput): DagNodeDefinition[] {
  const attempts = input.maxAttempts ?? 2
  const members = input.members ?? TEAM_MEMBERS
  const lead = input.lead ?? "unspecified-high"
  const reviewer = input.reviewer ?? "momus"
  const gate = input.gate !== false
  const ids = members.map((_, i) => `member${i + 1}`)
  return [
    { id: "split", title: "Split the work", agent: lead, prompt: `You lead a team of ${members.length} workers (${members.join(", ")}) on this task. Read the codebase as needed, then split the task into exactly ${members.length} assignments that can be built in parallel on separate branches with the fewest overlapping files. Do not edit files.
Reply with one section per assignment, headed "## Assignment <n>" for n = 1..${members.length}, each saying what to build, which files it owns, the interfaces it shares with the others, and how to verify it. Then a "## Integration" section: merge order and the checks that prove the whole works.

TASK:
${input.task}`, dependsOn: [], maxAttempts: attempts },
    ...members.map((lane, i) => ({ id: ids[i], title: `Assignment ${i + 1} (${lane})`, agent: lane, worktree: true, prompt: `The lead's split of the task is in <iolaus-dag-inputs>. Do only "## Assignment ${i + 1}", within the files it owns, in your worktree. Verify it as the assignment says, commit it to your branch, and report what changed, the evidence, and the branch name as a final line "BRANCH: <branch>".

TASK:
${input.task}`, dependsOn: ["split"], inputs: [{ node: "split" }], maxAttempts: attempts })),
    { id: "integrate", title: "Integrate the branches", agent: lead, worktree: true, prompt: `Integrate the team's work in your worktree. The split and every member's report (with its "BRANCH:" line) are in <iolaus-dag-inputs>. Merge each member branch into your branch with git merge --no-ff in the split's merge order, resolve conflicts by the split's interfaces, then run the integration checks, the type checker and the full test suite, and fix what the merge broke. Commit, and report the merged branches, the checks with their output, and your branch as a final line "BRANCH: <branch>".

TASK:
${input.task}`, dependsOn: ids, inputs: [{ node: "split" }, ...ids.map((node) => ({ node }))], maxAttempts: attempts },
    { id: "review", title: "Review the integrated work", kind: "judge", agent: reviewer, prompt: `${REVIEW_INSTRUCTIONS}

The work passes only if every assignment is done, the integration checks ran with real output and passed, and nothing out of scope changed.

TASK:
${input.task}`, dependsOn: ["integrate"], inputs: [{ node: "split" }, { node: "integrate" }], maxAttempts: attempts },
    ...(gate ? [{ id: "accept", title: "Accept the team's branch", kind: "gate" as const, prompt: `Team work for "${input.name ?? input.task.slice(0, 60)}" is integrated on the branch named in the integrate result and passed review. Approve to accept it (merging that branch is yours to do) or reject to stop.`, dependsOn: ["review"], inputs: [{ node: "integrate" }, { node: "review" }], when: { node: "review", field: "text", includes: REVIEW_VERDICT_PASS } }] : []),
  ]
}

/** Expands a named template into an ordinary definition; the caller may edit it before `create`. */
export function expandTemplate(raw: unknown): DagDefinition {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new DagValidationError("template input must be an object")
  const input = raw as Record<string, unknown>
  if (!DAG_TEMPLATE_NAMES.includes(input.template as DagTemplateName)) throw new DagValidationError(`Unknown DAG template: ${String(input.template)}; expected ${DAG_TEMPLATE_NAMES.join(" | ")}`)
  if (typeof input.task !== "string" || !input.task.trim()) throw new DagValidationError("template task must be a nonempty string")
  for (const key of ["name", "reviewer", "executor", "lead"]) if (input[key] !== undefined && (typeof input[key] !== "string" || !(input[key] as string).trim())) throw new DagValidationError(`template ${key} must be a nonempty string`)
  if (input.gate !== undefined && typeof input.gate !== "boolean") throw new DagValidationError("template gate must be a boolean")
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || (input.maxAttempts as number) < 1)) throw new DagValidationError("template maxAttempts must be a positive integer")
  if (input.iterations !== undefined && (!Number.isInteger(input.iterations) || (input.iterations as number) < 1 || (input.iterations as number) > 10)) throw new DagValidationError("template iterations must be an integer from 1 to 10")
  // Team members may repeat a lane (two deep-low workers); hyperplan members must differ, or the debate has one voice.
  if (input.members !== undefined && (!Array.isArray(input.members) || input.members.length < 2 || input.members.length > 8 || input.members.some((m) => typeof m !== "string" || !m.trim()) || (input.template !== "team" && new Set(input.members).size !== input.members.length))) throw new DagValidationError(input.template === "team" ? "template members must be two to eight lane names" : "template members must be at least two distinct lane names")
  const typed = input as unknown as DagTemplateInput
  const built = typed.template === "plan-review" ? { nodes: planReview(typed) } : typed.template === "goal-review" ? { nodes: goalReview(typed) } : typed.template === "ultrawork" ? ultrawork(typed) : typed.template === "team" ? { nodes: team(typed) } : { nodes: hyperplan(typed) }
  const maxParallel = typed.template === "hyperplan" ? (typed.members ?? HYPERPLAN_MEMBERS).length : typed.template === "team" ? (typed.members ?? TEAM_MEMBERS).length : 1
  return { schemaVersion: 1, name: typed.name ?? `${typed.template}: ${typed.task.slice(0, 60)}`, maxParallel, nodes: built.nodes, ...("loop" in built ? { loop: built.loop } : {}) }
}
