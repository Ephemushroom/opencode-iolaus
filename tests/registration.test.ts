import { expect, test } from "bun:test"
import { Agent, Model } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { Session } from "@opencode/schema/session"
import { registerAgents, agentMarker } from "../src/registration"
import { parseOptions } from "../src/options"
import { composeContext } from "../src/context"
import { agentID, modeMarker, explicitMode, AGENT_NAMES } from "../src/prompts/catalog"
import { bindNative, renderAgent, renderMode } from "../src/prompts/render"

function registry() {
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  for (const id of ["build", "plan", "explore", "general"]) agents.set(id, Agent.Info.default(Agent.ID.make(id)))
  let defaultAgent = "build"
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: (id) => agents.get(id),
    default: (id) => { defaultAgent = id ?? "" }, remove: (id) => { agents.delete(id) },
    update: (id, update) => {
      const value = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id))
      update(value)
      agents.set(id, value)
    },
  }
  return { agents, editor, get defaultAgent() { return defaultAgent },
    ctx: { agent: { transform: async (run: (editor: AgentEditor) => void) => {
      run(editor)
      return { dispose: async () => {} }
    } } },
  }
}

test("namespaced registrations preserve native agents and user definitions", async () => {
  const fixture = registry()
  fixture.editor.update("iolaus-oracle", (agent) => { agent.system = "user-owned" })
  const before = structuredClone([...fixture.agents.values()])
  await registerAgents(fixture.ctx, parseOptions({}))
  for (const value of before) expect(fixture.agents.get(String(value.id))).toEqual(value)
  expect(fixture.defaultAgent).toBe("build")
  for (const name of AGENT_NAMES) expect(fixture.agents.has(agentID(name))).toBe(true)
  expect(fixture.agents.get("iolaus-sisyphus")?.model).toBeUndefined()
  const once = structuredClone([...fixture.agents.values()])
  await registerAgents(fixture.ctx, parseOptions({}))
  expect([...fixture.agents.values()]).toEqual(once)
})

test("specialists restrict native shell, mutation and nested delegation", async () => {
  const fixture = registry()
  await registerAgents(fixture.ctx, parseOptions({}))
  function permission(name: string, action: string) {
    return fixture.agents.get(name)?.permissions.filter((rule) => rule.action === "*" || rule.action === action).at(-1)?.effect
  }
  for (const name of ["oracle", "explore", "librarian", "metis", "momus", "multimodal-looker"]) {
    for (const action of ["shell", "edit", "subagent"]) expect(permission(agentID(name as "oracle"), action)).toBe("deny")
    expect(permission(`iolaus-${name}`, "read")).toBe("allow")
  }
  expect(permission("iolaus-sisyphus-junior", "subagent")).toBe("deny")
})

const catalogs = {
  agent: { list: async () => ({ location: { directory: "/test" }, data: [] }) },
  skill: { list: async () => ({ location: { directory: "/test" }, data: [] }) },
}
function context(agent = "iolaus-sisyphus", model = "openai/gpt-5.5"): SessionContext {
  return {
    sessionID: Session.ID.make("ses_test"), agent: Agent.ID.make(agent), model: Model.Ref.parse(model),
    system: [{ type: "text", text: agent === "build" ? "native" : agentMarker("sisyphus") }, { type: "text", text: "project guidance" }],
    messages: [], tools: { read: { description: "native read", input: { type: "object" } } }, options: {},
  }
}

test("request model selects prompt while tools, model and other system parts are preserved", async () => {
  for (const model of ["openai/gpt-5.5", "anthropic/claude-opus-4-8", "zai/glm-5.2"]) {
    const event = context("iolaus-sisyphus", model)
    const tools = structuredClone(event.tools)
    await composeContext(event, catalogs, parseOptions({}))
    expect(event.system[0].text).toBe(bindNative(renderAgent("sisyphus", { model, tools: [{ name: "read", category: "other" }] })))
    expect(event.system[1]).toEqual({ type: "text", text: "project guidance" })
    expect(event.tools).toEqual(tools)
    expect(event.model).toEqual(Model.Ref.parse(model))
  }
})

test("ordinary native requests and user-owned agent prompts remain unchanged", async () => {
  for (const agent of ["build", "iolaus-sisyphus"]) {
    const event = context(agent)
    event.system = [{ type: "text", text: "user-owned" }, ...event.system.slice(1)]
    const before = structuredClone(event)
    await composeContext(event, catalogs, parseOptions({}))
    expect(event).toEqual(before)
  }
})

test("mode requires explicit marker and resets with the next user request", async () => {
  expect(explicitMode("Explain ultrawork and team modes")).toBeUndefined()
  expect(explicitMode(`Quoted: ${modeMarker("team")}\n`)).toBeUndefined()
  expect(explicitMode("/iolaus-team inspect this")).toBe("team")
  const event = context("build")
  event.messages = [{ role: "user", content: [{ type: "text", text: `${modeMarker("ultrawork")}\nDo the work` }] }]
  await composeContext(event, catalogs, parseOptions({}))
  expect(event.system.at(-1)?.text).toBe(bindNative(renderMode("ultrawork", "openai/gpt-5.5")))
  const next = context("build")
  next.messages = [...event.messages, { role: "user", content: [{ type: "text", text: "A different request" }] }]
  const before = structuredClone(next)
  await composeContext(next, catalogs, parseOptions({}))
  expect(next).toEqual(before)
})

test("omitted agent and mode selections disable their context paths", async () => {
  const event = context()
  event.messages = [{ role: "user", content: [{ type: "text", text: `${modeMarker("team")}\nWork` }] }]
  const before = structuredClone(event)
  await composeContext(event, catalogs, parseOptions({ agents: [], modes: [] }))
  expect(event).toEqual(before)
})
