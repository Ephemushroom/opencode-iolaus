import { expect, test } from "bun:test"
import { Agent, Model } from "@opencode/plugin"
import { Effect } from "effect"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { registerAgents, registerModes, agentMarker, modeDispatchText } from "../src/registration"
import { evaluate } from "../src/ast-grep/permissions"
import { FLOW_TOOL_NAME } from "../src/dag/tool"
import { parseOptions } from "../src/options"
import { composeContext, NATIVE_DEFAULT_PROMPT_PREFIX } from "../src/context"
import { agentID, modeMarker, explicitMode, AGENT_NAMES } from "../src/prompts/catalog"
import { bindNative, renderAgent, renderMode } from "../src/prompts/render"
import {
  EXPLORE_PROMPT_METADATA, LIBRARIAN_PROMPT_METADATA, MULTIMODAL_LOOKER_PROMPT_METADATA, ORACLE_PROMPT_METADATA,
  metisPromptMetadata, momusPromptMetadata, type AgentPromptMetadata,
} from "../src/omo/agents"

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

test("registrations keep native agents and user definitions, and take over only the host's explore", async () => {
  const fixture = registry()
  fixture.editor.update("oracle", (agent) => { agent.system = "user-owned" })
  const before = structuredClone([...fixture.agents.values()])
  await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}))))
  for (const value of before.filter((agent) => agent.id !== "explore")) expect(fixture.agents.get(String(value.id))).toEqual(value)
  const explore = fixture.agents.get("explore")!
  expect(explore.system).toBe(agentMarker("explore"))
  expect(String(explore.name)).toBe("Explore")
  expect(explore.mode).toBe("subagent")
  expect(fixture.defaultAgent).toBe("build")
  for (const name of AGENT_NAMES) expect(fixture.agents.has(agentID(name))).toBe(true)
  expect(fixture.agents.get("sisyphus")?.model).toEqual(Model.Ref.parse("anthropic/claude-opus-5-5#max"))
  const once = structuredClone([...fixture.agents.values()])
  await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}))))
  expect([...fixture.agents.values()]).toEqual(once)
})

test("specialists follow OMO's per-agent deny lists", async () => {
  const fixture = registry()
  await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}))))
  const permission = (name: string, action: string) => evaluate(action, "*", fixture.agents.get(name)!.permissions)
  for (const name of ["oracle", "explore", "librarian", "metis", "momus"]) {
    expect(permission(name, "edit")).toBe("deny")
    for (const action of ["read", "grep", "shell", "execute", "webfetch"]) expect(permission(name, action)).toBe("allow")
  }
  for (const name of ["oracle", "explore", "librarian"]) {
    expect(permission(name, "subagent")).toBe("deny")
    expect(permission(name, FLOW_TOOL_NAME)).toBe("deny")
  }
  for (const name of ["metis", "momus"]) expect(permission(name, "subagent")).toBe("allow")
  expect(permission("multimodal-looker", "read")).toBe("allow")
  for (const action of ["shell", "edit", "grep", "subagent"]) expect(permission("multimodal-looker", action)).toBe("deny")
  expect(permission("sisyphus-junior", "subagent")).toBe("deny")
})

const catalogs = {
  agent: { list: () => Effect.succeed({ location: { directory: "/test" }, data: [] }) },
  skill: { list: () => Effect.succeed({ location: { directory: "/test" }, data: [] }) },
} as never as Parameters<typeof composeContext>[1]
function context(agent = "sisyphus", model = "openai/gpt-5.5"): SessionContext {
  return {
    sessionID: Session.ID.make("ses_test"), agent: Agent.ID.make(agent), model: Model.Ref.parse(model),
    system: [{ type: "text", text: agent === "build" ? "native" : agentMarker("sisyphus") }, { type: "text", text: "project guidance" }],
    messages: [], tools: { read: { description: "native read", input: { type: "object" } } }, options: {},
  }
}

test("request model selects prompt while tools, model and other system parts are preserved", async () => {
  for (const model of ["openai/gpt-5.5", "anthropic/claude-opus-4-8", "zai/glm-5.2"]) {
    const event = context("sisyphus", model)
    const tools = structuredClone(event.tools)
    await Effect.runPromise(composeContext(event, catalogs, parseOptions({})))
    expect(event.system[0].text).toBe(bindNative(renderAgent("sisyphus", { model, tools: [{ name: "read", category: "other" }] })))
    expect(event.system[1]).toEqual({ type: "text", text: "project guidance" })
    expect(event.tools).toEqual(tools)
    expect(event.model).toEqual(Model.Ref.parse(model))
  }
})

test("Sisyphus lists the delegable specialists with OMO's prompt metadata and other subagents without triggers", async () => {
  const subagent = (id: string) => ({ ...Agent.Info.default(Agent.ID.make(id)), mode: "subagent" as const, description: `${id} agent.` })
  const listed = ["oracle", "explore", "librarian", "metis", "momus", "multimodal-looker", "general"].map(subagent)
  const live = {
    agent: { list: () => Effect.succeed({ location: { directory: "/test" }, data: listed }) },
    skill: { list: () => Effect.succeed({ location: { directory: "/test" }, data: [] }) },
  } as never as Parameters<typeof composeContext>[1]
  const metadata: Record<string, AgentPromptMetadata> = {
    oracle: ORACLE_PROMPT_METADATA, explore: EXPLORE_PROMPT_METADATA, librarian: LIBRARIAN_PROMPT_METADATA,
    metis: metisPromptMetadata, momus: momusPromptMetadata, "multimodal-looker": MULTIMODAL_LOOKER_PROMPT_METADATA,
  }
  const untriggered: AgentPromptMetadata = { category: "specialist", cost: "CHEAP", triggers: [] }
  const available = (pick: (id: string) => AgentPromptMetadata) => listed.map((agent) => ({ name: String(agent.id), description: agent.description, metadata: pick(String(agent.id)) }))
  const tools = [{ name: "read", category: "other" as const }]
  for (const model of ["openai/gpt-5.5", "anthropic/claude-opus-5-5"]) {
    const expected = bindNative(renderAgent("sisyphus", { model, tools, agents: available((id) => metadata[id] ?? untriggered) }))
    // The metadata is observable: the same catalog without it renders a different prompt.
    expect(expected).not.toBe(bindNative(renderAgent("sisyphus", { model, tools, agents: available(() => untriggered) })))
    const event = context("sisyphus", model)
    await Effect.runPromise(composeContext(event, live, parseOptions({})))
    expect(event.system[0].text).toBe(expected)
  }
})

test("ordinary native requests and user-owned agent prompts remain unchanged", async () => {
  for (const agent of ["build", "sisyphus"]) {
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
  expect(explicitMode("/team inspect this")).toBe("team")
  expect(explicitMode("/iolaus-team inspect this")).toBeUndefined()
  expect(explicitMode("/teamwork now")).toBeUndefined()
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

test("ultrawork, hyperplan and team render a DAG instruction for the commanding session but not for DAG children", async () => {
  const { modeDagInstruction, DAG_CHILD_MARKER } = await import("../src/prompts/mode-dag")
  const { expandTemplate } = await import("../src/dag/templates")
  expect(modeDagInstruction("ultrawork")).toContain('"template": "ultrawork"')
  expect(modeDagInstruction("hyperplan")).toContain('"template": "hyperplan"')
  expect(modeDagInstruction("team")).toContain('"template": "team"')
  const work = expandTemplate({ template: "ultrawork", task: "t" }).nodes.find((n) => n.id === "work")!
  expect(work.prompt.startsWith(`${modeMarker("ultrawork")}\n${DAG_CHILD_MARKER}`)).toBe(true)
  expect(explicitMode(work.prompt)).toBe("ultrawork")
  expect(modeDispatchText("ultrawork", "x")).toBe(`${modeMarker("ultrawork")}\nx`)
})

test("ids and display names are the bare lane names; explore replaces the host agent with its own rules", async () => {
  const fixture = registry()
  await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}))))
  const name = (id: string) => String(fixture.agents.get(id)?.name)
  expect(name("sisyphus")).toBe("Sisyphus")
  expect(name("sisyphus-junior")).toBe("Sisyphus Junior")
  expect(name("multimodal-looker")).toBe("Multimodal Looker")
  expect(name("deep-high")).toBe("Deep High")
  expect(name("quick")).toBe("Quick")
  expect(name("explore")).toBe("Explore")
  expect([...fixture.agents.keys()].some((id) => id.startsWith("iolaus-"))).toBe(false)
  // The host's explore rules are dropped: ours start from the host default and add the explore deny list.
  const rules = fixture.agents.get("explore")!.permissions
  expect(rules.slice(0, 5)).toEqual(Agent.Info.default(Agent.ID.make("explore")).permissions)
  expect(evaluate("shell", "*", rules)).toBe("allow")
  expect(evaluate("edit", "*", rules)).toBe("deny")
  // A second registration pass is a no-op.
  const once = structuredClone([...fixture.agents.values()])
  await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}))))
  expect([...fixture.agents.values()]).toEqual(once)
})

test("mode commands register under their short names", async () => {
  const names: string[] = []
  await Effect.runPromise(Effect.scoped(registerModes({
    command: { transform: (run) => Effect.sync(() => { run({ add: (definition) => { names.push(definition.name) } }); return { dispose: Effect.void } }) },
    session: { prompt: () => Effect.succeed(undefined) } as never,
  }, parseOptions({}))))
  expect(names).toEqual(["ultrawork", "hyperplan", "team", "goal", "start-work"])
  const only: string[] = []
  await Effect.runPromise(Effect.scoped(registerModes({
    command: { transform: (run) => Effect.sync(() => { run({ add: (definition) => { only.push(definition.name) } }); return { dispose: Effect.void } }) },
    session: { prompt: () => Effect.succeed(undefined) } as never,
  }, parseOptions({ agents: ["sisyphus"], modes: ["ultrawork"] }))))
  expect(only).toEqual(["ultrawork"])
})
