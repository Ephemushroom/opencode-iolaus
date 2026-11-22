import { expect, test } from "bun:test"
import { buildClaudeFable5SisyphusPrompt, getOraclePromptSelection } from "../src/omo/agents"
import { bindNative, renderAgent } from "../src/prompts/render"

test("Oracle's shared GPT advisory body does not advertise a model ID", () => {
  const baseline = renderAgent("oracle", { model: "openai/gpt-5.5" })

  for (const model of ["proxy-codex/gpt-6.2-astra", "openai/gpt-6-2-astra-fast", "azure/GPT-6.2-ASTRA"]) {
    expect(getOraclePromptSelection(model)).toMatchObject({ reasoningEffort: "xhigh", textVerbosity: "high" })
    const body = renderAgent("oracle", { model })
    expect(body === baseline).toBe(true)
    expect(bindNative(body)).not.toMatch(/\bgpt[- ]\d/i)
  }

  expect(getOraclePromptSelection("openai/gpt-5.5").reasoningEffort).toBe("medium")
  expect(renderAgent("oracle", { model: "openai/gpt-5.4" }) === baseline).toBe(false)
  expect(getOraclePromptSelection("gpt-6.2-astra/unknown-model").reasoningEffort).toBeUndefined()
})

test("Fable aliases render the shared Sisyphus body without a model ID", () => {
  const build = (model: string) => buildClaudeFable5SisyphusPrompt(model, [])
  for (const model of [
    "proxy-cc/claude-fable-5-2", "amazon-bedrock/anthropic.claude-fable-5.2",
    "anthropic/claude-mythos-5-2", "anthropic/claude-fable-5",
  ]) {
    const body = renderAgent("sisyphus", { model })
    expect(body === build(model)).toBe(true)
    expect(bindNative(body)).not.toMatch(/\bclaude[- ](?:fable|mythos)[- ]\d/i)
  }

  for (const model of ["anthropic/claude-sonnet-5-2", "claude-fable-5-2/unknown-model"]) {
    expect(renderAgent("sisyphus", { model }) === build(model)).toBe(false)
  }
})

test("Opus 5.5 aliases receive the dedicated addendum; adjacent lanes do not", () => {
  for (const [model, hasAddendum] of [
    ["proxy-cc/claude-opus-5-5", true], ["amazon-bedrock/anthropic.claude-opus-5.5", true],
    ["anthropic/claude-opus-5", false], ["anthropic/claude-sonnet-5-5", false],
  ] as const) {
    const prompt = bindNative(renderAgent("sisyphus", { model }), undefined, { routing: true })
    expect({ model, hasAddendum: prompt.includes("<opus_5_5>") }).toEqual({ model, hasAddendum })
  }
})
