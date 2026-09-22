import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, Model } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { Effect } from "effect"

import { registerConfiguredAgents, resolveAgentRegistrationConfig } from "./register-configured"
import { createCatalogSource } from "./model-resolution"
import { buildSisyphusPromptForModel } from "./sisyphus-prompt"

function createDeferredContext() {
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number] & Agent.Info>()
  const callbacks = new Set<(editor: AgentEditor) => void>()
  let defaultAgent: string | undefined
  const editor: AgentEditor = {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    default: (id) => { defaultAgent = id },
    update: (id, update) => {
      const agent = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id))
      update(agent)
      agents.set(id, agent)
    },
    remove: (id) => { agents.delete(id) },
  }
  const ctx: Parameters<typeof registerConfiguredAgents>[0] = {
    options: {
      agents: {
        sisyphus: { model: "custom-primary/sisyphus-model" },
        oracle: { model: "custom-subagent/oracle-model" },
        quick: { model: "custom-category/quick-model" },
      },
      default_agent: "atlas",
    },
    agent: {
      transform: (callback) => Effect.sync(() => {
        callbacks.add(callback)
        return { dispose: Effect.sync(() => { callbacks.delete(callback) }) }
      }),
      list: () => Effect.sync(() => {
        for (const callback of callbacks) callback(editor)
        return { data: [...agents.values()] }
      }),
    },
  }
  return { ctx, agents, getDefault: () => defaultAgent }
}

describe("registerConfiguredAgents with deferred transforms", () => {
  let directory: string
  let previousHome: string | undefined
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "oc2-deferred-registration-"))
    previousHome = process.env.HOME
    process.env.HOME = directory
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  })

  test("#given deferred transforms #when registration returns #then delegation catalogs are populated", async () => {
    // given
    const { ctx, getDefault } = createDeferredContext()
    // when
    const result = await Effect.runPromise(Effect.scoped(registerConfiguredAgents(ctx, { catalog: createCatalogSource(), directory })))
    // then
    expect([...result.primaries]).toEqual(["sisyphus", "hephaestus", "prometheus", "atlas"])
    expect([...result.subagents].sort()).toEqual(
      ["oracle", "librarian", "explore", "multimodal-looker", "metis", "momus", "sisyphus-junior"].sort(),
    )
    expect([...result.categories].sort()).toEqual(
      ["visual-engineering", "ultrabrain", "deep", "artistry", "quick", "unspecified-low", "unspecified-high", "writing"].sort(),
    )
    expect(getDefault()).toBe("atlas")
  })

  test("#given a configured Sisyphus model #when deferred registration returns #then its captured base equals the registered artifact", async () => {
    // given
    const { ctx, agents } = createDeferredContext()
    const expected = buildSisyphusPromptForModel("custom-primary/sisyphus-model", [], [], [], [], false)
    // when
    const result = await Effect.runPromise(Effect.scoped(registerConfiguredAgents(ctx, { catalog: createCatalogSource(), directory })))
    // then
    expect(result.sisyphusPrompt).toBe(expected)
    expect(agents.get("sisyphus")?.system).toBe(expected)
  })

  test.each([
    ["oracle", "custom-subagent/oracle-model"],
    ["quick", "custom-category/quick-model"],
  ])("#given configured %s #when deferred registration returns #then dispatch retains model %s", async (id, model) => {
    // given
    const { ctx, agents } = createDeferredContext()
    // when
    const result = await Effect.runPromise(Effect.scoped(registerConfiguredAgents(ctx, { catalog: createCatalogSource(), directory })))
    // then
    expect(result.models?.get(id)).toBe(model)
    expect(agents.get(id)?.model).toEqual(Model.Ref.parse(model))
  })
})

describe("resolveAgentRegistrationConfig", () => {
  test("#given distinct overrides and a configured default #when resolved #then neither falls back to built-in values", () => {
    // given
    const agents = {
      sisyphus: { model: "custom-primary/sisyphus-model", variant: "primary-variant" },
      oracle: { model: "custom-subagent/oracle-model", variant: "subagent-variant" },
      quick: { model: "custom-category/quick-model", variant: "category-variant" },
    }

    // when
    const resolved = resolveAgentRegistrationConfig({
      agents,
      default_agent: "atlas",
    })

    // then
    expect(resolved.agentOverrides).toBe(agents)
    expect(resolved.defaultAgent).toBe("atlas")
  })

  test("#given no configured default #when resolved #then sisyphus remains the product default", () => {
    expect(resolveAgentRegistrationConfig({}).defaultAgent).toBe("sisyphus")
  })
})
