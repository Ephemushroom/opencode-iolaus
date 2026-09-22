import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function createFixture(options) {
  const { sandbox, mode, repo, mockUrl } = options
  const root = join(sandbox, mode)
  const home = join(root, "home")
  const project = join(home, "project")
  const config = join(root, "config")
  mkdirSync(join(project, ".omo"), { recursive: true })
  mkdirSync(join(home, ".omo"), { recursive: true })
  mkdirSync(join(config, "opencode"), { recursive: true })
  const env = {
    PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: home, USERPROFILE: home, PWD: project,
    XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_TEST_HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PRINT_LOGS: "1", OMO_DISABLE_POSTHOG: "1", OMO_SEND_ANONYMOUS_TELEMETRY: "0",
    OPENAI_API_KEY: "fake-key", OMO_SPIKE_TRACE: join(root, "trace.ndjson"),
  }
  const pluginEntry = join(repo, "packages/omo-opencode2/src", ...(mode === "old-file" ? ["index.ts"] : []))
  const configPath = join(config, "opencode/opencode.json")
  writeFileSync(configPath, JSON.stringify({
    plugins: [options.installer ? join(pluginEntry, "index.ts") : pluginEntry], model: "openai/gpt-fake", update: "disable", share: "disabled",
    permissions: [{ action: "read", resource: "*", effect: "allow" }],
    mcp: { servers: {
      lsp: { type: "local", command: ["node", "-e", "process.exit(42)"], disabled: true },
      context7: { type: "remote", url: "http://127.0.0.1:1", disabled: true },
      grep_app: { type: "remote", url: "http://127.0.0.1:1", disabled: true },
    } },
    commands: { "qa-transport": { template: "$ARGUMENTS", description: "QA-only native command transport control" } },
    provider: { openai: { options: { apiKey: "fake-key", baseURL: `${mockUrl}/v1` },
      models: {
        "gpt-fake": { tool_call: true, limit: { context: 200000, output: 8192 } },
        "gpt-atlas": { tool_call: true, limit: { context: 200000, output: 8192 } },
        "gpt-explore": { tool_call: true, limit: { context: 200000, output: 8192 } },
        "gpt-quick": { tool_call: true, limit: { context: 200000, output: 8192 } },
      } } },
  }))
  const enabled = mode === "enabled"
  const omoConfigPath = join(home, ".omo/opencode2.json")
  writeFileSync(omoConfigPath, JSON.stringify({
    agents: { sisyphus: { model: "openai/gpt-fake" }, atlas: { model: "openai/gpt-atlas" },
      explore: { model: "openai/gpt-explore" }, quick: { model: "openai/gpt-quick" } },
    disabled_mcps: ["lsp", "context7", "grep_app"], telemetry: false,
    goal: { enabled }, team_mode: { enabled }, monitor: { enabled },
  }))
  const originalOmoText = JSON.stringify({ agents: { sisyphus: { model: "v1-only/unavailable" } },
    "[opencode2]": { goal: { enabled: !enabled }, team_mode: { enabled: !enabled }, monitor: { enabled: !enabled },
      agents: { explore: { model: "v1-only/unavailable" }, quick: { model: "v1-only/unavailable" } } } })
  const originalOmoPaths = [join(home, ".omo/omo.jsonc"), join(project, ".omo/omo.json")]
  for (const path of originalOmoPaths) writeFileSync(path, originalOmoText)
  const readPath = join(project, "qa-input.txt")
  writeFileSync(readPath, "QA_NATIVE_READ_PAYLOAD\nsecond fixture line\n")
  return { root, project, env, mode, enabled, readPath, configPath, pluginEntry, omoConfigPath, originalOmoPaths, originalOmoText }
}

export async function installFixture(fixture, options) {
  const { runner, repo, evidence } = options
  const result = await runner.run(`${fixture.mode}-installer`, [
    join(repo, "packages/omo-opencode2/scripts/qa-api-upgrade/installer-config.mjs"), repo, fixture.configPath,
  ], fixture, "bun")
  assert.equal(result.code, 0, `isolated installer resolver/writer failed; see ${evidence}`)
}
