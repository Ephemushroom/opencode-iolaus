import { tmpdir } from "node:os"
import { Effect, type Scope } from "effect"
import { Agent, Model } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Options } from "./options"
import {
  AGENT_DESCRIPTIONS, CATEGORY_DESCRIPTIONS, PRIMARY_AGENTS, agentID, categoryID, modeMarker,
  type AgentName, type CategoryName, type ModeName,
} from "./prompts/catalog"
import { modelString, resolveLane, type LaneAssignment, type ModelsConfig } from "./models"
import { DAG_MODE_TEMPLATES } from "./prompts/mode-dag"
import { trace } from "./trace"

const READ_ONLY = new Set<AgentName>(["oracle", "librarian", "explore", "metis", "momus", "multimodal-looker"])

export function agentMarker(name: AgentName): string {
  return `<iolaus-agent:${name}>`
}

export function categoryMarker(name: CategoryName): string {
  return `<iolaus-category:${name}>`
}

export interface RegistrationPlan {
  readonly agents: Map<AgentName, LaneAssignment | undefined>
  readonly categories: Map<CategoryName, LaneAssignment | undefined>
}

export function planRegistration(options: Options, config: ModelsConfig): RegistrationPlan {
  return {
    agents: new Map(options.agents.map((name) => [name, resolveLane(name, config)])),
    categories: new Map(options.categories.map((name) => [name, resolveLane(name, config)])),
  }
}

function applyModel(agent: { model?: unknown }, assignment: LaneAssignment | undefined): void {
  if (!assignment) return
  agent.model = Model.Ref.parse(modelString(assignment)) as typeof agent.model
}

/**
 * Iolaus follows its models config directly: every registered lane carries a
 * pinned model, and a lane whose chain and config both name no model is not
 * registered. Provider connectivity and subscription state are not consulted.
 */
export function registerAgents(
  ctx: { agent: Pick<Context["agent"], "transform"> },
  options: Options,
  config: ModelsConfig = {},
): Effect.Effect<RegistrationPlan, never, Scope.Scope> {
  const plan = planRegistration(options, config)
  return ctx.agent.transform((editor) => {
    for (const [name, assignment] of plan.agents) {
      const id = agentID(name)
      const existing = editor.get(id)
      if (existing && existing.system !== agentMarker(name)) continue
      if (!assignment) {
        if (existing) editor.remove(id)
        trace("iolaus.agent.hidden", { agent: id, reason: "no configured model" })
        continue
      }
      editor.update(id, (agent) => {
        applyModel(agent, assignment)
        if (existing) return
        agent.name = Agent.Name.make(id)
        agent.description = AGENT_DESCRIPTIONS[name]
        agent.mode = PRIMARY_AGENTS.has(name) ? "primary" : "subagent"
        agent.system = agentMarker(name)
        if (READ_ONLY.has(name)) {
          agent.permissions.push({ action: "*", resource: "*", effect: "deny" })
          for (const action of ["read", "glob", "grep", "webfetch", "websearch", "skill", "execute", "context7_*", "grep_app_*"]) {
            agent.permissions.push({ action, resource: "*", effect: "allow" })
          }
        }
        if (name === "librarian") {
          // gh clones land under the OS temp dir; native read/grep there need external_directory.
          agent.permissions.push({ action: "gh", resource: "*", effect: "allow" },
            { action: "external_directory", resource: `${tmpdir()}/iolaus-gh-*`, effect: "allow" })
        }
        if (name === "prometheus") {
          agent.permissions.push({ action: "edit", resource: "*", effect: "deny" },
            { action: "edit", resource: ".iolaus/plans/*", effect: "allow" },
            { action: "shell", resource: "*", effect: "deny" })
        }
        if (name === "sisyphus-junior") {
          agent.permissions.push({ action: "subagent", resource: "*", effect: "deny" })
        }
      })
      trace("iolaus.agent.model", { agent: id, model: assignment.model, variant: assignment.variant ?? null, source: assignment.source })
    }
    for (const [name, assignment] of plan.categories) {
      const id = categoryID(name)
      const existing = editor.get(id)
      if (existing && existing.system !== categoryMarker(name)) continue
      if (!assignment) {
        if (existing) editor.remove(id)
        trace("iolaus.category.hidden", { category: id, reason: "no configured model" })
        continue
      }
      editor.update(id, (agent) => {
        applyModel(agent, assignment)
        if (existing) return
        agent.name = Agent.Name.make(id)
        agent.description = CATEGORY_DESCRIPTIONS[name]
        agent.mode = "subagent"
        agent.system = categoryMarker(name)
        agent.permissions.push({ action: "subagent", resource: "*", effect: "deny" })
      })
      trace("iolaus.agent.model", { agent: id, model: assignment.model, variant: assignment.variant ?? null, source: assignment.source })
    }
  }).pipe(Effect.as(plan))
}

export function modeDispatchText(mode: ModeName, task: string): string {
  return `${modeMarker(mode)}\n${task}`
}

export function registerModes(ctx: {
  command: Pick<Context["command"], "transform">
  session: Pick<Context["session"], "prompt">
}, options: Options): Effect.Effect<void, never, Scope.Scope> {
  return ctx.command.transform((editor) => {
    for (const mode of options.modes) {
      editor.add({
        name: `iolaus-${mode}`,
        description: DAG_MODE_TEMPLATES[mode]
          ? `Run the task as the Iolaus "${DAG_MODE_TEMPLATES[mode]}" DAG template under the retained OMO ${mode} prompt.`
          : `Apply the retained OMO ${mode} prompt with native OpenCode tools.`,
        execute: ({ sessionID, prompt, delivery }) => ctx.session.prompt({
          ...prompt,
          sessionID,
          text: modeDispatchText(mode, prompt.text ?? ""),
          delivery,
        }).pipe(Effect.tap(() => Effect.sync(() => trace("iolaus.mode.dispatched", { mode, sessionID, dag: DAG_MODE_TEMPLATES[mode] ?? null })))),
      })
    }
  }).pipe(Effect.asVoid)
}
