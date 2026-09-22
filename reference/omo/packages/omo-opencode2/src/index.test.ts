import { describe, expect, test } from "bun:test"
import plugin from "./index"

describe("omo-opencode2 spike plugin", () => {
  test("#given the module default export #when inspected #then it is a v2 plugin definition with the omo id", () => {
    expect(plugin.id).toBe("omo")
    expect(typeof plugin.effect).toBe("function")
  })
})
