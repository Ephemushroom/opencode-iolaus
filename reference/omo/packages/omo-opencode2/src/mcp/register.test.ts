import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { registerBuiltinMcps } from "./register"
import type { Context } from "@opencode/plugin/promise/plugin"

type DraftServer = [string, Record<string, unknown>]

function createContextWith(initial: DraftServer[]): {
  ctx: Context
  servers: () => DraftServer[]
  set: (callback: (draft: { list(): DraftServer[]; set(name: string, config: unknown): void }) => void | Promise<void>) => Promise<unknown>
} {
  let servers: DraftServer[] = [...initial]
  const registrations: unknown[] = []
  const ctx = {
    mcp: {
      transform: (callback: (draft: { list(): DraftServer[]; set(name: string, config: unknown): void }) => void | Promise<void>) => {
        const registration = Promise.resolve(
          callback({
            list: () => servers,
            set: (name, config) => {
              servers = [...servers, [name, config as Record<string, unknown>]]
            },
          }),
        )
        registrations.push(registration)
        return registration
      },
      list: () => Promise.resolve({ location: {}, data: servers.map(([name]) => ({ name, status: { status: "pending" } })) }),
      reload: () => Promise.resolve(),
    },
    options: {},
  }
  return { ctx: ctx as unknown as Context, servers: () => servers, set: async (cb) => Promise.all(registrations.push(Promise.resolve(cb)) as never) }
}

function writeOmoConfig(dir: string, config: Record<string, unknown>): void {
  const fs = require("node:fs") as typeof import("node:fs")
  fs.mkdirSync(`${dir}/.omo`, { recursive: true })
  fs.writeFileSync(`${dir}/.omo/opencode2.json`, JSON.stringify(config))
}

describe("registerBuiltinMcps", () => {
  test("#given an empty MCP catalog #when registering built-ins #then only remote servers and LSP are added", async () => {
    // given
    const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "oc2-mcp-"))
    const { ctx, servers } = createContextWith([])
    // when
    const result = await registerBuiltinMcps(ctx, { cwd: dir, env: {} })
    // then
    expect(result.registered).toEqual(["context7", "grep_app", "lsp"])
    expect(servers().map(([name]) => name)).toEqual(["context7", "grep_app", "lsp"])
  })

  test("never overwrites a user-defined server", async () => {
    const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "oc2-mcp-"))
    const userConfig = { type: "remote", url: "https://user.example/mcp" }
    const { ctx } = createContextWith([["context7", userConfig]])
    const result = await registerBuiltinMcps(ctx, { cwd: dir, env: {} })
    expect(result.registered).not.toContain("context7")
  })

  test("#given explicit user MCPs #when registering built-ins #then CodeGraph and remaining built-in overrides are preserved", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "oc2-mcp-"))
    const initial: DraftServer[] = [
      ["codegraph", { type: "local", command: ["user-codegraph", "serve"] }],
      ["context7", { type: "remote", url: "https://user.example/context7" }],
      ["grep_app", { type: "remote", url: "https://user.example/grep" }],
      ["lsp", { type: "local", command: ["user-lsp"] }],
      ["custom", { type: "remote", url: "https://user.example/custom" }],
    ]
    const { ctx, servers } = createContextWith(initial)

    try {
      // when
      const result = await registerBuiltinMcps(ctx, { cwd: dir, env: {} })

      // then
      expect(result.registered).toEqual([])
      expect(servers()).toEqual(initial)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("#given stale CodeGraph settings #when registering #then disabled_mcps still removes selected built-ins", async () => {
    // given
    const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "oc2-mcp-"))
    writeOmoConfig(dir, { "[opencode2]": { codegraph: { daemon: "obsolete" }, disabled_mcps: ["context7", "grep_app"] } })
    const { ctx } = createContextWith([])
    // when
    const result = await registerBuiltinMcps(ctx, { cwd: dir, env: {} })
    // then
    expect(result.registered).toEqual(["lsp"])
  })
})
