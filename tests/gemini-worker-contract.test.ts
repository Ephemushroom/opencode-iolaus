import { expect, test } from "bun:test"
import { buildGeminiSisyphusJuniorPrompt } from "../src/omo/agents/sisyphus-junior/gemini"
import { CATEGORY_NAMES } from "../src/prompts/catalog"
import { renderAgent, renderCategory } from "../src/prompts/render"

const absentToolCalls = /\b(?:subagent|iolaus_flow|lsp_\w+|todowrite|todoread|task_create|task_update|task_list|TaskCreate|TaskUpdate)\b/

for (const model of ["bryan/gemini-4-hydrogen", "bryan/gemini-4-carbon", "bryan/gemini-4-neon"]) {
  test(`${model} renders the Gemini worker contract as Junior and in every category`, () => {
    const worker = renderAgent("sisyphus-junior", { model })
    expect(worker).toBe(buildGeminiSisyphusJuniorPrompt(false))
    expect(worker).toContain("<completion>")
    expect(worker).not.toMatch(absentToolCalls)
    expect(worker).not.toContain("<Category_Context")
    expect(worker).not.toContain("ESCALATE: deep-high")

    for (const category of CATEGORY_NAMES) {
      const rendered = renderCategory(category, model)
      const categoryBlock = rendered.match(/<Category_Context name="[^"]+">[\s\S]*?<\/Category_Context>/)?.[0]
      expect(categoryBlock).toContain(`<Category_Context name="${category}">`)
      expect(rendered.replace(categoryBlock ?? "", "").trim()).toBe(worker)
      expect(rendered).not.toMatch(absentToolCalls)
      expect(rendered.includes("ESCALATE: deep-high")).toBe(category === "deep-low")
    }
  })
}
