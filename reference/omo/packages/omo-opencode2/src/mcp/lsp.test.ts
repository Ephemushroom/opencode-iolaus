import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

import { createLspMcpConfig } from "./lsp"

function makeFakeRepo(withDist: boolean, withSource: boolean, withToolsDist: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "oc2-lsp-repo-"))
  if (withDist) {
    mkdirSync(join(root, "packages", "lsp-daemon", "dist"), { recursive: true })
    writeFileSync(join(root, "packages", "lsp-daemon", "dist", "cli.js"), "// dist")
  }
  if (withSource) {
    mkdirSync(join(root, "packages", "lsp-daemon", "src"), { recursive: true })
    writeFileSync(join(root, "packages", "lsp-daemon", "src", "cli.ts"), "// source")
    writeFileSync(join(root, "packages", "lsp-daemon", "package.json"), JSON.stringify({ version: "9.9.9" }))
  }
  if (withToolsDist) {
    mkdirSync(join(root, "packages", "lsp-tools-mcp", "dist"), { recursive: true })
    writeFileSync(join(root, "packages", "lsp-tools-mcp", "dist", "cli.js"), "// tools")
  }
  // The plugin module lives inside the repo; the resolver walks up from it.
  mkdirSync(join(root, "packages", "omo-opencode2", "src", "mcp"), { recursive: true })
  return root
}

function moduleUrlIn(root: string): string {
  return `file://${resolve(root, "packages", "omo-opencode2", "src", "mcp", "lsp.ts").replaceAll("\\", "/")}`
}

describe("createLspMcpConfig", () => {
  test("prefers the daemon dist CLI when it exists", () => {
    const root = makeFakeRepo(true, true, true)
    const config = createLspMcpConfig({ cwd: "/proj", moduleUrl: moduleUrlIn(root) })
    expect(config.type).toBe("local")
    expect(config.command[1]).toBe(resolve(root, "packages", "lsp-daemon", "dist", "cli.js"))
    expect(config.command[2]).toBe("mcp")
  })

  test("falls back to the bun source CLI when only source + tools dist exist", () => {
    const root = makeFakeRepo(false, true, true)
    const config = createLspMcpConfig({ cwd: "/proj", moduleUrl: moduleUrlIn(root) })
    expect(config.command[0]).toBe("bun")
    expect(config.command[1]).toBe(resolve(root, "packages", "lsp-daemon", "src", "cli.ts"))
    expect(config.environment?.OMO_LSP_DAEMON_CLI).toBe(resolve(root, "packages", "lsp-daemon", "src", "cli.ts"))
    expect(config.environment?.OMO_LSP_DAEMON_VERSION).toBe("9.9.9")
  })

  test("emits the bootstrap script when no artifact exists", () => {
    const root = makeFakeRepo(false, false, false)
    const config = createLspMcpConfig({ cwd: "/proj", moduleUrl: moduleUrlIn(root) })
    expect(config.command[1]).toBe("-e")
    expect(config.command[2]).toContain("lsp-daemon")
  })

  test("environment carries project and user config paths", () => {
    const root = makeFakeRepo(false, false, false)
    const config = createLspMcpConfig({
      cwd: "/proj",
      moduleUrl: moduleUrlIn(root),
      configDir: "/cfg/opencode",
    })
    const projectConfig = (config.environment?.LSP_TOOLS_MCP_PROJECT_CONFIG ?? "").replaceAll("\\", "/")
    expect(projectConfig).toContain(".opencode/lsp.json")
    expect(projectConfig).toContain(".omo/lsp.json")
    expect(projectConfig).toContain(".omo/lsp-client.json")
    expect(config.environment?.LSP_TOOLS_MCP_USER_CONFIG).toBe(resolve("/cfg/opencode", "lsp.json"))
    expect(config.environment?.LSP_TOOLS_MCP_INSTALL_DECISIONS).toBe(resolve("/cfg/opencode", "lsp-install-decisions.json"))
  })

  test("source candidate is rejected without a readable daemon package.json", () => {
    const root = makeFakeRepo(false, false, true)
    mkdirSync(join(root, "packages", "lsp-daemon", "src"), { recursive: true })
    writeFileSync(join(root, "packages", "lsp-daemon", "src", "cli.ts"), "// source only")
    const config = createLspMcpConfig({ cwd: "/proj", moduleUrl: moduleUrlIn(root) })
    expect(config.command[1]).toBe("-e")
  })
})
