import { describe, expect, test } from "bun:test"

import { OpenCode2ConfigSchema } from "./schema"

describe("OpenCode2ConfigSchema disabled_mcps", () => {
  test("accepts built-in and retired names", () => {
    const parsed = OpenCode2ConfigSchema.safeParse({
      disabled_mcps: ["context7", "grep_app", "lsp", "codegraph"],
    })
    expect(parsed.success).toBe(true)
  })

  test("passes unknown names through permissively", () => {
    const parsed = OpenCode2ConfigSchema.safeParse({ disabled_mcps: ["whatever"] })
    expect(parsed.success).toBe(true)
  })
})

describe("OpenCode2ConfigSchema codegraph", () => {
  test.each([
    { daemon: false, install_dir: "/opt/cg", excluded_roots: ["/tmp"] },
    { daemon: "obsolete", install_dir: 17 },
    "retired",
  ])("#given stale CodeGraph config %j #when parsing #then unrelated settings survive and the retired block is stripped", (codegraph) => {
    // given
    const input = {
      codegraph,
      default_agent: "atlas",
      agents: { atlas: { model: "custom/model" } },
      disabled_mcps: ["grep_app", "codegraph"],
    }

    // when
    const parsed = OpenCode2ConfigSchema.parse(input)

    // then
    expect(parsed).toEqual({
      default_agent: "atlas",
      agents: { atlas: { model: "custom/model" } },
      disabled_mcps: ["grep_app", "codegraph"],
    })
  })
})
