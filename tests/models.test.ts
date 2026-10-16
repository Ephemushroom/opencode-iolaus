import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent, Model } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { modelString, parseModelsConfig, resolveLane } from "../src/models"
import { AGENT_NAMES, CATEGORY_NAMES, agentID, categoryID } from "../src/prompts/catalog"
import { parseOptions } from "../src/options"
import { categoryMarker, planRegistration, registerAgents } from "../src/registration"
import { renderCategory, bindNative } from "../src/prompts/render"
import { buildSisyphusJuniorPrompt } from "../src/omo/agents"
import { applyDefaultModels } from "../src/dag/controller"
import { validateDefinition, DagValidationError } from "../src/dag/graph"

test("lanes are config-first: an unconfigured lane has no model, and the first configured entry wins", () => {
  for (const lane of ["sisyphus", "explore", "quick", "deep-high", "writing"] as const) expect(resolveLane(lane, {})).toBeUndefined()
  expect(resolveLane("quick", parseModelsConfig({ categories: { quick: ["a/one#low", "b/two"] } }))).toEqual({ lane: "quick", source: "config", model: "a/one", variant: "low" })
  const config = parseModelsConfig({ agents: { oracle: "openai/gpt-5.5#high", sisyphus: { model: "proxy-cc/claude-opus-5-5", variant: "max" } }, categories: { quick: "openai/gpt-5.5" } })
  expect(resolveLane("oracle", config)).toEqual({ lane: "oracle", source: "config", model: "openai/gpt-5.5", variant: "high" })
  expect(resolveLane("sisyphus", config)).toEqual({ lane: "sisyphus", source: "config", model: "proxy-cc/claude-opus-5-5", variant: "max" })
  expect(resolveLane("quick", config)).toEqual({ lane: "quick", source: "config", model: "openai/gpt-5.5" })
  expect(resolveLane("explore", parseModelsConfig({ agents: { explore: "ds-bryan/deepseek-v4-flash#max" } }))).toEqual({ lane: "explore", source: "config", model: "ds-bryan/deepseek-v4-flash", variant: "max" })
  expect(modelString({ model: "a/b", variant: "c" })).toBe("a/b#c")
  expect(modelString({ model: "a/b" })).toBe("a/b")
})

test("models config rejects unknown lanes, malformed refs and unknown keys", () => {
  for (const input of [
    { agents: { build: "openai/gpt-5.5" } },
    { categories: { deep: "openai/gpt-5.5" } },
    { agents: { oracle: "gpt-5.5" } },
    { agents: { oracle: "openai/gpt-5.5#" } },
    { agents: { oracle: { variant: "high" } } },
    { agents: ["oracle"] },
    { fallback: {} },
    "openai/gpt-5.5",
  ]) expect(() => parseModelsConfig(input)).toThrow(TypeError)
  expect(() => parseOptions({ models: { agents: { oracle: "openai/gpt-5.5" } }, categories: ["quick"] })).not.toThrow()
  expect(() => parseOptions({ categories: ["deep"] })).toThrow()
})

function registry() {
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  for (const id of ["build", "plan"]) agents.set(id, Agent.Info.default(Agent.ID.make(id)))
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: (id) => agents.get(id),
    default: () => undefined, remove: (id) => { agents.delete(id) },
    update: (id, update) => { const value = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id)); update(value); agents.set(id, value) },
  }
  return { agents, ctx: { agent: { transform: (run: (editor: AgentEditor) => void) => Effect.sync(() => { run(editor); return { dispose: Effect.void } }) } } }
}

test("registration pins every agent and category lane from config and hides lanes with no model", async () => {
  const fixture = registry()
  const plan = await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}), parseModelsConfig({ agents: { oracle: "openai/gpt-5.5#high", explore: "ds-bryan/deepseek-v4-flash#max" }, categories: { writing: "proxy-cc/claude-opus-5-5" } }))))
  expect(fixture.agents.get(agentID("oracle"))?.model).toEqual(Model.Ref.parse("openai/gpt-5.5#high"))
  expect(fixture.agents.get(agentID("explore"))?.model).toEqual(Model.Ref.parse("ds-bryan/deepseek-v4-flash#max"))
  // Unconfigured lanes are not registered: there is no built-in default chain.
  expect(fixture.agents.has(agentID("hephaestus"))).toBe(false)
  expect(fixture.agents.has(categoryID("quick"))).toBe(false)
  for (const name of ["writing"] as const) {
    const agent = fixture.agents.get(categoryID(name))
    expect(agent?.mode).toBe("subagent")
    expect(agent?.system).toBe(categoryMarker(name))
    expect(agent?.permissions.some((rule) => rule.action === "subagent" && rule.effect === "deny")).toBe(true)
  }
  expect(fixture.agents.get(categoryID("writing"))?.model).toEqual(Model.Ref.parse("proxy-cc/claude-opus-5-5"))
  expect(plan.categories.get("writing")?.source).toBe("config")
  expect(fixture.agents.get("build")?.model).toBeUndefined()

  const again = registry()
  const options = parseOptions({ categories: ["quick"] })
  const emptyChain = parseModelsConfig({ categories: { quick: "a/quick" } })
  await Effect.runPromise(Effect.scoped(registerAgents(again.ctx, options, emptyChain)))
  expect(again.agents.has(categoryID("quick"))).toBe(true)
  expect(again.agents.has(categoryID("writing"))).toBe(false)
  const once = structuredClone([...again.agents.values()])
  await Effect.runPromise(Effect.scoped(registerAgents(again.ctx, options, emptyChain)))
  expect([...again.agents.values()]).toEqual(once)
})

test("a lane whose chain names no model is hidden and a user-owned lane is left alone", async () => {
  const fixture = registry()
  fixture.agents.set(categoryID("quick"), { ...Agent.Info.default(Agent.ID.make(categoryID("quick"))), system: "user-owned" })
  const plan = planRegistration(parseOptions({}), {})
  expect(plan.categories.get("quick")).toBeUndefined()
  await Effect.runPromise(Effect.scoped(registerAgents(fixture.ctx, parseOptions({}), {})))
  expect(fixture.agents.get(categoryID("quick"))?.system).toBe("user-owned")
  expect(fixture.agents.get(categoryID("quick"))?.model).toBeUndefined()
})

test("category lanes render the model-routed junior prompt with a category context", () => {
  const prompt = renderCategory("quick", "openai/gpt-5.5")
  expect(prompt).toBe(buildSisyphusJuniorPrompt("openai/gpt-5.5", false, `<Category_Context name="quick">\nTrivial tasks: single file changes, typo fixes, simple modifications.\n</Category_Context>`))
  expect(bindNative(prompt).endsWith("</iolaus-native-contract>")).toBe(true)
})

test("DAG nodes without a model receive the configured lane model at create time; explicit models win", () => {
  const defaultModel = (agent: string) => agent === "quick" ? "openai/gpt-6-luna-fast#low" : agent === "oracle" ? "openai/gpt-5.6-sol#xhigh" : undefined
  const definition = applyDefaultModels({ schemaVersion: 1, name: "t", nodes: [
    { id: "a", agent: "quick", prompt: "p", dependsOn: [] },
    { id: "b", agent: "oracle", model: "openai/gpt-5.5", prompt: "p", dependsOn: [] },
    { id: "c", agent: "build", model: "openai/gpt-5.5", prompt: "p", dependsOn: [] },
    { id: "g", kind: "gate", prompt: "ok?", dependsOn: [] },
  ] }, defaultModel)
  expect(definition.nodes.map((node) => node.model)).toEqual(["openai/gpt-6-luna-fast#low", "openai/gpt-5.5", "openai/gpt-5.5", undefined])
  expect(() => validateDefinition(definition)).not.toThrow()
  // Fail-closed: a lane with no configured model and no explicit model is rejected before the run exists.
  expect(() => applyDefaultModels({ schemaVersion: 1, name: "t", nodes: [{ id: "c", agent: "build", prompt: "p", dependsOn: [] }] }, defaultModel)).toThrow(/model_unavailable.*c \(build\)/)
  expect(() => validateDefinition({ schemaVersion: 1, name: "t", nodes: [{ id: "x", agent: "build", model: "gpt-5.5", prompt: "p", dependsOn: [] }] })).toThrow(DagValidationError)
})
