import { expect, test } from "bun:test"
import { AGENT_NAMES, CATEGORY_NAMES, MODE_NAMES } from "../src/prompts/catalog"
import { renderAgent, renderCategory, renderMode } from "../src/prompts/render"
import { getMetisPrompt, getMomusPromptSelection, getOraclePromptSelection } from "../src/omo/agents"
import {
  atlasPromptVariants,
  codexUltraworkPromptVariants,
  loadPromptSync,
  prometheusPromptVariants,
  ultraworkPromptVariants,
} from "../src/omo/modes/src"

/**
 * Contract: every prompt Iolaus ships describes Iolaus's own runtime (the
 * `.iolaus/plans/` layout, no notepads, no boulder, no `/ulw-execute`), never
 * OMO's `.omo/` layout it was ported from. This is a path-absence contract,
 * not a prose check: it says nothing about wording, section order, or length.
 */
const OMO_PATH = ".omo/"

// One model per branch that `resolveVariant`'s matchers key off (see
// src/omo/modes/src/variant-resolver.ts and src/omo/agents/types.ts), so
// rendering an agent/mode across this list exercises every variant that
// model-based selection can reach.
const MODELS = [
  "anthropic/claude-opus-5-5", // default
  "openai/gpt-5.5", // gpt (non-5.6/6)
  "openai/gpt-5.6", // gpt-5.6
  "openai/gpt-6", // gpt-6
  "google/gemini-3-pro", // gemini
  "z-ai/glm-5.2", // glm
  "moonshot/kimi-k3", // kimi-k3
  "moonshot/kimi-k2.7", // kimi-k2-7
  "moonshot/kimi-k2.6", // kimi (k2)
  "anthropic/claude-opus-4.7", // opus-4-7
]

for (const name of AGENT_NAMES) {
  for (const model of MODELS) {
    test(`agent prompt ${name} on ${model} has no .omo/ path`, () => {
      expect(renderAgent(name, { model })).not.toContain(OMO_PATH)
    })
  }
}

for (const mode of MODE_NAMES) {
  for (const model of MODELS) {
    test(`mode prompt ${mode} on ${model} has no .omo/ path`, () => {
      expect(renderMode(mode, model)).not.toContain(OMO_PATH)
    })
  }
}

for (const category of CATEGORY_NAMES) {
  test(`category prompt ${category} has no .omo/ path`, () => {
    expect(renderCategory(category, MODELS[0])).not.toContain(OMO_PATH)
  })
}

// Direct model-family selection for the specialists renderAgent's switch
// delegates to, so every non-default prompt variant is exercised even if a
// future MODELS entry stops matching resolveVariant's matchers.
test("momus prompt selection covers every model family with no .omo/ path", () => {
  for (const model of ["anthropic/claude-opus-5-5", "openai/gpt-5.5", "openai/gpt-5.6", "openai/gpt-6"]) {
    expect(getMomusPromptSelection(model).prompt).not.toContain(OMO_PATH)
  }
})

test("metis and oracle prompts have no .omo/ path", () => {
  for (const model of MODELS) {
    expect(getMetisPrompt(model)).not.toContain(OMO_PATH)
    expect(getOraclePromptSelection(model).prompt).not.toContain(OMO_PATH)
  }
})

// Belt-and-suspenders sweep of every bundled prompt variant table, including
// variants (like the codex ultrawork prompt) that no current model matcher
// selects but that Iolaus still bundles and could wire up later.
const variantTables: Array<{ name: string; variants: Record<string, unknown> }> = [
  { name: "atlas", variants: atlasPromptVariants },
  { name: "prometheus", variants: prometheusPromptVariants },
  { name: "ultrawork", variants: ultraworkPromptVariants },
  { name: "ultrawork", variants: codexUltraworkPromptVariants },
]

for (const { name, variants } of variantTables) {
  for (const [variant, source] of Object.entries(variants)) {
    test(`bundled prompt ${name}/${variant} has no .omo/ path`, () => {
      const { body } = loadPromptSync({ source: source as never, name, variant })
      expect(body).not.toContain(OMO_PATH)
    })
  }
}
