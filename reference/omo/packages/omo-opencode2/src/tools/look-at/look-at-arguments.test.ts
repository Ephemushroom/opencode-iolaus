import { describe, expect, test } from "bun:test"

import { parseLookAtArgs } from "./look-at-arguments"

describe("parseLookAtArgs", () => {
  test("#given a singular file_path and a goal #when parsing #then it promotes the path to a list", () => {
    // given
    const raw = { file_path: "/tmp/diagram.png", goal: "read the box labels" }

    // when
    const result = parseLookAtArgs(raw)

    // then
    expect(result.ok).toBe(true)
    expect(result.ok && result.args.filePaths).toEqual(["/tmp/diagram.png"])
    expect(result.ok && result.args.goal).toBe("read the box labels")
  })

  test("#given the legacy path alias #when parsing #then it is accepted", () => {
    // given
    const raw = { path: "/tmp/a.png", goal: "describe" }

    // when
    const result = parseLookAtArgs(raw)

    // then
    expect(result.ok && result.args.filePaths).toEqual(["/tmp/a.png"])
  })

  test("#given several paths across both fields #when parsing #then all are collected", () => {
    // given
    const raw = { file_path: "/tmp/a.png", file_paths: ["/tmp/b.png", "/tmp/c.pdf"], goal: "compare" }

    // when
    const result = parseLookAtArgs(raw)

    // then
    expect(result.ok && result.args.filePaths).toEqual(["/tmp/a.png", "/tmp/b.png", "/tmp/c.pdf"])
  })

  test("#given no path at all #when parsing #then it rejects with a path error", () => {
    // given
    const raw = { goal: "describe" }

    // when
    const result = parseLookAtArgs(raw)

    // then
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("file_path")
  })

  test("#given a blank goal #when parsing #then it rejects with a goal error", () => {
    // given
    const raw = { file_path: "/tmp/a.png", goal: "   " }

    // when
    const result = parseLookAtArgs(raw)

    // then
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("goal")
  })

  test("#given a remote URL #when parsing #then it is rejected as unsupported", () => {
    // given
    const raw = { file_path: "https://example.com/a.png", goal: "describe" }

    // when
    const result = parseLookAtArgs(raw)

    // then
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("Remote URLs")
  })

  test("#given a non-object input #when parsing #then it rejects instead of throwing", () => {
    // given
    const raw = "not an object"

    // when
    const result = parseLookAtArgs(raw)

    // then
    expect(result.ok).toBe(false)
  })
})
