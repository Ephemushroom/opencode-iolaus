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

/**
 * Compiles an approved plan into a DAG: one Atlas node per ticket, each in its own
 * fresh session and gated on the tickets that block it, then a Standards review and
 * a Spec review side by side, one fix pass when either fails, and an accept gate.
 * Tickets run one at a time because they share the working tree.
 */
export function compilePlan(plan: Plan, base?: string): DagDefinition {
  const diff = base ? `git diff ${base}` : "git diff HEAD (and git status for new files)"
  const tickets: DagNodeDefinition[] = plan.tickets.map((ticket) => ({
    id: ticketNode(ticket.id),
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
  return {
    schemaVersion: 1,
    name: `start-work: ${plan.slug}`,
    maxParallel: 1,
    nodes: [
      ...tickets,
      { id: "review-standards", agent: "momus", dependsOn: all, inputs: [{ node: "*" }], maxAttempts: 2, prompt: `Review the implementation of plan "${plan.slug}" on the Standards axis only: does the code follow this repository's documented standards (AGENTS.md, CLAUDE.md, CONTRIBUTING.md and similar, where present)? Read the change with ${diff}. The ticket reports are in <iolaus-dag-inputs>.
Report each violation with file, hunk and the rule it breaks; name baseline smells as judgement calls. Skip anything tooling already enforces. Do not judge whether the spec was met.
${SMELL_BASELINE}
${VERDICT}` },
      { id: "review-spec", agent: "momus", dependsOn: all, inputs: [{ node: "*" }], maxAttempts: 2, prompt: `Review the implementation of plan "${plan.slug}" on the Spec axis only: does the change do what ${plan.spec} and the tickets (${plan.tickets.map((ticket) => ticket.path).join(", ")}) ask? Read the change with ${diff}. The ticket reports are in <iolaus-dag-inputs>.
Report (a) requirements missing or partial, (b) behaviour that was not asked for, (c) requirements that look implemented but wrong, quoting the spec or ticket line for each. Do not judge code style.
${VERDICT}` },
      { id: "fix", agent: "atlas", dependsOn: ["review-standards", "review-spec"], inputs: [{ node: "review-standards" }, { node: "review-spec" }], when: failed, maxAttempts: 2, prompt: `${ticketMarker(plan.slug, "review")}
The reviews of plan "${plan.slug}" are in <iolaus-dag-inputs>. Fix every finding marked as blocking, within the plan's scope (${plan.spec}), then re-run the affected tests and the full suite. Report each finding with what you changed and the evidence.` },
      { id: "accept", kind: "gate", dependsOn: ["review-standards", "review-spec", "fix"], inputs: [{ node: "review-standards" }, { node: "review-spec" }, { node: "fix" }], prompt: `Plan "${plan.slug}" is implemented (${plan.tickets.length} tickets) and reviewed on the Standards and Spec axes. Approve to accept the work or reject to stop.` },
    ],
  }
}
