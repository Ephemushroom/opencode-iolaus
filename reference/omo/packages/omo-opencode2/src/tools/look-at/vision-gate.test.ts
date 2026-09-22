import { describe, expect, test } from "bun:test"

import type { CatalogSnapshot } from "../../agents/model-resolution"
import { resolveLookAtRoute, selectVisionModel } from "./vision-gate"

function snapshot(input: { available?: string[]; vision?: string[] }): CatalogSnapshot {
  return {
    availableModels: new Set(input.available ?? []),
    connectedProviders: [],
    visionModels: new Set(input.vision ?? []),
  }
}

describe("selectVisionModel", () => {
  test("#given a catalog with no vision models #when selecting #then it returns undefined", () => {
    // given
    const snap = snapshot({ available: ["zhipuai/glm-4.7"] })

    // when
    const selected = selectVisionModel(snap)

    // then
    expect(selected).toBeUndefined()
  })

  test("#given a fallback-chain model is vision capable #when selecting #then it prefers the chain entry", () => {
    // given a chain entry (openai/gpt-5.6-sol) alongside an unrelated vision model
    const snap = snapshot({
      available: ["openai/gpt-5.6-sol", "acme/seer"],
      vision: ["acme/seer", "openai/gpt-5.6-sol"],
    })

    // when
    const selected = selectVisionModel(snap)

    // then
    expect(selected).toBe("openai/gpt-5.6-sol")
  })

  test("#given only an off-chain vision model #when selecting #then it falls back to that model", () => {
    // given
    const snap = snapshot({ available: ["acme/seer"], vision: ["acme/seer"] })

    // when
    const selected = selectVisionModel(snap)

    // then
    expect(selected).toBe("acme/seer")
  })

  test("#given the caller's provider has a vision model #when selecting #then it beats the chain entry", () => {
    // given a chain entry from a provider the caller has no credentials for,
    // alongside a vision model on the caller's own (authenticated) provider
    const snap = snapshot({
      available: ["zhipuai/glm-4.7", "zhipuai/glm-5v-turbo", "openai/gpt-5.6-sol"],
      vision: ["zhipuai/glm-5v-turbo", "openai/gpt-5.6-sol"],
    })

    // when
    const selected = selectVisionModel(snap, "zhipuai")

    // then
    expect(selected).toBe("zhipuai/glm-5v-turbo")
  })

  test("#given the caller's provider has no vision model #when selecting #then it falls back to the chain", () => {
    // given
    const snap = snapshot({
      available: ["zhipuai/glm-4.7", "openai/gpt-5.6-sol"],
      vision: ["openai/gpt-5.6-sol"],
    })

    // when
    const selected = selectVisionModel(snap, "zhipuai")

    // then
    expect(selected).toBe("openai/gpt-5.6-sol")
  })
})

describe("resolveLookAtRoute", () => {
  test("#given the caller model accepts images #when routing #then it passes through without delegating", () => {
    // given
    const snap = snapshot({ available: ["acme/seer"], vision: ["acme/seer"] })

    // when
    const route = resolveLookAtRoute({ sessionModel: "acme/seer", snapshot: snap })

    // then
    expect(route.kind).toBe("passthrough")
    expect(route.kind === "passthrough" && route.model).toBe("acme/seer")
  })

  test("#given a blind caller and an available vision model #when routing #then it delegates", () => {
    // given
    const snap = snapshot({ available: ["zhipuai/glm-4.7", "acme/seer"], vision: ["acme/seer"] })

    // when
    const route = resolveLookAtRoute({ sessionModel: "zhipuai/glm-4.7", snapshot: snap })

    // then
    expect(route.kind).toBe("delegate")
    expect(route.kind === "delegate" && route.visionModel).toBe("acme/seer")
  })

  test("#given an unknown caller model #when routing #then it delegates rather than assuming sight", () => {
    // given a warm catalog but no recorded model for the session
    const snap = snapshot({ available: ["zhipuai/glm-4.7", "acme/seer"], vision: ["acme/seer"] })

    // when
    const route = resolveLookAtRoute({ sessionModel: undefined, snapshot: snap })

    // then
    expect(route.kind).toBe("delegate")
  })

  test("#given a warm catalog with no vision model #when routing #then it reports no vision model", () => {
    // given
    const snap = snapshot({ available: ["zhipuai/glm-4.7"] })

    // when
    const route = resolveLookAtRoute({ sessionModel: "zhipuai/glm-4.7", snapshot: snap })

    // then
    expect(route.kind).toBe("unavailable")
    expect(route.kind === "unavailable" && route.reason).toBe("no-vision-model")
  })

  test("#given a catalog that has not loaded #when routing #then it reports the cold catalog distinctly", () => {
    // given
    const snap = snapshot({})

    // when
    const route = resolveLookAtRoute({ sessionModel: undefined, snapshot: snap })

    // then
    expect(route.kind).toBe("unavailable")
    expect(route.kind === "unavailable" && route.reason).toBe("catalog-cold")
  })
})
