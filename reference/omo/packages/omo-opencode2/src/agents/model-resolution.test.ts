import { describe, expect, test } from "bun:test"

import { createCatalogSource } from "./model-resolution"
import type { CatalogSource } from "./model-resolution"

type ProviderRecord = {
  provider: { id: string }
  models: Map<string, { capabilities?: { input?: string[] } }>
}

function capture(providerRecords: ProviderRecord[]): CatalogSource {
  const catalog = createCatalogSource()
  catalog.capture({
    provider: { list: () => providerRecords, get: () => undefined, update: () => {}, remove: () => {} },
    model: {
      get: () => undefined,
      update: () => {},
      remove: () => {},
      default: { get: () => undefined, set: () => {} },
    },
  } as unknown as Parameters<CatalogSource["capture"]>[0])
  return catalog
}

describe("captureCatalogDraft vision capture", () => {
  test("#given models with and without image input #when capturing #then only image models are vision capable", () => {
    // given
    const catalog = capture([
      {
        provider: { id: "acme" },
        models: new Map([
          ["seer", { capabilities: { input: ["text", "image"] } }],
          ["blind", { capabilities: { input: ["text"] } }],
        ]),
      },
    ])

    // when
    const snapshot = catalog.current

    // then
    expect(snapshot.availableModels).toEqual(new Set(["acme/seer", "acme/blind"]))
    expect(snapshot.visionModels).toEqual(new Set(["acme/seer"]))
  })

  test("#given a catalog entry with no capability block #when capturing #then it is not vision capable", () => {
    // given
    const catalog = capture([{ provider: { id: "acme" }, models: new Map([["mystery", {}]]) }])

    // when
    const snapshot = catalog.current

    // then
    expect(snapshot.availableModels.has("acme/mystery")).toBe(true)
    expect(snapshot.visionModels.size).toBe(0)
  })

  test("#given no providers #when capturing #then the vision set is empty", () => {
    // given
    const catalog = capture([])

    // when
    const snapshot = catalog.current

    // then
    expect(snapshot.visionModels.size).toBe(0)
    expect(snapshot.availableModels.size).toBe(0)
  })
})
