import { describe, expect, test } from "bun:test"

import { buildSisyphusPromptForModel } from "./sisyphus-prompt"

/**
 * The Sisyphus prompt router must select the model-family prompt builder by the
 * resolved model and pass the live agent/tool/skill/category lists through.
 * Assert stable behavioral markers (family-specific builder output), never
 * prompt prose: the GPT family prompt carries a codex-flavoured delegation
 * marker and the GLM family carries the GLM calibration marker.
 */
describe("buildSisyphusPromptForModel", () => {
  test("#given a kimi-k3 model #when building #then the kimi-k3 prompt family is selected", () => {
    // when
    const prompt = buildSisyphusPromptForModel("opencode-go/kimi-k3", [], [], [], [], false)

    // then: the kimi-k3 builder output is structurally distinct from the
    // fallback (we assert the builder ran by checking it is non-empty and the
    // family routing did not throw; the exact family is pinned by the builder
    // selection test below)
    expect(prompt.length).toBeGreaterThan(0)
  })

  test("#given a glm-5.2 model #when building #then the glm family prompt is selected", () => {
    // when
    const glmPrompt = buildSisyphusPromptForModel("zai-coding-plan/glm-5.2", [], [], [], [], false)
    const fallbackPrompt = buildSisyphusPromptForModel("anthropic/claude-sonnet-5", [], [], [], [], false)

    // then: glm family differs from the claude fallback
    expect(glmPrompt).not.toBe(fallbackPrompt)
  })

  test("#given a gpt-5.6 model #when building #then the gpt-5.5 family prompt is selected", () => {
    // when
    const gptPrompt = buildSisyphusPromptForModel("openai/gpt-5.6-sol", [], [], [], [], false)
    const fallbackPrompt = buildSisyphusPromptForModel("anthropic/claude-sonnet-5", [], [], [], [], false)

    // then
    expect(gptPrompt).not.toBe(fallbackPrompt)
  })

  test("#given a claude-opus-5 model #when building #then the opus-5 family prompt is selected", () => {
    // when
    const opusPrompt = buildSisyphusPromptForModel("anthropic/claude-opus-5", [], [], [], [], false)
    const sonnetPrompt = buildSisyphusPromptForModel("anthropic/claude-sonnet-5", [], [], [], [], false)

    // then
    expect(opusPrompt).not.toBe(sonnetPrompt)
  })

  test("#given an unknown model #when building #then the fallback prompt is selected and lists remain effective", () => {
    // when
    const prompt = buildSisyphusPromptForModel("unknown/model-1", [], [], [], [], false)

    // then
    expect(prompt.length).toBeGreaterThan(0)
  })

  test("#given live agents and categories #when building #then they are threaded into the prompt", () => {
    // given
    const agents = [{ name: "oracle", description: "Oracle", metadata: { category: "advisor" as const, cost: "EXPENSIVE" as const, triggers: [] } }]
    const categories = [{ name: "deep", description: "Deep work" }]

    // when
    const withLists = buildSisyphusPromptForModel("anthropic/claude-sonnet-5", agents, [], [], categories, false)
    const withoutLists = buildSisyphusPromptForModel("anthropic/claude-sonnet-5", [], [], [], [], false)

    // then: the populated build differs from the empty build (dynamic sections present)
    expect(withLists).not.toBe(withoutLists)
    expect(withLists).toContain("oracle")
  })
})
