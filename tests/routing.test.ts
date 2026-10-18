import { expect, test } from "bun:test"
import { parseOptions } from "../src/options"
import { resolveVariant } from "../src/prompts"
import { getHephaestusPromptSource } from "../src/omo/agents/hephaestus/prompt-router"
import { buildSisyphusPromptForModel } from "../src/prompts/sisyphus-route"
import { buildGpt55SisyphusPrompt, buildClaudeOpus48SisyphusPrompt, buildClaudeOpus5SisyphusPrompt, buildClaudeOpus55SisyphusPrompt, buildGpt6AstraSisyphusPrompt, buildKimiK3SisyphusPrompt } from "../src/omo/agents"
import { identifyModel, resolvePromptLane } from "../src/prompts/prompt-lanes"

test("variant precedence honors planner and specific family before fallback", () => {
  const variants = Object.fromEntries(["planner", "kimi-k3", "kimi", "gpt", "default"].map((name) => [name, { kind: "bundled" as const, content: name, filePath: name }]))
  for (const [modelID, expected] of [["openai/gpt-6", "gpt"], ["moonshot/kimi-k3", "kimi-k3"], ["moonshot/kimi-k2.5", "kimi"], ["custom/unknown", "default"]]) {
    expect(resolveVariant({ modelID, variants })).toBe(expected)
  }
  expect(resolveVariant({ agentName: "prometheus", modelID: "openai/gpt-6", variants })).toBe("planner")
  expect(() => resolveVariant({ variants: {} })).toThrow()
  expect(getHephaestusPromptSource("openai/gpt-6-astra")).toBe("gpt-6-astra")
  expect(getHephaestusPromptSource("openai/gpt-6.1-sol")).toBe("gpt-5-6")
})

test("Sisyphus selects retained family builders without asserting prose", () => {
  for (const [model, builder] of [
    ["openai/gpt-5.5", buildGpt55SisyphusPrompt],
    ["openai/gpt-6-astra", buildGpt6AstraSisyphusPrompt],
    ["anthropic/claude-opus-4-8", buildClaudeOpus48SisyphusPrompt],
    ["anthropic/claude-opus-5", buildClaudeOpus5SisyphusPrompt],
    ["anthropic/claude-opus-5-5", buildClaudeOpus55SisyphusPrompt],
    ["moonshot/kimi-k3", buildKimiK3SisyphusPrompt],
  ] as const) {
    expect(buildSisyphusPromptForModel(model, [], [], [], [], false)).toBe(builder(model, [], [], [], [], false))
  }
})

test("prompt lanes resolve by vendor, class and nearest version inside the class", () => {
  const lane = (model: string) => resolvePromptLane(model)?.lane
  // Anthropic classes keep their own prompt and pick the newest version at or below.
  expect(lane("proxy-cc/claude-opus-5-5")).toBe("claude-opus-5-5")
  expect(lane("anthropic/claude-opus-5")).toBe("claude-opus-5")
  expect(lane("anthropic/claude-opus-4-7")).toBe("claude-opus-4-7")
  expect(lane("anthropic/claude-fable-5-1")).toBe("claude-fable-5")
  // A class with no entry never borrows another class's prompt.
  expect(lane("anthropic/claude-sonnet-5-5")).toBeUndefined()
  expect(lane("anthropic/claude-haiku-4-5")).toBeUndefined()
  // OpenAI codenames are their own classes; Astra has its own prompt, the rest share the retained body.
  expect(lane("proxy-codex/gpt-6-astra")).toBe("gpt-6-astra")
  expect(lane("proxy-codex/gpt-6.1-sol")).toBe("gpt-5-5")
  expect(lane("openai/gpt-6-luna-fast")).toBe("gpt-5-5")
  expect(lane("openai/gpt-5.6-terra")).toBe("gpt-5-5")
  // The model name beats the provider: an OpenAI-compatible transport still serves Claude.
  expect(lane("openai/claude-opus-4-8")).toBe("claude-opus-4-8")
  expect(identifyModel("openai/claude-opus-4-8").vendor).toBe("anthropic")
  expect(lane("openai/gpt-6-astra")).toBe("gpt-6-astra")
  // Non-OpenAI vendors are not table-routed.
  expect(identifyModel("bryan/gemini-4-argon").vendor).toBe("google")
  expect(lane("bryan/gemini-4-argon")).toBeUndefined()
})

test("options reject stale OMO settings and unknown names", () => {
  expect(parseOptions({ enabled: false }).enabled).toBe(false)
  expect(parseOptions({ agents: ["oracle", "oracle"], modes: [] }).agents).toEqual(["oracle"])
  for (const input of [{ enabled: "false" }, { team_mode: { enabled: true } }, { agents: ["build"] }, { modes: ["typo"] }]) {
    expect(() => parseOptions(input)).toThrow()
  }
})
