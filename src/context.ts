import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Options } from "./options"
import { agentName, explicitMode } from "./prompts/catalog"
import { agentMarker } from "./registration"
import { bindNative, renderAgent, renderMode } from "./prompts/render"
import { categorizeTools } from "./omo/agents"
import { trace } from "./trace"

export function lastUserText(messages: SessionContext["messages"]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue
    if (typeof message.content === "string") return message.content
    return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  }
  return ""
}

export async function composeContext(
  event: SessionContext,
  ctx: { agent: Pick<Context["agent"], "list">; skill: Pick<Context["skill"], "list"> },
  options: Options,
): Promise<void> {
  const name = agentName(event.agent)
  const mode = explicitMode(lastUserText(event.messages))
  const selectedMode = mode && options.modes.includes(mode) ? mode : undefined
  const index = name && options.agents.includes(name)
    ? event.system.findIndex((part) => part.type === "text" && part.text === agentMarker(name)) : -1
  if (index === -1 && !selectedMode) return
  const model = `${event.model.providerID}/${event.model.id}`
  if (name && index !== -1) {
    const [agents, skills] = await Promise.all([ctx.agent.list(), ctx.skill.list()])
    const prompt = renderAgent(name, {
      model,
      agents: agents.data.filter((agent) => agent.mode !== "primary" && !agent.hidden).map((agent) => ({
        name: String(agent.id), description: agent.description ?? "",
        metadata: { category: "specialist", cost: "CHEAP", triggers: [] },
      })),
      skills: skills.data.map((skill) => ({ name: skill.id, description: skill.description ?? "", location: "plugin" })),
      tools: categorizeTools(Object.keys(event.tools)),
    })
    event.system[index] = { type: "text", text: bindNative(prompt) }
    trace("iolaus.agent.rendered", { agent: name, model, sessionID: event.sessionID })
  }
  if (selectedMode) {
    event.system.push({ type: "text", text: bindNative(renderMode(selectedMode, model, name)) })
    trace("iolaus.mode.rendered", { mode: selectedMode, model, sessionID: event.sessionID })
  }
}
