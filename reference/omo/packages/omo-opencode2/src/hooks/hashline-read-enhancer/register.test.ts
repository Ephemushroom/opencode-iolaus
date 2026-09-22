/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test"
import { applyHashlineTagsToResult } from "./register"

interface TextPart {
  type: "text"
  text: string
}

describe("applyHashlineTagsToResult", () => {
  describe("#given a read result whose content is a plain string", () => {
    it("#when applying tags #then returns a string result with LINE#ID tags", () => {
      // given
      const result = { content: "1: const x = 1\n2: const y = 2" }

      // when
      const next = applyHashlineTagsToResult(result)

      // then
      expect(typeof next.content).toBe("string")
      const lines = (next.content as string).split("\n")
      expect(lines[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}\|const x = 1$/)
      expect(lines[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}\|const y = 2$/)
    })
  })

  describe("#given a read result whose content arrives as an array of content parts (R12)", () => {
    it("#when applying tags #then tags the text parts and leaves non-text parts untouched", () => {
      // given
      const result = {
        content: [
          { type: "text", text: "1: const x = 1\n2: const y = 2" },
          { type: "file", uri: "file:///tmp/demo.ts" },
        ],
      }

      // when
      const next = applyHashlineTagsToResult(result)

      // then
      expect(Array.isArray(next.content)).toBe(true)
      const parts = next.content as Array<Record<string, unknown>>
      const first = parts[0] as unknown as TextPart
      const firstLines = first.text.split("\n")
      expect(firstLines[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}\|const x = 1$/)
      expect(firstLines[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}\|const y = 2$/)
      expect(parts[1]).toEqual({ type: "file", uri: "file:///tmp/demo.ts" })
    })
  })

  describe("#given a result already tagged by a prior execute.after pass", () => {
    it("#when applying tags again #then the content is unchanged (idempotent)", () => {
      // given
      const result = { content: "1: const x = 1\n2: const y = 2" }

      // when
      const once = applyHashlineTagsToResult(result)
      const twice = applyHashlineTagsToResult(once)

      // then
      expect(twice.content).toEqual(once.content)
    })
  })

  describe("#given an array-shaped result already tagged", () => {
    it("#when applying tags again #then array text parts stay identical (idempotent)", () => {
      // given
      const result = {
        content: [{ type: "text", text: "1: alpha\n2: beta" }],
      }

      // when
      const once = applyHashlineTagsToResult(result)
      const twice = applyHashlineTagsToResult(once)

      // then
      expect(twice.content).toEqual(once.content)
    })
  })
})
