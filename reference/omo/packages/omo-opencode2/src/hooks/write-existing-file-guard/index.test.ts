import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"

import { registerWriteExistingFileGuard } from "./index"

describe("write-existing-file-guard hook", () => {
  let tempDir: string
  let mockCtx: any
  let beforeHook: (event: any) => Effect.Effect<void, unknown, never>
  let publishEvent: (event: any) => void

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "omo-test-guard-"))
    
    const listeners: ((event: any) => void)[] = []
    publishEvent = (event) => listeners.forEach(l => l(event))
    const eventIterable = {
      async *[Symbol.asyncIterator]() {
      },
      subscribe: () => {
        let resolveNext: any
        const nextPromise = () => new Promise(r => { resolveNext = r })
        let currentPromise = nextPromise()
        listeners.push((ev) => {
          resolveNext({ value: ev, done: false })
          currentPromise = nextPromise()
        })
        return {
          async next() { return await currentPromise },
          [Symbol.asyncIterator]() { return this }
        }
      }
    }

    mockCtx = {
      tool: {
        hook: (name: string, handler: any) => {
          if (name === "execute.before") {
            beforeHook = handler
          }
          return Effect.succeed({ dispose: Effect.void })
        }
      },
       event: { subscribe: () => Stream.fromAsyncIterable(eventIterable, (error) => error) }
    }

    await Effect.runPromise(Effect.scoped(registerWriteExistingFileGuard(mockCtx, undefined, tempDir)))
  })

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("#when tool is 'read' and file exists, #then marks permission and allows subsequent write", async () => {
    const file = join(tempDir, "test.txt")
    writeFileSync(file, "hello")

    // Read
    await Effect.runPromise(beforeHook({
      tool: "read",
      sessionID: "sess-1",
      input: { filePath: file }
    }))

    // Write - should not throw
    await expect(Effect.runPromise(beforeHook({
      tool: "write",
      sessionID: "sess-1",
      input: { filePath: file }
    }))).resolves.toBeUndefined()
  })

  test("#when tool is 'write' on existing file without read, #then blocks", async () => {
    const file = join(tempDir, "test.txt")
    writeFileSync(file, "hello")

    await expect(Effect.runPromise(beforeHook({
      tool: "write",
      sessionID: "sess-1",
      input: { filePath: file }
    }))).rejects.toThrow("File already exists")
  })

  test("#when tool is 'write' with overwrite flag, #then allows", async () => {
    const file = join(tempDir, "test.txt")
    writeFileSync(file, "hello")

    const event = {
      tool: "write",
      sessionID: "sess-1",
      input: { filePath: file, overwrite: true }
    }

    await expect(Effect.runPromise(beforeHook(event))).resolves.toBeUndefined()
    expect("overwrite" in event.input).toBe(false)
  })

  test("#when file is inside .omo workspace, #then allows existing write", async () => {
    const omoDir = join(tempDir, ".omo")
    mkdirSync(omoDir)
    const file = join(omoDir, "plan.md")
    writeFileSync(file, "hello")

    await expect(Effect.runPromise(beforeHook({
      tool: "write",
      sessionID: "sess-1",
      input: { filePath: file }
    }))).resolves.toBeUndefined()
  })
})
