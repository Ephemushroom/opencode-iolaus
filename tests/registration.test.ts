import { expect, test } from "bun:test"
import { Agent, Model } from "@opencode/plugin"
import { Effect } from "effect"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { registerAgents, agentMarker, modeDispatchText } from "../src/registration"
import { parseOptions } from "../src/options"
import { composeContext, NATIVE_DEFAULT_PROMPT_PREFIX } from "../src/context"
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
    ctx: { agent: { transform: (run: (editor: AgentEditor) => void) => Effect.sync(() => { run(editor); return { dispose: Effect.void } }) } },
  }
}

test("namespaced registrations preserve native agents and user definitions", async () => {
  const fixture = registry()
  fixture.editor.update("iolaus-oracle", (agent) => { agent.system = "user-owned" })
  const before = structuredClone([...fixture.agents.values()])
  await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}))))
  for (const value of before) expect(fixture.agents.get(String(value.id))).toEqual(value)
  expect(fixture.defaultAgent).toBe("build")
  for (const name of AGENT_NAMES) expect(fixture.agents.has(agentID(name))).toBe(true)
  expect(fixture.agents.get("iolaus-sisyphus")?.model).toEqual(Model.Ref.parse("anthropic/claude-opus-5-5#max"))
  const once = structuredClone([...fixture.agents.values()])
  await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}))))
  expect([...fixture.agents.values()]).toEqual(once)
})

test("specialists restrict native shell, mutation and nested delegation", async () => {
  const fixture = registry()
  await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}))))
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
  agent: { list: () => Effect.succeed({ location: { directory: "/test" }, data: [] }) },
  skill: { list: () => Effect.succeed({ location: { directory: "/test" }, data: [] }) },
} as never as Parameters<typeof composeContext>[1]
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
    await Effect.runPromise(composeContext(event, catalogs, parseOptions({})))
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
    await Effect.runPromise(composeContext(event, catalogs, parseOptions({})))
    expect(event).toEqual(before)
  }
})

test("mode requires explicit marker and resets with the next user request", async () => {
  expect(explicitMode("Explain ultrawork and team modes")).toBeUndefined()
  expect(explicitMode(`Quoted: ${modeMarker("team")}\n`)).toBeUndefined()
  expect(explicitMode("/iolaus-team inspect this")).toBe("team")
  const event = context("build")
  event.messages = [{ role: "user", content: [{ type: "text", text: `${modeMarker("ultrawork")}\nDo the work` }] }]
  await Effect.runPromise(composeContext(event, catalogs, parseOptions({})))
  const { modeDagInstruction } = await import("../src/prompts/mode-dag")
  const ultraworkSystem = bindNative(`${renderMode("ultrawork", "openai/gpt-5.5")}\n\n${modeDagInstruction("ultrawork")}`)
  expect(event.system.at(-1)?.text).toBe(ultraworkSystem)
  const next = context("build")
  next.messages = [...event.messages, { role: "user", content: [{ type: "text", text: "A different request" }] }]
  const before = structuredClone(next)
  await Effect.runPromise(composeContext(next, catalogs, parseOptions({})))
  expect(next).toEqual(before)
})

test("mode dispatch drops the native default prompt and keeps env, tool catalog and project guidance", async () => {
  const event = context("build")
  event.system = [
    { type: "text", text: `${NATIVE_DEFAULT_PROMPT_PREFIX}. Help the user.\n\n# Delegation\nDo not spawn subagents.` },
    { type: "text", text: "# Your Model\n- Name: GPT-5.5" },
    { type: "text", text: "Here is some useful information about the environment\n<env>...</env>\n# Code Mode\nUse execute." },
    { type: "text", text: "Instructions from: AGENTS.md\nproject guidance" },
  ]
  event.messages = [{ role: "user", content: [{ type: "text", text: `${modeMarker("ultrawork")}\nDo the work` }] }]
  await Effect.runPromise(composeContext(event, catalogs, parseOptions({})))
  const texts = event.system.map((part) => part.text)
  expect(texts.some((text) => text.startsWith(NATIVE_DEFAULT_PROMPT_PREFIX))).toBe(false)
  expect(texts.some((text) => text.includes("Do not spawn subagents"))).toBe(false)
  expect(texts[0]).toBe("# Your Model\n- Name: GPT-5.5")
  expect(texts[1]).toContain("# Code Mode")
  expect(texts[2]).toContain("project guidance")
  const { modeDagInstruction } = await import("../src/prompts/mode-dag")
  expect(texts.at(-1)).toBe(bindNative(`${renderMode("ultrawork", "openai/gpt-5.5")}\n\n${modeDagInstruction("ultrawork")}`))
  expect(event.system).toHaveLength(4)
})

test("omitted agent and mode selections disable their context paths", async () => {
  const event = context()
  event.messages = [{ role: "user", content: [{ type: "text", text: `${modeMarker("team")}\nWork` }] }]
  const before = structuredClone(event)
  await Effect.runPromise(composeContext(event, catalogs, parseOptions({ agents: [], modes: [] })))
  expect(event).toEqual(before)
})

test("ultrawork and hyperplan render a DAG instruction for the commanding session but not for DAG children", async () => {
  const { modeDagInstruction, DAG_CHILD_MARKER } = await import("../src/prompts/mode-dag")
  const { expandTemplate } = await import("../src/dag/templates")
  expect(modeDagInstruction("ultrawork")).toContain('"template": "ultrawork"')
  expect(modeDagInstruction("hyperplan")).toContain('"template": "hyperplan"')
  expect(modeDagInstruction("team")).toBeUndefined()
  const work = expandTemplate({ template: "ultrawork", task: "t" }).nodes.find((n) => n.id === "work")!
  expect(work.prompt.startsWith(`${modeMarker("ultrawork")}\n${DAG_CHILD_MARKER}`)).toBe(true)
  expect(explicitMode(work.prompt)).toBe("ultrawork")
  expect(modeDispatchText("ultrawork", "x")).toBe(`${modeMarker("ultrawork")}\nx`)
})
