import { expect, test } from "bun:test"
import { parseOptions } from "../src/options"
import { resolveVariant } from "../src/prompts"
import { getHephaestusPromptSource } from "../src/omo/agents/hephaestus/prompt-router"
import { buildSisyphusPromptForModel } from "../src/prompts/sisyphus-route"
import { buildGpt55SisyphusPrompt, buildClaudeOpus48SisyphusPrompt, buildKimiK3SisyphusPrompt } from "../src/omo/agents"

test("variant precedence honors planner and specific family before fallback", () => {
  const variants = Object.fromEntries(["planner", "kimi-k3", "kimi", "gpt", "default"].map((name) => [name, { kind: "bundled" as const, content: name, filePath: name }]))
  for (const [modelID, expected] of [["openai/gpt-6", "gpt"], ["moonshot/kimi-k3", "kimi-k3"], ["moonshot/kimi-k2.5", "kimi"], ["custom/unknown", "default"]]) {
    expect(resolveVariant({ modelID, variants })).toBe(expected)
  }
  expect(resolveVariant({ agentName: "prometheus", modelID: "openai/gpt-6", variants })).toBe("planner")
  expect(() => resolveVariant({ variants: {} })).toThrow()
  expect(getHephaestusPromptSource("openai/gpt-6-astra")).toBe("gpt-5-6")
})

test("Sisyphus selects retained family builders without asserting prose", () => {
  for (const [model, builder] of [
    ["openai/gpt-5.5", buildGpt55SisyphusPrompt],
    ["anthropic/claude-opus-4-8", buildClaudeOpus48SisyphusPrompt],
    ["moonshot/kimi-k3", buildKimiK3SisyphusPrompt],
  ] as const) {
    expect(buildSisyphusPromptForModel(model, [], [], [], [], false)).toBe(builder(model, [], [], [], [], false))
  }
})

test("options reject stale OMO settings and unknown names", () => {
  expect(parseOptions({ enabled: false }).enabled).toBe(false)
  expect(parseOptions({ agents: ["oracle", "oracle"], modes: [] }).agents).toEqual(["oracle"])
  for (const input of [{ enabled: "false" }, { team_mode: { enabled: true } }, { agents: ["build"] }, { modes: ["typo"] }]) {
    expect(() => parseOptions(input)).toThrow()
  }
})
