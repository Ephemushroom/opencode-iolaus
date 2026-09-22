import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { LocalMcpServerConfig } from "./types"
import { hasCliSuffix } from "./cli-suffix"

const PACKAGE_REL = "packages/lsp-daemon"
const LSP_TOOLS_PACKAGE_REL = "packages/lsp-tools-mcp"
const DIST_CLI_REL = "dist/cli.js"
const SOURCE_CLI_REL = "src/cli.ts"
const PROJECT_LSP_CONFIGS = [".opencode/lsp.json", ".omo/lsp.json", ".omo/lsp-client.json"] as const
const DAEMON_PACKAGE_NAME = "@code-yeongyu/lsp-daemon"
const OMO_LSP_DAEMON_CLI = "OMO_LSP_DAEMON_CLI"
const OMO_LSP_DAEMON_VERSION = "OMO_LSP_DAEMON_VERSION"

const LSP_BOOTSTRAP_SCRIPT = [
  "const { existsSync } = require('node:fs')",
  "const { createRequire } = require('node:module')",
  "const { join } = require('node:path')",
  "const { spawnSync } = require('node:child_process')",
  "const root = process.argv[1]",
  "const npm = process.argv[2] || 'npm'",
  "const bun = process.argv[3] || 'bun'",
  `const toolsPackage = join(root, '${LSP_TOOLS_PACKAGE_REL}')`,
  `const daemonPackage = join(root, '${PACKAGE_REL}')`,
  "const toolsDist = join(toolsPackage, 'dist/cli.js')",
  "const daemonPackageJson = join(daemonPackage, 'package.json')",
  "const daemonSource = join(daemonPackage, 'src/cli.ts')",
  "const run = (command, args, stdio) => spawnSync(command, args, { cwd: root, env: process.env, stdio })",
  "const finish = (result) => { if (result.error) { console.error(result.error.message); process.exit(1) } process.exit(result.status ?? 1) }",
  "const runIfAvailable = (command, args) => { const result = run(command, args, 'inherit'); if (result.error) return false; finish(result); return true }",
  `const resolveDaemonCli = () => { try { return createRequire(daemonPackageJson).resolve('${DAEMON_PACKAGE_NAME}/cli') } catch (error) { if (error instanceof Error) return null; throw error } }`,
  "const daemonCli = existsSync(daemonPackageJson) ? resolveDaemonCli() : null",
  "if (daemonCli) finish(run(process.execPath, [daemonCli, 'mcp'], 'inherit'))",
  `if (existsSync(daemonSource) && existsSync(toolsDist)) { const pkg = require(daemonPackageJson); process.env.${OMO_LSP_DAEMON_CLI} = daemonSource; process.env.${OMO_LSP_DAEMON_VERSION} = pkg.version; runIfAvailable(bun, [daemonSource, 'mcp']) }`,
  "const steps = [[npm, ['--prefix', toolsPackage, 'install', '--no-package-lock', '--no-audit', '--no-fund']], [npm, ['--prefix', toolsPackage, 'run', 'build']], [npm, ['--prefix', daemonPackage, 'install', '--no-package-lock', '--no-audit', '--no-fund']], [npm, ['--prefix', daemonPackage, 'run', 'build']]]",
  "for (const [command, args] of steps) { const result = run(command, args, ['ignore', 'ignore', 'inherit']); if (result.error || result.status !== 0) finish(result) }",
  "finish(run(process.execPath, [resolveDaemonCli(), 'mcp'], 'inherit'))",
].join(";")

export type LspMcpConfigOptions = {
  readonly cwd?: string
  readonly moduleUrl?: string
  readonly exists?: (path: string) => boolean
  readonly configDir?: string
}

type ResolvedLspCommand = {
  readonly command: readonly string[]
  readonly root: string
  readonly path: string
  readonly exists: boolean
  readonly runtimeAvailable: boolean
}

function getModuleDirectory(moduleUrl: string): string | null {
  try {
    return dirname(fileURLToPath(moduleUrl))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return null
  }
}

function readDaemonPackageVersion(root: string): string | null {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(root, PACKAGE_REL, "package.json"), "utf-8")) as {
      version?: unknown
    }
    return typeof packageJson.version === "string" && packageJson.version.length > 0 ? packageJson.version : null
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return null
  }
}

/** $XDG_CONFIG_HOME/opencode (v2 layout); HOME fallback mirrors v1 behavior. */
export function resolveLspUserConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && xdg.length > 0) return join(xdg, "opencode")
  return join(homedir(), ".config", "opencode")
}

function ancestorDirectories(start: string): string[] {
  const directories: string[] = []
  let current = resolve(start)
  while (true) {
    directories.push(current)
    const parent = dirname(current)
    if (parent === current) return directories
    current = parent
  }
}

function findNodeRuntime(): { command: string; available: boolean } {
  const execPath = process.execPath
  const base = execPath.replaceAll("\\", "/").split("/").pop() ?? ""
  if (base.toLowerCase() === "node.exe" || base.toLowerCase() === "node") {
    return { command: execPath, available: true }
  }
  return { command: "node", available: true }
}

function buildCandidates(
  directories: readonly string[],
  pathExists: (path: string) => boolean,
): ResolvedLspCommand[] {
  const runtime = findNodeRuntime()
  const bun = { command: "bun", available: true }
  const candidates: ResolvedLspCommand[] = []
  const seen = new Set<string>()

  for (const root of directories) {
    const distCliPath = resolve(root, PACKAGE_REL, DIST_CLI_REL)
    if (!seen.has(distCliPath)) {
      seen.add(distCliPath)
      candidates.push({
        command: [runtime.command, distCliPath, "mcp"],
        root,
        path: distCliPath,
        exists: runtime.available && pathExists(distCliPath),
        runtimeAvailable: runtime.available,
      })
    }

    const sourceCliPath = resolve(root, PACKAGE_REL, SOURCE_CLI_REL)
    if (!seen.has(sourceCliPath)) {
      seen.add(sourceCliPath)
      // v1 parity: the bun source candidate additionally requires the daemon
      // package.json to be readable (its version feeds OMO_LSP_DAEMON_VERSION).
      const toolsDistExists = pathExists(resolve(root, LSP_TOOLS_PACKAGE_REL, DIST_CLI_REL))
      const daemonVersionReadable = readDaemonPackageVersion(root) !== null
      candidates.push({
        command: [bun.command, sourceCliPath, "mcp"],
        root,
        path: sourceCliPath,
        exists: bun.available && pathExists(sourceCliPath) && toolsDistExists && daemonVersionReadable,
        runtimeAvailable: bun.available,
      })
    }
  }

  return candidates
}

function resolveLspCommand(options: LspMcpConfigOptions): ResolvedLspCommand {
  const pathExists = options.exists ?? existsSync
  const moduleDirectory = getModuleDirectory(options.moduleUrl ?? import.meta.url)
  const directories = moduleDirectory ? ancestorDirectories(moduleDirectory) : [process.cwd()]

  const candidates = buildCandidates(directories, pathExists)
  const distCandidate = candidates.find((candidate) => hasCliSuffix(candidate.path, DIST_CLI_REL) && candidate.exists)
  if (distCandidate) return distCandidate

  const sourceCandidate = candidates.find(
    (candidate) => hasCliSuffix(candidate.path, SOURCE_CLI_REL) && candidate.exists,
  )
  if (sourceCandidate) return sourceCandidate

  // Bootstrap fallback: a self-building script run with the current runtime.
  // It installs + builds the vendored packages on first use, then execs the
  // daemon. Root defaults to the nearest candidate that looks like the repo.
  const root = candidates.find((candidate) => pathExists(resolve(candidate.root, "package.json")))?.root ?? process.cwd()
  return {
    command: [findNodeRuntime().command, "-e", LSP_BOOTSTRAP_SCRIPT, root, "npm", "bun"],
    root,
    path: resolve(root, PACKAGE_REL, DIST_CLI_REL),
    exists: findNodeRuntime().available,
    runtimeAvailable: findNodeRuntime().available,
  }
}

/**
 * Local stdio MCP config for the vendored lsp-daemon. Resolution order:
 * dist CLI -> source CLI (bun, when lsp-tools-mcp dist exists) -> bootstrap
 * script (self-builds). Mirrors v1's mcp/lsp.ts.
 */
export function createLspMcpConfig(options: LspMcpConfigOptions = {}): LocalMcpServerConfig {
  const resolved = resolveLspCommand(options)
  const cwd = resolve(options.cwd ?? process.cwd())
  const configDir = options.configDir ?? resolveLspUserConfigDir()
  const sourceVersion = hasCliSuffix(resolved.path, SOURCE_CLI_REL) ? readDaemonPackageVersion(resolved.root) : null

  return {
    type: "local",
    command: resolved.command,
    cwd,
    environment: {
      LSP_TOOLS_MCP_PROJECT_CONFIG: PROJECT_LSP_CONFIGS.map((configPath) => resolve(cwd, configPath)).join(delimiter),
      LSP_TOOLS_MCP_USER_CONFIG: resolve(configDir, "lsp.json"),
      LSP_TOOLS_MCP_INSTALL_DECISIONS: resolve(configDir, "lsp-install-decisions.json"),
      ...(sourceVersion
        ? {
            [OMO_LSP_DAEMON_CLI]: resolved.path,
            [OMO_LSP_DAEMON_VERSION]: sourceVersion,
          }
        : {}),
    },
  }
}
