import { describe, expect, test } from "bun:test"

import { createSessionModelRegistry, formatModelKey } from "./session-model-registry"

describe("createSessionModelRegistry", () => {
  test("#given a recorded session #when reading it back #then the model is returned", () => {
    // given
    const registry = createSessionModelRegistry()
    registry.record("ses_1", "zhipuai/glm-4.7")

    // when
    const model = registry.read("ses_1")

    // then
    expect(model).toBe("zhipuai/glm-4.7")
  })

  test("#given an unseen session #when reading #then it is undefined rather than throwing", () => {
    // given
    const registry = createSessionModelRegistry()

    // when
    const model = registry.read("ses_missing")

    // then
    expect(model).toBeUndefined()
  })

  test("#given a session that switched model #when reading #then the latest wins", () => {
    // given
    const registry = createSessionModelRegistry()
    registry.record("ses_1", "zhipuai/glm-4.7")
    registry.record("ses_1", "acme/seer")

    // when
    const model = registry.read("ses_1")

    // then
    expect(model).toBe("acme/seer")
  })

  test("#given a forgotten session #when reading #then the entry is gone", () => {
    // given
    const registry = createSessionModelRegistry()
    registry.record("ses_1", "acme/seer")
    registry.forget("ses_1")

    // when
    const model = registry.read("ses_1")

    // then
    expect(model).toBeUndefined()
  })

  test("#given a blank session id or model #when recording #then nothing is stored", () => {
    // given
    const registry = createSessionModelRegistry()

    // when
    registry.record("", "acme/seer")
    registry.record("ses_1", "")

    // then
    expect(registry.read("")).toBeUndefined()
    expect(registry.read("ses_1")).toBeUndefined()
  })
})

describe("formatModelKey", () => {
  test("#given a model ref #when formatting #then it joins provider and id", () => {
    // given
    const ref = { id: "glm-4.7", providerID: "zhipuai" }

    // when
    const key = formatModelKey(ref)

    // then
    expect(key).toBe("zhipuai/glm-4.7")
  })

  test("#given an incomplete ref #when formatting #then it returns undefined", () => {
    // given / when / then
    expect(formatModelKey(undefined)).toBeUndefined()
    expect(formatModelKey({ id: "", providerID: "zhipuai" })).toBeUndefined()
  })
})
