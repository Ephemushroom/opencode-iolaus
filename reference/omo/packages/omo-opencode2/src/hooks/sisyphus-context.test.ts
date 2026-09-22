import { describe, expect, test } from "bun:test"

import { rebakeSisyphusSystemPart } from "./sisyphus-context"
import type { SisyphusContextInput } from "./sisyphus-context"
import { buildSisyphusPromptForModel } from "../agents/sisyphus-prompt"

const STATIC_SISYPHUS = buildSisyphusPromptForModel("anthropic/claude-sonnet-5", [], [], [], [], false)

function makeInput(overrides: Partial<SisyphusContextInput> = {}): SisyphusContextInput {
  return {
    model: "anthropic/claude-sonnet-5",
    staticSisyphusPrompt: STATIC_SISYPHUS,
    system: [
      { type: "text", text: "[project instructions] keep me" },
      { type: "text", text: STATIC_SISYPHUS },
      { type: "text", text: "[third-party] keep me too" },
    ],
    tools: { task: { description: "delegate", input: {} }, bash: { description: "run", input: {} } },
    agentList: [
      { id: "oracle", name: "oracle", description: "Oracle desc", mode: "subagent" },
      { id: "explore", name: "explore", description: "Explore desc", mode: "subagent" },
    ] as SisyphusContextInput["agentList"],
    skillList: [
      { name: "git-master", description: "Git ops", location: "project" },
      { name: "frontend", description: "UI", location: "user" },
    ] as SisyphusContextInput["skillList"],
  }
}

describe("rebakeSisyphusSystemPart", () => {
  test("#given live agents and tools #when rebaking #then only the static sisyphus part is replaced", () => {
    // given
    const input = makeInput()

    // when
    const output = rebakeSisyphusSystemPart(input)

    // then: the static part is replaced by a dynamic build; unrelated parts survive
    expect(output.system).toHaveLength(3)
    expect(output.system[0]).toEqual({ type: "text", text: "[project instructions] keep me" })
    expect(output.system[1]?.type).toBe("text")
    expect(output.system[1]?.text).toContain("oracle")
    expect(output.system[1]?.text).toContain("explore")
    expect(output.system[1]?.text).toContain("git-master")
    expect(output.system[2]).toEqual({ type: "text", text: "[third-party] keep me too" })
    expect(output.rebaked).toBe(true)
  })

  test("#given the sisyphus part is absent #when rebaking #then the system array is untouched", () => {
    // given
    const input = makeInput()
    input.system = [{ type: "text", text: "[only project]" }]

    // when
    const output = rebakeSisyphusSystemPart(input)

    // then
    expect(output.rebaked).toBe(false)
    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toEqual({ type: "text", text: "[only project]" })
  })

  test("#given live agent and skill lists #when rebaking #then categories are derived from agents, not the metadata table", () => {
    // given: agent list includes a category id (deep) not in the specialist table
    const input = makeInput({
      agentList: [
        { id: "oracle", name: "oracle", description: "Oracle", mode: "subagent" },
        { id: "deep", name: "deep", description: "Deep work", mode: "subagent" },
      ] as SisyphusContextInput["agentList"],
    })

    // when
    const output = rebakeSisyphusSystemPart(input)

    // then: the dynamic prompt contains the deep category surfaced as an available agent
    expect(output.system[1]?.text).toContain("deep")
  })

  test("#given the agent list API rejects #when rebaking #then the static prompt is preserved", () => {
    // given
    const input = makeInput()
    input.agentListError = new Error("boom")

    // when
    const output = rebakeSisyphusSystemPart(input)

    // then: no rebake, static part untouched
    expect(output.rebaked).toBe(false)
    expect(output.system[1]).toEqual({ type: "text", text: STATIC_SISYPHUS })
  })

  test("#given repeated calls with the same inputs #when rebaking #then output is deterministic", () => {
    // given
    const input = makeInput()

    // when
    const first = rebakeSisyphusSystemPart(input)
    const second = rebakeSisyphusSystemPart(input)

    // then
    expect(first.system[1]?.text).toBe(second.system[1]?.text)
  })
})
