import { describe, expect, test } from "bun:test"

import { injectSkillCatalogSystemPart } from "./skill-catalog-context"

describe("injectSkillCatalogSystemPart", () => {
  test("#given live skills #when injecting #then one structural catalog exposes every skill name", () => {
    // given
    const system = [{ type: "text", text: "base" }]
    const skills = [
      { name: "programming", description: "Programming" },
      { name: "git-master", description: "Git" },
    ]

    // when
    const output = injectSkillCatalogSystemPart(system, skills)

    // then
    const catalogs = output.filter((part) => part.text?.includes("<available-skills>"))
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]?.text).toContain("programming")
    expect(catalogs[0]?.text).toContain("git-master")
  })
})
