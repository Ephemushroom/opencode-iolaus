import { describe, expect, test } from "bun:test"

import { createContextHookComposer } from "./register-context-hooks"
import { buildSisyphusPromptForModel } from "../agents/sisyphus-prompt"

const STATIC_SISYPHUS = buildSisyphusPromptForModel("anthropic/claude-sonnet-5", [], [], [], [], false)

function makeHookInput() {
  return {
    sessionID: "ses_1",
    agent: "sisyphus",
    model: { id: "claude-sonnet-5", providerID: "anthropic" },
    system: [
      { type: "text", text: "[project] keep" },
      { type: "text", text: STATIC_SISYPHUS },
    ],
    messages: [],
    tools: { task: { description: "delegate", input: {} } },
  }
}

describe("createContextHookComposer", () => {
  test("#given a standalone hyperplan turn #when composed #then only the hyperplan mode tag is appended", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [],
      skillList: async () => [],
      lastUserText: async () => "hyperplan this migration",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then
    expect(output.system.filter((part) => part.text?.includes("<hyperplan-mode>"))).toHaveLength(1)
    expect(output.system.some((part) => part.text?.includes("<hyperplan-ultrawork-mode>"))).toBe(false)
    expect(output.system.some((part) => part.text?.includes("<ultrawork-mode>"))).toBe(false)
  })

  test("#given the standalone hpp shorthand #when composed #then the hyperplan mode tag is appended", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [],
      skillList: async () => [],
      lastUserText: async () => "hpp this migration",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then
    expect(output.system.filter((part) => part.text?.includes("<hyperplan-mode>"))).toHaveLength(1)
  })

  test("#given adjacent hyperplan and ultrawork triggers #when composed #then the combo suppresses both standalone modes", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [],
      skillList: async () => [],
      lastUserText: async () => "hyperplan ultrawork this migration",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then
    expect(output.system.filter((part) => part.text?.includes("<hyperplan-ultrawork-mode>"))).toHaveLength(1)
    expect(output.system.some((part) => part.text?.includes("<hyperplan-mode>"))).toBe(false)
    expect(output.system.filter((part) => part.text?.includes("<ultrawork-mode>"))).toHaveLength(1)
  })

  test("#given reverse adjacent combo triggers #when composed #then the same combo mode is appended", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [],
      skillList: async () => [],
      lastUserText: async () => "ulw hpp this migration",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then
    expect(output.system.filter((part) => part.text?.includes("<hyperplan-ultrawork-mode>"))).toHaveLength(1)
    expect(output.system.filter((part) => part.text?.includes("<ultrawork-mode>"))).toHaveLength(1)
  })

  test("#given repeated combo composition #when the same turn is processed twice #then one combo part persists", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [],
      skillList: async () => [],
      lastUserText: async () => "hpp ulw this migration",
    })
    let input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    input = await composer(input)
    const output = await composer(input)

    // then
    expect(output.system.filter((part) => part.text?.includes("<hyperplan-ultrawork-mode>"))).toHaveLength(1)
    expect(output.system.filter((part) => part.text?.includes("<ultrawork-mode>"))).toHaveLength(1)
  })

  test("#given non-adjacent hyperplan and ultrawork triggers #when composed #then both standalone modes are appended", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [],
      skillList: async () => [],
      lastUserText: async () => "hyperplan then use ultrawork for this migration",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then
    expect(output.system.some((part) => part.text?.includes("<hyperplan-ultrawork-mode>"))).toBe(false)
    expect(output.system.filter((part) => part.text?.includes("<hyperplan-mode>"))).toHaveLength(1)
    expect(output.system.filter((part) => part.text?.includes("<ultrawork-mode>"))).toHaveLength(1)
  })

  test("#given a C++ header path ending in hpp #when composed #then no hyperplan mode is appended", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [],
      skillList: async () => [],
      lastUserText: async () => "inspect src/include/interface.hpp",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then
    expect(output.system.some((part) => part.text?.includes("<hyperplan-mode>"))).toBe(false)
    expect(output.system.some((part) => part.text?.includes("<hyperplan-ultrawork-mode>"))).toBe(false)
  })

  test("#given a sisyphus session with live catalogs and a matching user turn #when composed #then dynamic rebake and one mode tag coexist", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [
        { id: "oracle", name: "oracle", description: "Oracle", mode: "subagent" },
        { id: "deep", name: "deep", description: "Deep", mode: "subagent" },
      ],
      skillList: async () => [{ name: "git-master", description: "Git", location: "project" }],
      commandList: async () => [{ name: "goal", description: "Goal" }],
      lastUserText: async () => "run ulw now",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then: project part preserved; sisyphus part rebaked with oracle; mode tag appended once
    expect(output.system[0]).toEqual({ type: "text", text: "[project] keep" })
    expect(output.system[1]?.text).toContain("oracle")
    expect(output.system.some((part) => part.text?.includes("/goal"))).toBe(true)
    const tagged = output.system.filter((part) => part.text?.includes("<ultrawork-mode>"))
    expect(tagged).toHaveLength(1)
  })

  test("#given a non-matching user turn #when composed #then rebake happens but no mode tag is appended", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [{ id: "oracle", name: "oracle", description: "Oracle", mode: "subagent" }],
      skillList: async () => [],
      commandList: async () => [],
      lastUserText: async () => "just help me",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then
    expect(output.system[1]?.text).toContain("oracle")
    expect(output.system.some((part) => part.text?.includes("<ultrawork-mode>"))).toBe(false)
  })

  test("#given the live agent list rejects #when composed #then the static sisyphus part survives and mode still injects", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => {
        throw new Error("catalog down")
      },
      skillList: async () => [],
      commandList: async () => [],
      lastUserText: async () => "ulw",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then: static sisyphus part untouched (rebake non-fatal), mode tag still appended
    expect(output.system[1]).toEqual({ type: "text", text: STATIC_SISYPHUS })
    expect(output.system.some((part) => part.text?.includes("<ultrawork-mode>"))).toBe(true)
  })

  test("#given repeated composed calls #when the same user turn triggers #then exactly one mode tag persists", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [{ id: "oracle", name: "oracle", description: "Oracle", mode: "subagent" }],
      skillList: async () => [],
      commandList: async () => [],
      lastUserText: async () => "ulw",
    })

    // when
    let input = makeHookInput() as Parameters<typeof composer>[0]
    input = await composer(input)
    const second = await composer(input)

    // then
    const tagged = second.system.filter((part) => part.text?.includes("<ultrawork-mode>"))
    expect(tagged).toHaveLength(1)
  })

  test("#given project rule context and a keyword turn #when composed #then rules join the same pipeline before the mode part", async () => {
    // given
    const projectPart = { type: "text", text: "PROJECT_RULE_CONTEXT_SENTINEL" }
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [],
      skillList: async () => [],
      commandList: async () => [],
      projectContext: async () => ({
        systemParts: [projectPart],
        ruleFiles: 1,
        agentsFiles: 0,
        diagnostics: 0,
      }),
      lastUserText: async () => "ulw",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]

    // when
    const output = await composer(input)

    // then
    const projectIndex = output.system.findIndex((part) => part.text === projectPart.text)
    const modeIndex = output.system.findIndex((part) => part.text?.includes("<ultrawork-mode>"))
    expect(projectIndex).toBeGreaterThanOrEqual(0)
    expect(modeIndex).toBeGreaterThan(projectIndex)
  })

  test("#given empty project rule context #when composed #then no placeholder system part is appended", async () => {
    // given
    const composer = createContextHookComposer({
      staticSisyphusPrompt: STATIC_SISYPHUS,
      agentList: async () => [],
      skillList: async () => [],
      commandList: async () => [],
      projectContext: async () => ({
        systemParts: [],
        ruleFiles: 0,
        agentsFiles: 0,
        diagnostics: 0,
      }),
      lastUserText: async () => "ordinary turn",
    })
    const input = makeHookInput() as Parameters<typeof composer>[0]
    const before = input.system.length

    // when
    const output = await composer(input)

    // then
    expect(output.system).toHaveLength(before)
  })
})
