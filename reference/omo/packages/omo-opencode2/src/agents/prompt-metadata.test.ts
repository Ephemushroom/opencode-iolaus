import { describe, expect, test } from "bun:test"

import { SISYPHUS_SPECIALIST_IDS, SISYPHUS_SPECIALIST_METADATA } from "./prompt-metadata"

/**
 * The Sisyphus dynamic-prompt metadata table must contain exactly the six
 * delegable specialists (the agents whose metadata the v1 adapter exposed in
 * Sisyphus's Delegation Table / Tool Selection). Primaries (sisyphus,
 * hephaestus, prometheus, atlas), the executor (sisyphus-junior), built-ins,
 * and categories must NOT be in the table — categories are derived from
 * CATEGORY_MODEL_REQUIREMENTS separately.
 */
describe("Sisyphus specialist metadata table", () => {
  test("#given the specialist table #when enumerated #then it contains exactly the six delegable specialists", () => {
    // then
    expect([...SISYPHUS_SPECIALIST_IDS].toSorted()).toEqual(
      ["explore", "librarian", "metis", "momus", "multimodal-looker", "oracle"].toSorted(),
    )
  })

  test("#given the specialist table #when indexed by id #then every entry carries the four prompt-section fields", () => {
    // when
    for (const id of SISYPHUS_SPECIALIST_IDS) {
      const metadata = SISYPHUS_SPECIALIST_METADATA[id]

      // then
      expect(metadata, `metadata for ${id}`).toBeDefined()
      expect(metadata.category, `${id}.category`).toBeDefined()
      expect(metadata.cost, `${id}.cost`).toBeDefined()
      expect(metadata.triggers, `${id}.triggers`).toBeDefined()
      expect(metadata.promptAlias, `${id}.promptAlias`).toBeDefined()
    }
  })

  test("#given the specialist table #when a primary or category id is looked up #then it is absent", () => {
    // when
    const forbidden = ["sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior", "deep", "quick"]

    // then
    for (const id of forbidden) {
      expect(SISYPHUS_SPECIALIST_METADATA[id as keyof typeof SISYPHUS_SPECIALIST_METADATA], id).toBeUndefined()
    }
  })
})
