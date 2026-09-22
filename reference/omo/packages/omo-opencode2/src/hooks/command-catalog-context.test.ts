import { describe, expect, test } from "bun:test"

import { injectCommandCatalogSystemPart } from "./command-catalog-context"

describe("injectCommandCatalogSystemPart", () => {
  test("#given live commands #when injecting #then one structural catalog exposes every slash name", () => {
    // given
    const system = [{ type: "text", text: "base" }]
    const commands = [
      { name: "goal", description: "goal command" },
      { name: "handoff", description: "handoff command" },
    ]

    // when
    const output = injectCommandCatalogSystemPart(system, commands)

    // then
    const catalogs = output.filter((part) => part.text?.includes("<available-slash-commands>"))
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]?.text).toContain("/goal")
    expect(catalogs[0]?.text).toContain("/handoff")
  })
})
