import { describe, expect, test } from "bun:test"

import { Agent } from "@opencode/schema/agent"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { Effect } from "effect"

import { registerCategories } from "./register-categories"
import { registerPrimaries } from "./register-primaries"
import { registerSubagents } from "./register-subagents"
import { resolveAgentModel, createCatalogSource } from "./model-resolution"
import type { CatalogSource } from "./model-resolution"

import type { OpenCode2AgentOverride } from "../config"

/**
 * Minimal structural stand-ins for the v2 catalog/agent drafts. The
 * registration code only reads provider ids + model keys and mutates agent
 * fields, so a plain-object draft is sufficient and faithful for unit testing.
 */

type MutableAgent = ReturnType<AgentEditor["list"]>[number]

function createMockContext(input: {
  availableModels?: string[]
  connectedProviders?: string[]
  defaultModel?: string
}) {
  const agents = new Map<string, MutableAgent>()
  let defaultAgent: string | undefined

  const providers = new Map<string, Set<string>>()
  for (const full of input.availableModels ?? []) {
    const [provider, ...rest] = full.split("/")
    if (!provider || rest.length === 0) continue
    if (!providers.has(provider)) providers.set(provider, new Set())
    providers.get(provider)?.add(rest.join("/"))
  }
  const providerRecords = [...providers.entries()].map(([id, models]) => ({
    provider: { id },
    models: new Map([...models].map((m) => [m, {}])),
  }))

  const defaultParts = (input.defaultModel ?? "").split("/")
  const defaultRef =
    defaultParts.length >= 2
      ? { providerID: defaultParts[0], modelID: defaultParts.slice(1).join("/") }
      : undefined

  // Populate a live catalog source from the mock draft (the register functions
  // resolve models against catalog.current inside the agent transform).
  const catalog = createCatalogSource()
  catalog.capture({
    provider: { list: () => providerRecords, get: () => undefined, update: () => {}, remove: () => {} },
    model: {
      get: () => undefined,
      update: () => {},
      remove: () => {},
      default: { get: () => defaultRef, set: () => {} },
    },
  } as unknown as Parameters<CatalogSource["capture"]>[0])

  const ctx: Parameters<typeof registerPrimaries>[0] = {
    agent: {
      transform: (cb) => Effect.sync(() => {
        cb({
          list: () => [...agents.values()],
          get: (id: string) => agents.get(id),
          default: (id: string | undefined) => {
            defaultAgent = id
          },
          update: (id: string, fn: (agent: MutableAgent) => void) => {
            const agent = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id))
            fn(agent)
            agents.set(id, agent)
          },
          remove: (id: string) => {
            agents.delete(id)
          },
        })
        return { dispose: Effect.void }
      }),
    },
  }

  return { ctx, catalog, agents, getDefault: () => defaultAgent }
}

describe("resolveAgentModel", () => {
  test("#given a per-agent model override #when resolving #then the override overrides the catalog and requirement", () => {
    const override: OpenCode2AgentOverride = { model: "anthropic/claude-3-5-sonnet", variant: "latest" }
    const result = resolveAgentModel(
      { fallbackChain: [{ providers: ["openai"], model: "gpt-5.6-sol" }] },
      { availableModels: new Set(["openai/gpt-5.6-sol"]), connectedProviders: ["openai"], visionModels: new Set() },
      undefined,
      override,
    )

    expect(result?.model).toBe("anthropic/claude-3-5-sonnet")
    expect(result?.variant).toBe("latest")
  })

  test("#given a chain model available in the catalog #when resolving #then it uses the chain entry", () => {
    const result = resolveAgentModel(
      { fallbackChain: [{ providers: ["openai"], model: "gpt-5.6-sol", variant: "xhigh" }] },
      { availableModels: new Set(["openai/gpt-5.6-sol"]), connectedProviders: ["openai"], visionModels: new Set() },
    )

    expect(result?.model).toBe("openai/gpt-5.6-sol")
    expect(result?.variant).toBe("xhigh")
  })

  test("#given no chain entry available and a system default #when resolving #then it falls back to the default", () => {
    const result = resolveAgentModel(
      { fallbackChain: [{ providers: ["openai"], model: "gpt-5.6-sol" }] },
      { availableModels: new Set(["zhipuai/glm-4.7"]), connectedProviders: ["zhipuai"], visionModels: new Set() },
      "zhipuai/glm-4.7",
    )

    expect(result?.model).toBe("zhipuai/glm-4.7")
  })

  test("#given a cold catalog and no default #when resolving #then it uses the first fallback entry", () => {
    const result = resolveAgentModel(
      { fallbackChain: [{ providers: ["anthropic"], model: "claude-opus-5", variant: "max" }] },
      { availableModels: new Set(), connectedProviders: [], visionModels: new Set() },
    )

    expect(result?.model).toBe("anthropic/claude-opus-5")
    expect(result?.variant).toBe("max")
  })
})

describe("registerSubagents", () => {
  test("#given a catalog #when registering #then all seven subagents are upserted as subagents with a prompt", async () => {
    const { ctx, catalog, agents } = createMockContext({ defaultModel: "zhipuai/glm-4.7" })

    const registered = await Effect.runPromise(Effect.scoped(registerSubagents(ctx, { catalog })))

    expect([...registered].sort()).toEqual(
      ["oracle", "librarian", "explore", "multimodal-looker", "metis", "momus", "sisyphus-junior"].sort(),
    )
    for (const id of registered) {
      const agent = agents.get(id)
      expect(agent?.mode).toBe("subagent")
      expect(typeof agent?.system).toBe("string")
      expect(agent?.system?.length).toBeGreaterThan(0)
    }
  })

  test("#given a catalog #when registering oracle #then write/edit/task are denied", async () => {
    const { ctx, catalog, agents } = createMockContext({ defaultModel: "zhipuai/glm-4.7" })

    await Effect.runPromise(Effect.scoped(registerSubagents(ctx, { catalog })))

    const oracle = agents.get("oracle")
    const effects = new Map(oracle?.permissions.map((rule) => [rule.action, rule.effect]))
    expect(effects.get("write")).toBe("deny")
    expect(effects.get("edit")).toBe("deny")
    expect(effects.get("task")).toBe("deny")
  })

  test("#given an available chain model #when registering #then the agent model resolves from the catalog", async () => {
    const { ctx, catalog, agents } = createMockContext({ availableModels: ["openai/gpt-5.6-sol"], defaultModel: "zhipuai/glm-4.7" })

    await Effect.runPromise(Effect.scoped(registerSubagents(ctx, { catalog })))

    const oracle = agents.get("oracle")
    expect(String(oracle?.model?.providerID)).toBe("openai")
    expect(String(oracle?.model?.id)).toBe("gpt-5.6-sol")
  })

  test("#given a per-agent model override #when registering #then the override overrides the catalog", async () => {
    const { ctx, catalog, agents } = createMockContext({ availableModels: ["openai/gpt-5.6-sol"], defaultModel: "zhipuai/glm-4.7" })

    await Effect.runPromise(Effect.scoped(registerSubagents(ctx, {
      catalog,
      agentOverrides: { oracle: { model: "anthropic/claude-3-5-sonnet", variant: "latest" } },
    })))

    const oracle = agents.get("oracle")
    expect(String(oracle?.model?.providerID)).toBe("anthropic")
    expect(String(oracle?.model?.id)).toBe("claude-3-5-sonnet")
    expect(String(oracle?.model?.variant)).toBe("latest")
  })
})

describe("registerPrimaries", () => {
  test("#given a catalog with a GPT model available #when registering #then all four primaries register and default becomes sisyphus", async () => {
    const { ctx, catalog, agents, getDefault } = createMockContext({
      availableModels: ["openai/gpt-5.6-sol"],
      defaultModel: "zhipuai/glm-4.7",
    })

    const registered = await Effect.runPromise(Effect.scoped(registerPrimaries(ctx, { catalog })))

    expect([...registered].sort()).toEqual(["atlas", "hephaestus", "prometheus", "sisyphus"].sort())
    for (const id of registered) {
      expect(agents.get(id)?.mode).toBe("primary")
      expect(agents.get(id)?.system?.length).toBeGreaterThan(0)
    }
    expect(String(agents.get("hephaestus")?.model?.id)).toBe("gpt-5.6-sol")
    expect(getDefault()).toBe("sisyphus")
  })

  test("#given a non-GPT system default on a cold catalog #when registering #then hephaestus is skipped but the other primaries register", async () => {
    const { ctx, catalog, agents } = createMockContext({ defaultModel: "zhipuai/glm-4.7" })

    const registered = await Effect.runPromise(Effect.scoped(registerPrimaries(ctx, { catalog })))

    expect([...registered].sort()).toEqual(["atlas", "prometheus", "sisyphus"].sort())
    expect(agents.get("hephaestus")).toBeUndefined()
    expect(agents.get("sisyphus")?.system?.length).toBeGreaterThan(0)
  })

  test("#given a warm catalog without a required provider #when registering #then hephaestus is skipped via the requiresProvider gate", async () => {
    const { ctx, catalog, agents } = createMockContext({
      availableModels: ["zhipuai/glm-4.7"],
      defaultModel: "zhipuai/glm-4.7",
    })

    const registered = await Effect.runPromise(Effect.scoped(registerPrimaries(ctx, { catalog })))

    expect(registered.has("hephaestus")).toBe(false)
    expect(agents.get("hephaestus")).toBeUndefined()
  })

  test("#given a catalog #when registering #then the built-in build agent is downgraded to a hidden subagent", async () => {
    const { ctx, catalog, agents } = createMockContext({ defaultModel: "zhipuai/glm-4.7" })

    await Effect.runPromise(Effect.scoped(registerPrimaries(ctx, { catalog })))

    expect(agents.get("build")?.mode).toBe("subagent")
    expect(agents.get("build")?.hidden).toBe(true)
  })

  test("#given a defaultAgent option #when registering #then it applies that as the default agent", async () => {
    const { ctx, catalog, getDefault } = createMockContext({ defaultModel: "zhipuai/glm-4.7" })

    await Effect.runPromise(Effect.scoped(registerPrimaries(ctx, { catalog, defaultAgent: "atlas" })))

    expect(getDefault()).toBe("atlas")
  })
})

describe("registerCategories", () => {
  test("#given a catalog #when registering #then all eight categories register as subagents with the executor prompt", async () => {
    const { ctx, catalog, agents } = createMockContext({ defaultModel: "zhipuai/glm-4.7" })

    const registered = await Effect.runPromise(Effect.scoped(registerCategories(ctx, { catalog })))

    expect([...registered].sort()).toEqual(
      ["visual-engineering", "ultrabrain", "deep", "artistry", "quick", "unspecified-low", "unspecified-high", "writing"].sort(),
    )
    for (const name of registered) {
      expect(agents.get(name)?.mode).toBe("subagent")
      expect(agents.get(name)?.system?.length).toBeGreaterThan(0)
    }
  })
})
