import { Agent, Model } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Options } from "./options"
import {
  AGENT_DESCRIPTIONS, CATEGORY_DESCRIPTIONS, PRIMARY_AGENTS, agentID, categoryID, modeMarker,
  type AgentName, type CategoryName,
} from "./prompts/catalog"
import { modelString, resolveLane, type LaneAssignment, type ModelsConfig } from "./models"
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
export async function registerAgents(
  ctx: { agent: Pick<Context["agent"], "transform"> },
  options: Options,
  config: ModelsConfig = {},
): Promise<RegistrationPlan> {
  const plan = planRegistration(options, config)
  await ctx.agent.transform((editor) => {
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
          for (const action of ["read", "glob", "grep", "webfetch", "websearch", "skill", "execute"]) {
            agent.permissions.push({ action, resource: "*", effect: "allow" })
          }
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
  })
  return plan
}

export async function registerModes(ctx: {
  command: Pick<Context["command"], "transform">
  session: Pick<Context["session"], "prompt">
}, options: Options): Promise<void> {
  await ctx.command.transform((editor) => {
    for (const mode of options.modes) {
      editor.add({
        name: `iolaus-${mode}`,
        description: `Apply the retained OMO ${mode} prompt with native OpenCode tools.`,
        async execute({ sessionID, prompt, delivery }) {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `${modeMarker(mode)}\n${prompt.text ?? ""}`,
            delivery,
          })
          trace("iolaus.mode.dispatched", { mode, sessionID })
        },
      })
    }
  })
}
