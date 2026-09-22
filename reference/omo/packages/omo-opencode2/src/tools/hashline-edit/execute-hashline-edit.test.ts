/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { computeLineHash } from "@oh-my-opencode/hashline-core"
import { executeHashlineEdit } from "./execute-hashline-edit"

function tempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc2-hashline-"))
  const file = path.join(dir, "demo.ts")
  fs.writeFileSync(file, content)
  return file
}

function ref(lineNumber: number, content: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}`
}

describe("executeHashlineEdit", () => {
  describe("#given a valid line hash matching current content", () => {
    it("#when replacing that line #then the file is modified on disk", async () => {
      // given
      const original = "const x = 1\nconst y = 2\n"
      const file = tempFile(original)

      // when
      const result = await executeHashlineEdit({
        filePath: file,
        edits: [{ op: "replace", pos: ref(1, "const x = 1"), lines: "const x = 42" }],
      })

      // then
      expect(result.rejected).toBe(false)
      const after = fs.readFileSync(file, "utf8")
      expect(after).toContain("const x = 42")
      expect(after).toContain("const y = 2")
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    })
  })

  describe("#given a stale hash that no longer matches current content", () => {
    it("#when editing #then the edit is rejected AND the file is byte-identical", async () => {
      // given
      const original = "const x = 1\nconst y = 2\n"
      const file = tempFile(original)
      const staleRef = "1#ZZ"

      // when
      const result = await executeHashlineEdit({
        filePath: file,
        edits: [{ op: "replace", pos: staleRef, lines: "const x = 999" }],
      })

      // then
      expect(result.rejected).toBe(true)
      expect(result.message.toLowerCase()).toContain("re-read")
      const after = fs.readFileSync(file, "utf8")
      expect(after).toBe(original)
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    })
  })

  describe("#given a line hash pointing at content that changed after the read", () => {
    it("#when editing with the old hash #then rejected and file unchanged", async () => {
      // given
      const readContent = "alpha\nbeta\n"
      const file = tempFile(readContent)
      const oldRef = ref(1, "alpha")
      const changed = "ALPHA-CHANGED\nbeta\n"
      fs.writeFileSync(file, changed)

      // when
      const result = await executeHashlineEdit({
        filePath: file,
        edits: [{ op: "replace", pos: oldRef, lines: "gamma" }],
      })

      // then
      expect(result.rejected).toBe(true)
      const after = fs.readFileSync(file, "utf8")
      expect(after).toBe(changed)
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    })
  })

  describe("#given a missing file with an anchored edit", () => {
    it("#when editing #then rejected fail-closed and nothing is written", async () => {
      // given
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc2-hashline-missing-"))
      const file = path.join(dir, "nope.ts")

      // when
      const result = await executeHashlineEdit({
        filePath: file,
        edits: [{ op: "replace", pos: "1#ZZ", lines: "x" }],
      })

      // then
      expect(result.rejected).toBe(true)
      expect(fs.existsSync(file)).toBe(false)
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })
})
