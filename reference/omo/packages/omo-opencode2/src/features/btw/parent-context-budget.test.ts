import { describe, expect, test } from "bun:test"

import {
  BTW_PARENT_CONTEXT_MAX_BYTES,
  BTW_PARENT_CONTEXT_MAX_MESSAGES,
  boundParentTranscript,
  renderParentTranscript,
  type TranscriptEntry,
} from "./parent-context-budget"

const encoder = new TextEncoder()

function bytesOf(entries: readonly TranscriptEntry[]): number {
  return encoder.encode(JSON.stringify(entries)).byteLength
}

function makeEntries(count: number, textPer = "x".repeat(200)): TranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `${textPer} #${index}`,
  }))
}

describe("boundParentTranscript", () => {
  test("passes a small transcript through unchanged", () => {
    const entries = makeEntries(4)
    expect(boundParentTranscript(entries)).toEqual(entries)
  })

  test("keeps only the newest entries over the message budget", () => {
    const entries = makeEntries(BTW_PARENT_CONTEXT_MAX_MESSAGES + 10)
    const bounded = boundParentTranscript(entries)
    expect(bounded.length).toBe(BTW_PARENT_CONTEXT_MAX_MESSAGES)
    const lastOriginal = entries[entries.length - 1]
    expect(bounded[bounded.length - 1]).toEqual(lastOriginal)
  })

  test("drops old entries when the byte budget is exceeded", () => {
    // Each entry ~5KB; 64KB budget holds ~13 of them.
    const entries = makeEntries(40, "y".repeat(5 * 1024))
    const bounded = boundParentTranscript(entries)
    expect(bytesOf(bounded)).toBeLessThanOrEqual(BTW_PARENT_CONTEXT_MAX_BYTES)
    expect(bounded.length).toBeGreaterThan(0)
    // The newest entry survives.
    expect(bounded[bounded.length - 1]?.text).toContain("#39")
  })

  test("tail-truncates a single oversized entry instead of returning nothing", () => {
    const entries: TranscriptEntry[] = [
      { role: "user", text: "z".repeat(BTW_PARENT_CONTEXT_MAX_BYTES * 2) },
    ]
    const bounded = boundParentTranscript(entries)
    expect(bounded.length).toBe(1)
    expect(bytesOf(bounded)).toBeLessThanOrEqual(BTW_PARENT_CONTEXT_MAX_BYTES)
    expect(bounded[0]?.text).toContain("truncated")
  })
})

describe("renderParentTranscript", () => {
  test("renders roles and wraps in the read-only envelope", () => {
    const text = renderParentTranscript("ses_parent", [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ])
    expect(text).toContain('<omo-btw-parent-context session="ses_parent">')
    expect(text).toContain("User: hello")
    expect(text).toContain("Assistant: hi there")
    expect(text).toContain("</omo-btw-parent-context>")
    expect(text).toContain("Read-only background")
  })
})
