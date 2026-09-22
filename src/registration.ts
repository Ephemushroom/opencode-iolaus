import { Agent } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Options } from "./options"
import { AGENT_DESCRIPTIONS, agentID, modeMarker, type AgentName } from "./prompts/catalog"
import { trace } from "./trace"

const PRIMARY = new Set<AgentName>(["sisyphus", "hephaestus", "prometheus", "atlas"])
const READ_ONLY = new Set<AgentName>(["oracle", "librarian", "explore", "metis", "momus", "multimodal-looker"])

export function agentMarker(name: AgentName): string {
  return `<iolaus-agent:${name}>`
}

export async function registerAgents(ctx: { agent: Pick<Context["agent"], "transform"> }, options: Options): Promise<void> {
  await ctx.agent.transform((editor) => {
    for (const name of options.agents) {
      const id = agentID(name)
      if (editor.get(id)) continue
      editor.update(id, (agent) => {
        agent.name = Agent.Name.make(id)
        agent.description = AGENT_DESCRIPTIONS[name]
        agent.mode = PRIMARY.has(name) ? "primary" : "subagent"
        agent.system = agentMarker(name)
        if (READ_ONLY.has(name)) {
          agent.permissions.push({ action: "*", resource: "*", effect: "deny" })
          for (const action of ["read", "glob", "grep", "webfetch", "websearch", "skill"]) {
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
    }
  })
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
