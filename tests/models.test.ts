import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, Model } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { AGENT_MODEL_REQUIREMENTS, CATEGORY_MODEL_REQUIREMENTS } from "@iolaus/model-core"
import { firstChainChoice, loadModelsConfig, modelString, parseModelsConfig, resolveLane } from "../src/models"
import { AGENT_NAMES, CATEGORY_NAMES, agentID, categoryID } from "../src/prompts/catalog"
import { parseOptions } from "../src/options"
import { categoryMarker, planRegistration, registerAgents } from "../src/registration"
import { renderCategory, bindNative } from "../src/prompts/render"
import { buildSisyphusJuniorPrompt } from "../src/omo/agents"
import { applyDefaultModels } from "../src/dag/controller"
import { validateDefinition, DagValidationError } from "../src/dag/graph"

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

test("every Iolaus agent and category lane has an upstream requirement table entry", () => {
  for (const name of AGENT_NAMES) expect(AGENT_MODEL_REQUIREMENTS[name]?.fallbackChain.length).toBeGreaterThan(0)
  expect([...CATEGORY_NAMES].map(String).sort()).toEqual(Object.keys(CATEGORY_MODEL_REQUIREMENTS).sort())
  for (const requirement of [...Object.values(AGENT_MODEL_REQUIREMENTS), ...Object.values(CATEGORY_MODEL_REQUIREMENTS)]) {
    for (const entry of requirement.fallbackChain) {
      expect(entry.providers.length).toBeGreaterThan(0)
      expect(entry.model.length).toBeGreaterThan(0)
    }
  }
})

test("lanes follow the first chain entry without checking connectivity, and config overrides win", () => {
  expect(firstChainChoice(AGENT_MODEL_REQUIREMENTS.sisyphus)).toEqual({ model: "anthropic/claude-opus-5-5", variant: "max" })
  expect(resolveLane("explore", {})).toEqual({ lane: "explore", source: "requirement", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" })
  expect(resolveLane("quick", {})).toEqual({ lane: "quick", source: "requirement", model: "openai/gpt-6-luna-fast", variant: "low" })
  expect(resolveLane("deep-high", {})).toEqual({ lane: "deep-high", source: "requirement", model: "openai/gpt-6-astra", variant: "xhigh" })
  expect(resolveLane("writing", {})?.model).toBe("anthropic/claude-fable-5-1")
  const config = parseModelsConfig({ agents: { oracle: "openai/gpt-5.5#high", sisyphus: { model: "proxy-cc/claude-opus-5-5", variant: "max" } }, categories: { quick: "openai/gpt-5.5" } })
  expect(resolveLane("oracle", config)).toEqual({ lane: "oracle", source: "config", model: "openai/gpt-5.5", variant: "high" })
  expect(resolveLane("sisyphus", config)).toEqual({ lane: "sisyphus", source: "config", model: "proxy-cc/claude-opus-5-5", variant: "max" })
  expect(resolveLane("quick", config)).toEqual({ lane: "quick", source: "config", model: "openai/gpt-5.5" })
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

test("models config layers: user home, then project directories outward-in, then inline options", () => {
  directory = mkdtempSync(join(tmpdir(), "iolaus-models-"))
  const home = join(directory, "home"), repo = join(home, "work", "repo"), nested = join(repo, "pkg")
  for (const dir of [join(home, ".iolaus"), join(repo, ".iolaus"), join(nested, ".iolaus")]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, ".iolaus", "models.json"), JSON.stringify({ agents: { oracle: "user/one", explore: "user/explore" }, categories: { quick: "user/quick" } }))
  writeFileSync(join(repo, ".iolaus", "models.json"), JSON.stringify({ agents: { oracle: "repo/two" } }))
  writeFileSync(join(nested, ".iolaus", "models.json"), JSON.stringify({ agents: { oracle: "nested/three" }, categories: { quick: "nested/quick#low" } }))
  const loaded = loadModelsConfig(nested, { home, inline: { agents: { explore: "inline/explore" } } })
  expect(loaded.diagnostics).toEqual([])
  expect(loaded.sources).toEqual([join(home, ".iolaus", "models.json"), join(repo, ".iolaus", "models.json"), join(nested, ".iolaus", "models.json"), "plugin options"])
  expect(loaded.config.agents).toEqual({ oracle: "nested/three", explore: "inline/explore" })
  expect(loaded.config.categories).toEqual({ quick: "nested/quick#low" })
  writeFileSync(join(repo, ".iolaus", "models.json"), "{ not json")
  const broken = loadModelsConfig(nested, { home })
  expect(broken.diagnostics).toHaveLength(1)
  expect(broken.config.agents?.oracle).toBe("nested/three")
})

function registry() {
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  for (const id of ["build", "plan"]) agents.set(id, Agent.Info.default(Agent.ID.make(id)))
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: (id) => agents.get(id),
    default: () => undefined, remove: (id) => { agents.delete(id) },
    update: (id, update) => { const value = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id)); update(value); agents.set(id, value) },
  }
  return { agents, ctx: { agent: { transform: async (run: (editor: AgentEditor) => void) => { run(editor); return { dispose: async () => {} } } } } }
}

test("registration pins every agent and category lane from config and hides lanes with no model", async () => {
  const fixture = registry()
  const plan = await registerAgents(fixture.ctx, parseOptions({ models: { agents: { oracle: "openai/gpt-5.5#high" }, categories: { writing: "proxy-cc/claude-opus-5-5" } } }), parseModelsConfig({ agents: { oracle: "openai/gpt-5.5#high" }, categories: { writing: "proxy-cc/claude-opus-5-5" } }))
  expect(fixture.agents.get(agentID("oracle"))?.model).toEqual(Model.Ref.parse("openai/gpt-5.5#high"))
  expect(fixture.agents.get(agentID("explore"))?.model).toEqual(Model.Ref.parse("kimi-for-coding/kimi-for-coding-highspeed#off"))
  expect(fixture.agents.get(agentID("hephaestus"))?.model).toEqual(Model.Ref.parse("openai/gpt-6-sol#medium"))
  for (const name of CATEGORY_NAMES) {
    const agent = fixture.agents.get(categoryID(name))
    expect(agent?.mode).toBe("subagent")
    expect(agent?.system).toBe(categoryMarker(name))
    expect(agent?.permissions.some((rule) => rule.action === "subagent" && rule.effect === "deny")).toBe(true)
  }
  expect(fixture.agents.get(categoryID("writing"))?.model).toEqual(Model.Ref.parse("proxy-cc/claude-opus-5-5"))
  expect(fixture.agents.get(categoryID("quick"))?.model).toEqual(Model.Ref.parse("openai/gpt-6-luna-fast#low"))
  expect(plan.categories.get("writing")?.source).toBe("config")
  expect(fixture.agents.get("build")?.model).toBeUndefined()

  const again = registry()
  const options = parseOptions({ categories: ["quick"] })
  const emptyChain = { agents: {}, categories: {} }
  await registerAgents(again.ctx, options, emptyChain)
  expect(again.agents.has(categoryID("quick"))).toBe(true)
  expect(again.agents.has(categoryID("writing"))).toBe(false)
  const once = structuredClone([...again.agents.values()])
  await registerAgents(again.ctx, options, emptyChain)
  expect([...again.agents.values()]).toEqual(once)
})

test("a lane whose chain names no model is hidden and a user-owned lane is left alone", async () => {
  const fixture = registry()
  fixture.agents.set(categoryID("quick"), { ...Agent.Info.default(Agent.ID.make(categoryID("quick"))), system: "user-owned" })
  const plan = planRegistration(parseOptions({}), {})
  expect(plan.categories.get("quick")?.source).toBe("requirement")
  await registerAgents(fixture.ctx, parseOptions({}), {})
  expect(fixture.agents.get(categoryID("quick"))?.system).toBe("user-owned")
  expect(fixture.agents.get(categoryID("quick"))?.model).toBeUndefined()
})

test("category lanes render the model-routed junior prompt with a category context", () => {
  const prompt = renderCategory("quick", "openai/gpt-5.5")
  expect(prompt).toBe(buildSisyphusJuniorPrompt("openai/gpt-5.5", false, `<Category_Context name="quick">\nTrivial tasks: single file changes, typo fixes, simple modifications.\n</Category_Context>`))
  expect(bindNative(prompt).endsWith("</iolaus-native-contract>")).toBe(true)
})

test("DAG nodes without a model receive the configured lane model at create time; explicit models win", () => {
  const defaultModel = (agent: string) => agent === "iolaus-quick" ? "openai/gpt-6-luna-fast#low" : agent === "iolaus-oracle" ? "openai/gpt-5.6-sol#xhigh" : undefined
  const definition = applyDefaultModels({ schemaVersion: 1, name: "t", nodes: [
    { id: "a", agent: "iolaus-quick", prompt: "p", dependsOn: [] },
    { id: "b", agent: "iolaus-oracle", model: "openai/gpt-5.5", prompt: "p", dependsOn: [] },
    { id: "c", agent: "build", model: "openai/gpt-5.5", prompt: "p", dependsOn: [] },
    { id: "g", kind: "gate", prompt: "ok?", dependsOn: [] },
  ] }, defaultModel)
  expect(definition.nodes.map((node) => node.model)).toEqual(["openai/gpt-6-luna-fast#low", "openai/gpt-5.5", "openai/gpt-5.5", undefined])
  expect(() => validateDefinition(definition)).not.toThrow()
  // Fail-closed: a lane with no configured model and no explicit model is rejected before the run exists.
  expect(() => applyDefaultModels({ schemaVersion: 1, name: "t", nodes: [{ id: "c", agent: "build", prompt: "p", dependsOn: [] }] }, defaultModel)).toThrow(/model_unavailable.*c \(build\)/)
  expect(() => validateDefinition({ schemaVersion: 1, name: "t", nodes: [{ id: "x", agent: "build", model: "gpt-5.5", prompt: "p", dependsOn: [] }] })).toThrow(DagValidationError)
})
