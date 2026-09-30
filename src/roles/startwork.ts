import { execFileSync } from "node:child_process"
import type { DagDefinition, DagNodeDefinition } from "../dag/types"
import { REVIEW_VERDICT_FAIL, REVIEW_VERDICT_PASS } from "../dag/templates"
import { ticketMarker, type Plan } from "./plan"

/**
 * Fowler's code smells (Refactoring, ch. 3) as the Standards reviewer's baseline,
 * after Matt Pocock's code-review skill: judgement calls, and a documented repo
 * standard always overrides them.
 */
const SMELL_BASELINE = `Smell baseline (judgement calls; a documented repo standard overrides any of them): Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest.`

const VERDICT = `End your reply with exactly one line, "${REVIEW_VERDICT_PASS}" or "${REVIEW_VERDICT_FAIL}". FAIL only for findings that must be fixed before the work can be accepted; list those first.`

export function gitHead(directory: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || undefined
  } catch {
    return undefined
  }
}

const ticketNode = (id: string) => `t${id}`

/** `/start-work [plan] [--worktree [path]] [--make-pr] [--ship]`; --ship implies --make-pr, which implies a worktree. */
export interface StartWorkArgs {
  readonly plan: string
  readonly worktree: boolean
  readonly worktreePath?: string
  readonly makePr: boolean
  readonly ship: boolean
}

export function parseStartWork(args: string): { readonly ok: true; readonly args: StartWorkArgs } | { readonly ok: false; readonly error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let plan = "", worktree = false, worktreePath: string | undefined, makePr = false, ship = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--worktree") {
      worktree = true
      // A path is the next token when it looks like one; a bare word is the plan name.
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith("--") && /[/~.]/.test(next)) { worktreePath = next; i++ }
    } else if (token === "--make-pr") makePr = true
    else if (token === "--ship") ship = true
    else if (token.startsWith("--")) return { ok: false, error: `unknown /start-work option ${token}; expected --worktree [path], --make-pr or --ship` }
    else if (!plan) plan = token
    else return { ok: false, error: `unexpected argument "${token}"; name one plan` }
  }
  makePr ||= ship
  worktree ||= makePr
  return { ok: true, args: { plan, worktree, ...(worktreePath ? { worktreePath } : {}), makePr, ship } }
}

/** Where a worktree run delivers: its directory and branch, the main worktree, and how far to take the PR. */
export interface Delivery {
  readonly directory: string
  readonly branch: string
  readonly root: string
  readonly pr: boolean
  readonly ship: boolean
}

/**
 * Compiles an approved plan into a DAG: one Atlas node per ticket, each in its own
 * fresh session and gated on the tickets that block it, then a Standards review and
 * a Spec review side by side, one fix pass when either fails, and an accept gate.
 * Tickets run one at a time because they share the working tree.
 */
export function compilePlan(plan: Plan, base?: string, delivery?: Delivery): DagDefinition {
  const diff = base ? `git diff ${base}` : "git diff HEAD (and git status for new files)"
  const tickets: DagNodeDefinition[] = plan.tickets.map((ticket) => ({
    id: ticketNode(ticket.id),
    title: ticket.title,
    agent: "atlas",
    prompt: `${ticketMarker(plan.slug, ticket.id)}
Implement ticket ${ticket.id} of the approved plan "${plan.slug}" in this session, and only that ticket.
Read the spec ${plan.spec} and your ticket ${ticket.path}. Other tickets are context, not work: ${plan.tickets.filter((other) => other !== ticket).map((other) => other.path).join(", ") || "none"}.
Work test-first at the seams the spec names: one failing test, the smallest change that passes it, repeat. Run the type checker and the tests you touched as you go and the full suite once at the end.
Report the files you changed and, for every acceptance criterion in the ticket, the evidence that it holds (command and output).`,
    dependsOn: ticket.blockedBy.map(ticketNode),
    ...(ticket.blockedBy.length ? { inputs: ticket.blockedBy.map((id) => ({ node: ticketNode(id) })) } : {}),
    maxAttempts: 2,
  }))
  const all = tickets.map((node) => node.id)
  const failed = { any: ["review-standards", "review-spec"].map((node) => ({ node, field: "text", includes: REVIEW_VERDICT_FAIL })) }
  const pr: DagNodeDefinition[] = delivery?.pr ? [{ id: "pr", title: "Open the pull request", agent: "atlas", dependsOn: ["accept"], inputs: [{ node: "review-standards" }, { node: "review-spec" }, { node: "fix" }], maxAttempts: 2, prompt: `${ticketMarker(plan.slug, "pr")}
The work on plan "${plan.slug}" was accepted. Deliver it as a pull request from branch ${delivery.branch} in this worktree (${delivery.directory}):
1. Commit every change of the plan's work on ${delivery.branch} (split into a few meaningful commits in the repository's commit style when that helps a reviewer). Do not commit .iolaus/ unless it is already tracked.
2. Push the branch: git push -u origin ${delivery.branch}.
3. Open the PR with gh pr create against the repository's default branch. Body: what changed and why (from ${plan.spec}), the evidence that it works (commands and outputs from the reviews and ticket reports in <iolaus-dag-inputs>), and how risky it is to merge.
Report the PR URL on its own line as "PR: <url>".` }] : []
  const ship: DagNodeDefinition[] = delivery?.ship ? [{ id: "ship", title: "Ship the pull request", agent: "atlas", dependsOn: ["pr"], inputs: [{ node: "pr" }], maxAttempts: 2, prompt: `${ticketMarker(plan.slug, "ship")}
The PR for plan "${plan.slug}" is open (its URL is in <iolaus-dag-inputs>). Take it to merged:
1. Watch its checks with gh pr checks --watch. When a check fails, read its log, fix the cause on ${delivery.branch} within the plan's scope (${plan.spec}), push, and watch again. Address review comments the same way.
2. When every required check passes and the PR is mergeable, merge it with a merge commit (gh pr merge --merge).
3. Then remove this worktree from the main worktree: git -C ${delivery.root} worktree remove ${delivery.directory} (no --force; if it refuses, report what is left there instead).
Report the merge commit and whether the worktree was removed.` }] : []
  return {
    schemaVersion: 1,
    name: `start-work: ${plan.slug}`,
    maxParallel: 1,
    ...(delivery ? { directory: delivery.directory } : {}),
    nodes: [
      ...tickets,
      { id: "review-standards", title: "Review against the standards", agent: "momus", dependsOn: all, inputs: [{ node: "*" }], maxAttempts: 2, prompt: `Review the implementation of plan "${plan.slug}" on the Standards axis only: does the code follow this repository's documented standards (AGENTS.md, CLAUDE.md, CONTRIBUTING.md and similar, where present)? Read the change with ${diff}. The ticket reports are in <iolaus-dag-inputs>.
Report each violation with file, hunk and the rule it breaks; name baseline smells as judgement calls. Skip anything tooling already enforces. Do not judge whether the spec was met.
${SMELL_BASELINE}
${VERDICT}` },
      { id: "review-spec", title: "Review against the spec", agent: "momus", dependsOn: all, inputs: [{ node: "*" }], maxAttempts: 2, prompt: `Review the implementation of plan "${plan.slug}" on the Spec axis only: does the change do what ${plan.spec} and the tickets (${plan.tickets.map((ticket) => ticket.path).join(", ")}) ask? Read the change with ${diff}. The ticket reports are in <iolaus-dag-inputs>.
Report (a) requirements missing or partial, (b) behaviour that was not asked for, (c) requirements that look implemented but wrong, quoting the spec or ticket line for each. Do not judge code style.
${VERDICT}` },
      { id: "fix", title: "Fix the review findings", agent: "atlas", dependsOn: ["review-standards", "review-spec"], inputs: [{ node: "review-standards" }, { node: "review-spec" }], when: failed, maxAttempts: 2, prompt: `${ticketMarker(plan.slug, "review")}
The reviews of plan "${plan.slug}" are in <iolaus-dag-inputs>. Fix every finding marked as blocking, within the plan's scope (${plan.spec}), then re-run the affected tests and the full suite. Report each finding with what you changed and the evidence.` },
      { id: "accept", title: "Accept the plan's work", kind: "gate", dependsOn: ["review-standards", "review-spec", "fix"], inputs: [{ node: "review-standards" }, { node: "review-spec" }, { node: "fix" }], prompt: `Plan "${plan.slug}" is implemented (${plan.tickets.length} tickets${delivery ? ` on branch ${delivery.branch} in ${delivery.directory}` : ""}) and reviewed on the Standards and Spec axes. ${delivery?.ship ? "Approve to open the PR and merge it once CI passes" : delivery?.pr ? "Approve to open the PR" : "Approve to accept the work"} or reject to stop.` },
      ...pr,
      ...ship,
    ],
  }
}
