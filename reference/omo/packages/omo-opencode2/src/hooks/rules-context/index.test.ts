import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { loadProjectRulesContext } from "."

let fixtureRoot: string | undefined

function createFixture(name: string): string {
  fixtureRoot = join(tmpdir(), `${name}-${crypto.randomUUID()}`)
  mkdirSync(fixtureRoot, { recursive: true })
  writeFileSync(join(fixtureRoot, "package.json"), "{}")
  return fixtureRoot
}

afterEach(() => {
  if (fixtureRoot !== undefined) {
    rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = undefined
  }
})

describe("loadProjectRulesContext", () => {
  test("#given project AGENTS.md and static plus conditional rules #when loading #then only applicable project context becomes system parts", async () => {
    // given
    const root = createFixture("oc2-rules-context-present")
    mkdirSync(join(root, ".omo", "rules"), { recursive: true })
    writeFileSync(join(root, "AGENTS.md"), "AGENTS_CONTEXT_SENTINEL")
    writeFileSync(
      join(root, ".omo", "rules", "always.md"),
      "---\nalwaysApply: true\n---\nRULE_CONTEXT_SENTINEL\n",
    )
    writeFileSync(
      join(root, ".omo", "rules", "conditional.md"),
      "---\nglobs: [\"src/**/*.ts\"]\n---\nCONDITIONAL_RULE_SENTINEL\n",
    )

    // when
    const result = await loadProjectRulesContext(root)

    // then
    expect(result.ruleFiles).toBe(1)
    expect(result.agentsFiles).toBe(1)
    expect(result.diagnostics).toBe(0)
    expect(result.systemParts).toHaveLength(2)
    expect(result.systemParts.some((part) => part.text.includes("RULE_CONTEXT_SENTINEL"))).toBe(true)
    expect(result.systemParts.some((part) => part.text.includes("AGENTS_CONTEXT_SENTINEL"))).toBe(true)
    expect(result.systemParts.some((part) => part.text.includes("CONDITIONAL_RULE_SENTINEL"))).toBe(false)
  })

  test("#given a project without rule or AGENTS.md files #when loading #then no system context is produced", async () => {
    // given
    const root = createFixture("oc2-rules-context-absent")

    // when
    const result = await loadProjectRulesContext(root)

    // then
    expect(result).toEqual({
      systemParts: [],
      ruleFiles: 0,
      agentsFiles: 0,
      diagnostics: 0,
    })
  })
})
