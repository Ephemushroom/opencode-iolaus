import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Options } from "./options"
import { CATEGORY_DESCRIPTIONS, agentName, categoryName, explicitMode } from "./prompts/catalog"
import { agentMarker, categoryMarker } from "./registration"
import { bindNative, renderAgent, renderCategory, renderMode } from "./prompts/render"
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

/**
 * OpenCode injects its default agent prose as a single system part that opens
 * with this sentence. It carries harness style rules and a "do not spawn
 * subagents" clause that conflict with the OMO mode prompts, so mode dispatch
 * drops it. Environment facts, Code Mode tool catalog and AGENTS.md live in
 * separate parts and are kept.
 */
export const NATIVE_DEFAULT_PROMPT_PREFIX = "You are an AI agent running in OpenCode, a coding agent harness"

export function dropNativeDefaultPrompt(system: SessionContext["system"]): number {
  let removed = 0
  for (let i = system.length - 1; i >= 0; i--) {
    const part = system[i]
    if (part.type === "text" && part.text.startsWith(NATIVE_DEFAULT_PROMPT_PREFIX)) { system.splice(i, 1); removed++ }
  }
  return removed
}

export async function composeContext(
  event: SessionContext,
  ctx: { agent: Pick<Context["agent"], "list">; skill: Pick<Context["skill"], "list"> },
  options: Options,
): Promise<void> {
  const name = agentName(event.agent)
  const category = categoryName(event.agent)
  const mode = explicitMode(lastUserText(event.messages))
  const selectedMode = mode && options.modes.includes(mode) ? mode : undefined
  const marker = name && options.agents.includes(name) ? agentMarker(name)
    : category && options.categories.includes(category) ? categoryMarker(category) : undefined
  const index = marker ? event.system.findIndex((part) => part.type === "text" && part.text === marker) : -1
  if (index === -1 && !selectedMode) return
  const model = `${event.model.providerID}/${event.model.id}`
  if (category && index !== -1) {
    event.system[index] = { type: "text", text: bindNative(renderCategory(category, model)) }
    trace("iolaus.agent.rendered", { agent: category, kind: "category", model, sessionID: event.sessionID })
  } else if (name && index !== -1) {
    const [agents, skills] = await Promise.all([ctx.agent.list(), ctx.skill.list()])
    const lanes = agents.data.filter((agent) => categoryName(String(agent.id)) !== undefined)
    const prompt = renderAgent(name, {
      model,
      agents: agents.data.filter((agent) => agent.mode !== "primary" && !agent.hidden && categoryName(String(agent.id)) === undefined).map((agent) => ({
        name: String(agent.id), description: agent.description ?? "",
        metadata: { category: "specialist", cost: "CHEAP", triggers: [] },
      })),
      categories: lanes.map((agent) => {
        const lane = categoryName(String(agent.id))!
        return { name: lane, description: CATEGORY_DESCRIPTIONS[lane], ...(agent.model ? { model: `${agent.model.providerID}/${agent.model.id}` } : {}) }
      }),
      skills: skills.data.map((skill) => ({ name: skill.id, description: skill.description ?? "", location: "plugin" })),
      tools: categorizeTools(Object.keys(event.tools)),
    })
    event.system[index] = { type: "text", text: bindNative(prompt) }
    trace("iolaus.agent.rendered", { agent: name, model, sessionID: event.sessionID })
  }
  if (selectedMode) {
    const removed = dropNativeDefaultPrompt(event.system)
    event.system.push({ type: "text", text: bindNative(renderMode(selectedMode, model, name)) })
    trace("iolaus.mode.rendered", { mode: selectedMode, model, sessionID: event.sessionID, nativePromptRemoved: removed })
  }
}
