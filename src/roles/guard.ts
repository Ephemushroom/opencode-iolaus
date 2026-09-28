import { isAbsolute, relative, resolve, sep } from "node:path"
import { MUTATION_TOOLS } from "../verify/config"
import { mutatedPaths } from "../verify/run"
import { expandTemplate } from "../dag/templates"
import { PLANNING_MARKER, PLANNING_NOTICE, PLANS_DIR } from "./plan"

/**
 * Role policy for one tool call, decided in code before the tool runs.
 * - `planner`: Prometheus. Writes only plan and domain files, no shell, and starts
 *   only planning runs. Codemods are left to ast_grep's own per-file edit re-check,
 *   which already applies Prometheus's permission rules.
 * - `planning`: any session a planner started (subagents and DAG nodes carry the
 *   planning notice). The planner rules, plus no applied codemods, since its agent's
 *   own permissions do not know it is planning.
 * - `atlas-unbound`: Atlas outside a /start-work plan. Read only.
 * - `atlas-orchestrator`: the Atlas session that ran /start-work. Operates the run,
 *   changes nothing itself; its tickets run in their own sessions.
 * - `worker`: every other Iolaus session. Unrestricted by role.
 * - `native`: host and user agents. Untouched.
 */
export type Policy = "planner" | "planning" | "atlas-unbound" | "atlas-orchestrator" | "worker" | "native"

/** Session roles the prompt hook records from markers and /start-work; they outlive the agent choice. */
export interface RoleRecord {
  readonly role: "planning" | "ticket" | "orchestrator"
  readonly plan?: string
  readonly runID?: string
}

/**
 * Policy for an Iolaus agent or lane. A planning role is sticky whatever agent the
 * session runs; Atlas needs a /start-work role, and a ticket role only counts while
 * its plan is still valid on disk.
 */
export function resolvePolicy(agent: string, role: RoleRecord | undefined, ticketPlanValid: boolean): Policy {
  if (role?.role === "planning") return "planning"
  if (agent === "prometheus") return "planner"
  if (agent !== "atlas") return "worker"
  if (role?.role === "orchestrator") return "atlas-orchestrator"
  return role?.role === "ticket" && ticketPlanValid ? "worker" : "atlas-unbound"
}

/** Templates a planner may start: planning only, since every node it starts is read-only. */
export const PLANNER_TEMPLATES: ReadonlySet<string> = new Set(["hyperplan"])

export function plannerWritable(directory: string, path: string): boolean {
  const rel = relative(directory, resolve(directory, path)).split(sep).join("/")
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false
  return rel.startsWith(`${PLANS_DIR}/`) || rel === "CONTEXT.md" || rel === "CONTEXT-MAP.md" || rel.endsWith("/CONTEXT.md")
    || rel.startsWith("docs/adr/") || rel.includes("/docs/adr/")
}

function record(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

const appliesCodemod = (tool: string, input: unknown) => tool.startsWith("ast_grep") && record(input)?.apply === true
const startsWork = (input: unknown) => ["create", "amend"].includes(String(record(input)?.action))
const changes = (tool: string, input: unknown) => MUTATION_TOOLS.has(tool) || tool === "shell" || tool === "subagent" || appliesCodemod(tool, input)

export const ATLAS_UNBOUND = "Atlas works only on a plan Prometheus wrote: plan with Prometheus into .iolaus/plans/<plan>/, then run /start-work <plan>. Until then Atlas may read but not edit, run shell, delegate or start DAG runs."
export const ATLAS_ORCHESTRATOR = "This Atlas session orchestrates a /start-work run: each ticket is implemented in its own fresh Atlas session. Operate the run with iolaus_dag (wait, snapshot, node, retry; approve or reject only on the user's word) instead of changing files here."

export function denial(policy: Policy, tool: string, input: unknown, directory: string): string | undefined {
  switch (policy) {
    case "native":
    case "worker": return undefined
    case "atlas-unbound": return changes(tool, input) || (tool === "iolaus_dag" && startsWork(input)) ? ATLAS_UNBOUND : undefined
    case "atlas-orchestrator": return changes(tool, input) || (tool === "iolaus_dag" && startsWork(input)) ? ATLAS_ORCHESTRATOR : undefined
  }
  if (MUTATION_TOOLS.has(tool)) {
    const paths = mutatedPaths(input, directory)
    if (!paths.length) return "Planning sessions may only write plan and domain files, and this edit names no file path."
    const blocked = paths.filter((path) => !plannerWritable(directory, path)).map((path) => relative(directory, path) || path)
    if (blocked.length) return `Planning is read-only outside ${PLANS_DIR}/, CONTEXT.md, CONTEXT-MAP.md and docs/adr/. Blocked: ${blocked.join(", ")}. Record the change as a ticket in the plan; implementation starts when the user runs /start-work <plan>. Delegating it is still implementing.`
    return undefined
  }
  if (tool === "shell") return "Planning sessions run no shell commands. Use read, grep, glob and ast_grep search to inspect the workspace."
  if (policy === "planning" && appliesCodemod(tool, input)) return "Planning sessions may not apply codemods; preview with apply: false."
  if (tool === "iolaus_dag" && startsWork(input)) {
    const template = record(record(input)?.template)?.template
    if (record(input)?.definition === undefined && typeof template === "string" && !PLANNER_TEMPLATES.has(template)) {
      return `A planner may start only planning runs (${[...PLANNER_TEMPLATES].join(", ")}, or a custom definition, whose nodes then run read-only). "${template}" implements; it starts when the user runs /start-work <plan> or /ultrawork.`
    }
  }
  return undefined
}

function withNotice(prompt: string): string {
  return prompt.includes(PLANNING_MARKER) ? prompt : `${prompt}\n\n${PLANNING_NOTICE}`
}

/**
 * A planner's subagents and DAG nodes inherit the planning policy: their prompt
 * gains the planning notice, which the prompt hook reads back when the child
 * session starts. The notice goes last so a leading mode marker still selects the
 * child's mode prompt. Mutates the tool input in place; the host runs the tool on it.
 */
export function inheritPlanning(tool: string, input: unknown): boolean {
  const args = record(input)
  if (!args) return false
  if (tool === "subagent" && typeof args.prompt === "string") {
    args.prompt = withNotice(args.prompt)
    return true
  }
  if (tool !== "iolaus_dag" || !startsWork(args)) return false
  let definition = record(args.definition)
  if (!definition && args.template !== undefined) {
    try { definition = expandTemplate(args.template) as unknown as Record<string, unknown> } catch { return false }
  }
  if (!definition || !Array.isArray(definition.nodes)) return false
  args.definition = {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const value = record(node)
      if (!value || value.kind === "gate" || value.kind === "judge" || typeof value.prompt !== "string") return node
      return { ...value, prompt: withNotice(value.prompt) }
    }),
  }
  delete args.template
  return true
}
