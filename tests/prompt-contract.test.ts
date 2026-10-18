import { expect, test } from "bun:test"
import { buildIolausFlowSection } from "../src/omo/agents/iolaus-flow-section"
import { buildSisyphusPromptForModel } from "../src/prompts/sisyphus-route"
import { buildDynamicHephaestusPrompt } from "../src/omo/agents/hephaestus/prompt-router"
import { buildSisyphusJuniorPrompt } from "../src/omo/agents"
import { renderAgent, renderMode } from "../src/prompts/render"

/**
 * The failure this guards against: a prompt told the model to call `todowrite`
 * or `task_create`, or to wait for a `[SYSTEM REMINDER - TODO CONTINUATION]`
 * hook, none of which this harness registers. A model that follows such a line
 * either calls a missing tool or stops waiting for a nudge that never comes.
 */
const ABSENT = [
  /todowrite/i, /task_create/i, /TaskCreate/, /TaskUpdate/, /task_update/,
  /TODO CONTINUATION/, /TASK CONTINUATION/, /background_output/, /background_cancel/,
  /load_skills/, /run_in_background/, /subagent_type/, /call_omo_agent/, /delegate_task/,
  // OMO's team tool set: this harness builds a team from the DAG template instead.
  /team_(?:create|task|send|shutdown|delete|approve|list)/, /update_plan/, /oh-my-opencode/,
  // The retained planning skill is not shipped; the planner doctrine is the prompt.
  /`ulw-plan`|skill\(name="ulw-plan"\)/,
  // There is no `plan` agent in the catalog, and goal tools are Hephaestus-only.
  // Commit discipline belongs to the user's authorization, not to a mode prompt.
  /agent:\s*"plan"/, /\bplan agent\b/i, /\bcreate_goal\b/, /\bCommit frequently\b/,
]

function expectNoAbsentTools(text: string, where: string) {
  for (const pattern of ABSENT) expect({ where, match: text.match(pattern)?.[0] }).toEqual({ where, match: undefined })
}

test("the flow section describes a capability, not a progress ledger", () => {
  const section = buildIolausFlowSection()
  expectNoAbsentTools(section, "flow section")
  expect(section).toContain("iolaus_flow")
  // It must say what the tool buys (fresh context, dependency order) ...
  expect(section).toContain("Fresh context per node")
  expect(section).toContain("dependsOn")
  // ... and must not turn itself into the todo list it replaced. "not a
  // checklist" is the disclaimer, so the assertions target the framing itself.
  expect(section).not.toMatch(/is (?:your|the) (?:ledger|checklist)/i)
  expect(section).not.toMatch(/stays tracked/i)
  expect(section).not.toMatch(/multi-part work is tracked/i)
  expect(section).not.toMatch(/while nodes are open, keep working/i)
  // The worker contract carries no orchestration.
  const worker = buildIolausFlowSection({ worker: true })
  expect(worker).not.toContain("iolaus_flow action=\"create\"")
  expect(worker).toContain("Do not create a flow of your own")
})

test("every Sisyphus family receives the flow rule and no dead tool", () => {
  const models = [
    "anthropic/claude-opus-4-7", "anthropic/claude-opus-4-8", "anthropic/claude-opus-5", "anthropic/claude-opus-5-5",
    "anthropic/claude-fable-5", "openai/gpt-5.4", "openai/gpt-5.5", "openai/gpt-6-astra",
    "moonshot/kimi-k2.6", "moonshot/kimi-k3", "xai/grok-4-6", "zhipu/glm-5.2", "custom/unknown-model",
  ]
  for (const model of models) {
    const prompt = buildSisyphusPromptForModel(model, [], [], [], [], false)
    expectNoAbsentTools(prompt, model)
    expect({ model, flow: prompt.includes("iolaus_flow") }).toEqual({ model, flow: true })
  }
})

test("Hephaestus and the category lanes work under the completion contract, without orchestration", () => {
  for (const model of ["openai/gpt-5.5", "openai/gpt-6-astra", "openai/gpt-6.1-sol"]) {
    const prompt = buildDynamicHephaestusPrompt({ model })
    expectNoAbsentTools(prompt, `hephaestus ${model}`)
    expect(prompt).toContain("Do not create a flow of your own")
  }
  for (const model of ["openai/gpt-5.5", "openai/gpt-6-astra", "moonshot/kimi-k3", "zhipu/glm-5.2"]) {
    expectNoAbsentTools(buildSisyphusJuniorPrompt(model, false), `junior ${model}`)
  }
})

test("mode prompts delegate with the native subagent contract", () => {
  for (const mode of ["ultrawork", "hyperplan", "team"] as const) {
    const prompt = renderMode(mode, "anthropic/claude-opus-5-5", "sisyphus")
    expect({ mode, legacy: /\btask\(/.test(prompt) }).toEqual({ mode, legacy: false })
    expectNoAbsentTools(prompt, `mode ${mode}`)
  }
  // atlas is an agent, not a mode; it is rendered through the same markdown set.
  expect(renderMode("ultrawork", "openai/gpt-6-astra", "sisyphus")).toContain("subagent(")
})

test("the Anthropic-idiom carriers read the Anthropic bodies, and no reachable body names a dead tool", () => {
  // GLM, Kimi and DeepSeek borrow the Anthropic idiom; they must reach the same
  // Claude-shaped bodies as an Opus model and must not be told they are Claude.
  for (const model of ["zhipu/glm-5.2", "moonshot/kimi-k3", "custom/deepseek-v4"]) {
    const atlas = renderAgent("atlas", { model })
    expect({ model, ticket: atlas.includes("<ticket_work>") }).toEqual({ model, ticket: true })
    expect({ model, legacyWave: atlas.includes("Final Verification Wave") }).toEqual({ model, legacyWave: false })
    expectNoAbsentTools(atlas, `atlas ${model}`)
    expectNoAbsentTools(renderMode("ultrawork", model, "sisyphus"), `ultrawork ${model}`)
    expectNoAbsentTools(renderAgent("sisyphus", { model }), `sisyphus ${model}`)
    expectNoAbsentTools(renderAgent("hephaestus", { model }), `hephaestus ${model}`)
    expectNoAbsentTools(renderAgent("sisyphus-junior", { model }), `junior ${model}`)
  }
  // OpenAI and Gemini keep their own mode bodies.
  expect(renderMode("ultrawork", "openai/gpt-6-astra", "sisyphus")).toContain("<output_verbosity_spec>")
  expect(renderMode("ultrawork", "google/gemini-4", "sisyphus")).toContain("<GEMINI_INTENT_GATE>")
})
