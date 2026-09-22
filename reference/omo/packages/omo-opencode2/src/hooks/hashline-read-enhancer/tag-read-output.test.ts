/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test"
import { tagReadOutput } from "./tag-read-output"

describe("tagReadOutput", () => {
  describe("#given a read result wrapped in a <content> block", () => {
    it("#when tagging #then rewrites each file line as LINE#ID|content", () => {
      // given
      const output = [
        "<path>/tmp/demo.ts</path>",
        "<type>file</type>",
        "<content>",
        "1: const x = 1",
        "2: const y = 2",
        "",
        "(End of file - total 2 lines)",
        "</content>",
      ].join("\n")

      // when
      const tagged = tagReadOutput(output)

      // then
      const lines = tagged.split("\n")
      expect(lines[3]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}\|const x = 1$/)
      expect(lines[4]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}\|const y = 2$/)
      expect(lines[0]).toBe("<path>/tmp/demo.ts</path>")
      expect(lines[7]).toBe("</content>")
    })
  })

  describe("#given the v2 read tool output that leads with a header line", () => {
    it("#when tagging #then preserves the header and tags the numbered lines", () => {
      // given the exact shape opencode2 delivers (captured in QA export-c3.json)
      const output = [
        "Read file greeter.ts, lines 1-3",
        "1: export function greet(name: string): string {",
        '2:   return "hello " + name',
        "3: }",
      ].join("\n")

      // when
      const tagged = tagReadOutput(output)

      // then
      const lines = tagged.split("\n")
      expect(lines[0]).toBe("Read file greeter.ts, lines 1-3")
      expect(lines[1]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}\|export function greet\(name: string\): string \{$/)
      expect(lines[2]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}\| {2}return "hello " \+ name$/)
      expect(lines[3]).toMatch(/^3#[ZPMQVRWSNKTXJBYH]{2}\|\}$/)
    })
  })

  describe("#given plain numbered read output without content tags", () => {
    it("#when tagging #then tags every numbered line", () => {
      // given
      const output = ["1: # Title", "2:", "3: body", "", "(End of file - total 3 lines)"].join("\n")

      // when
      const tagged = tagReadOutput(output)

      // then
      const lines = tagged.split("\n")
      expect(lines[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}\|# Title$/)
      expect(lines[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}\|$/)
      expect(lines[2]).toMatch(/^3#[ZPMQVRWSNKTXJBYH]{2}\|body$/)
      expect(lines[4]).toBe("(End of file - total 3 lines)")
    })
  })

  describe("#given output that is already tagged", () => {
    it("#when tagging repeatedly #then the result is idempotent (no double tagging)", () => {
      // given
      const output = ["1: const x = 1", "2: const y = 2"].join("\n")

      // when
      const once = tagReadOutput(output)
      const twice = tagReadOutput(once)

      // then
      expect(twice).toBe(once)
      const lines = twice.split("\n")
      expect(lines[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}\|const x = 1$/)
      expect(lines[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}\|const y = 2$/)
    })
  })

  describe("#given a read result of a non-numbered payload", () => {
    it("#when tagging #then leaves it unchanged", () => {
      // given
      const output = "binary content, not a text read"

      // when
      const tagged = tagReadOutput(output)

      // then
      expect(tagged).toBe(output)
    })
  })
})
