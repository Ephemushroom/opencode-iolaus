import { describe, expect, test } from "bun:test"
import { getGptPromptIdentityKey } from "../src/gpt-prompt-identity"
import { getHephaestusPromptSource } from "../src/hephaestus/prompt-router"
import { getSisyphusJuniorPromptSource } from "../src/sisyphus-junior/prompt-router"
import { getOraclePromptSelection } from "../src/specialists/oracle-prompt"
import { getMomusPromptSelection } from "../src/specialists/momus-prompt"

describe("#given GPT-6 Astra through an extracted agent router", () => {
  for (const model of ["openai/gpt-6-astra", "openai-codex/gpt-6-astra-fast", "github-copilot/gpt-6-astra"]) {
    test(`#when identifying ${model} #then selects the Astra identity key`, () => {
      expect(getGptPromptIdentityKey(model)).toBe("gpt-6-astra")
    })

    test(`#when routing Hephaestus ${model} #then selects the GPT-5.6 family`, () => {
      expect(getHephaestusPromptSource(model)).toBe("gpt-5-6")
    })

    test(`#when routing Junior ${model} #then selects the GPT-5.5 family`, () => {
      expect(getSisyphusJuniorPromptSource(model)).toBe("gpt-5-5")
    })

    test(`#when selecting Oracle ${model} #then uses xhigh reasoning`, () => {
      expect(getOraclePromptSelection(model).reasoningEffort).toBe("xhigh")
    })

    test(`#when selecting Momus ${model} #then uses high reasoning`, () => {
      expect(getMomusPromptSelection(model).reasoningEffort).toBe("high")
    })
  }

  test("#when identifying a previous GPT family #then keeps its identity", () => {
    expect(getGptPromptIdentityKey("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol")
  })
})
