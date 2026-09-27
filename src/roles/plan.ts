import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * A plan is the hand-off from Prometheus to Atlas: `.iolaus/plans/<slug>/spec.md`
 * plus `tickets/NN-<name>.md`, one tracer-bullet slice per ticket, each naming the
 * tickets that block it on a `**Blocked by:**` line (Matt Pocock's local ticket
 * template). Paths returned here are relative to the project directory so they can
 * be pasted into child prompts as context pointers.
 */
export const PLANS_DIR = ".iolaus/plans"
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TICKET_FILE = /^(\d{2,3})-.+\.md$/

export const PLAN_FORMAT = `Iolaus plan format (checked by the plugin before /start-work accepts it):
- ${PLANS_DIR}/<plan>/spec.md: problem, solution, user stories, implementation decisions, testing decisions (the seams to test at), out of scope. No file paths or code snippets.
- ${PLANS_DIR}/<plan>/tickets/NN-<name>.md, one per tracer-bullet vertical slice that fits one fresh context window. Each starts with "# NN: <title>", has a line "**Blocked by:** None" or "**Blocked by:** 01, 02", then what to build and "- [ ]" acceptance criteria.
- <plan> is lowercase letters, digits, ".", "_" or "-".`

/**
 * Prompt markers the plugin reads back in the prompt hook. A session whose prompt
 * carries the planning marker is read-only; one that carries a ticket marker for a
 * valid plan may run Atlas. Markers are trusted only for what they unlock: a valid
 * plan still has to exist on disk.
 */
export const PLANNING_MARKER = "<iolaus-planning>"
export const PLANNING_NOTICE = `${PLANNING_MARKER}
This session consults for a planning run and is read-only: Iolaus blocks file edits and shell here. Report findings and recommendations; do not implement.`
export const TICKET_MARKER = /<iolaus-plan-ticket plan="([a-z0-9][a-z0-9._-]{0,63})"/

export function ticketMarker(plan: string, ticket: string): string {
  return `<iolaus-plan-ticket plan="${plan}" ticket="${ticket}">`
}

export interface PlanTicket {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly blockedBy: readonly string[]
}

export interface Plan {
  readonly slug: string
  readonly spec: string
  readonly tickets: readonly PlanTicket[]
}

export type PlanResult = { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly errors: readonly string[] }

export function listPlans(directory: string): string[] {
  const root = join(directory, PLANS_DIR)
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => SLUG.test(name) && statSync(join(root, name)).isDirectory()).sort()
}

export function loadPlan(directory: string, slug: string): PlanResult {
  if (!SLUG.test(slug)) return { ok: false, errors: [`"${slug}" is not a plan name (lowercase letters, digits, ".", "_", "-")`] }
  const errors: string[] = []
  const spec = `${PLANS_DIR}/${slug}/spec.md`
  if (!existsSync(join(directory, spec)) || !readFileSync(join(directory, spec), "utf8").trim()) errors.push(`${spec} is missing or empty`)
  const ticketDir = join(directory, PLANS_DIR, slug, "tickets")
  const files = existsSync(ticketDir) ? readdirSync(ticketDir).filter((file) => file.endsWith(".md")).sort() : []
  if (!files.length) errors.push(`${PLANS_DIR}/${slug}/tickets/ has no NN-<name>.md ticket`)
  const tickets: PlanTicket[] = []
  for (const file of files) {
    const path = `${PLANS_DIR}/${slug}/tickets/${file}`
    const id = file.match(TICKET_FILE)?.[1]
    if (!id) { errors.push(`${path}: ticket files are named NN-<name>.md`); continue }
    const text = readFileSync(join(ticketDir, file), "utf8")
    const line = text.match(/^\*\*Blocked by:\*\*(.*)$/m)?.[1]
    if (line === undefined) { errors.push(`${path}: missing the "**Blocked by:**" line`); continue }
    const numbers = [...new Set(line.match(/\b\d{2,3}\b/g) ?? [])]
    if (!numbers.length && !/\bnone\b/i.test(line)) { errors.push(`${path}: "**Blocked by:**" names no ticket numbers; write None when nothing blocks it`); continue }
    tickets.push({ id, title: text.match(/^#\s+(.+)$/m)?.[1].trim() ?? file, path, blockedBy: numbers })
  }
  const byNumber = new Map<number, PlanTicket>()
  for (const ticket of tickets) {
    const other = byNumber.get(Number(ticket.id))
    if (other) errors.push(`${ticket.path} and ${other.path} share ticket number ${ticket.id}`)
    else byNumber.set(Number(ticket.id), ticket)
  }
  const resolved = tickets.map((ticket) => ({
    ...ticket,
    blockedBy: ticket.blockedBy.flatMap((number) => {
      const blocker = byNumber.get(Number(number))
      if (!blocker) { errors.push(`${ticket.path}: blocked by unknown ticket ${number}`); return [] }
      if (blocker === ticket) { errors.push(`${ticket.path}: blocks itself`); return [] }
      return [blocker.id]
    }),
  }))
  const edges = new Map(resolved.map((ticket) => [ticket.id, ticket.blockedBy]))
  const state = new Map<string, "visiting" | "done">()
  const visit = (id: string): boolean => {
    if (state.get(id) === "done") return false
    if (state.get(id) === "visiting") return true
    state.set(id, "visiting")
    const cyclic = (edges.get(id) ?? []).some(visit)
    state.set(id, "done")
    return cyclic
  }
  if (resolved.some((ticket) => visit(ticket.id))) errors.push(`${PLANS_DIR}/${slug}/tickets/: the "Blocked by" edges form a cycle`)
  return errors.length ? { ok: false, errors } : { ok: true, plan: { slug, spec, tickets: resolved } }
}

/** `/start-work` without a name picks the only valid plan; anything else must be named. */
export function resolvePlan(directory: string, argument: string): PlanResult {
  const name = argument.trim().split(/\s+/)[0] ?? ""
  if (name) return loadPlan(directory, name)
  const plans = listPlans(directory)
  const valid = plans.map((slug) => loadPlan(directory, slug)).filter((result): result is Extract<PlanResult, { ok: true }> => result.ok)
  if (valid.length === 1) return valid[0]
  return { ok: false, errors: [plans.length ? `name the plan: /start-work <plan> (in ${PLANS_DIR}: ${plans.join(", ")})` : `no plan in ${PLANS_DIR}/; plan it with Prometheus first`] }
}
