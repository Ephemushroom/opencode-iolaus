import assert from "node:assert/strict"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { readFileSync } from "node:fs"

const [repo, configPath] = process.argv.slice(2)
assert.ok(repo && configPath, "Usage: bun installer-config.mjs REPO SANDBOX_CONFIG")
assert.ok(configPath.startsWith(`${process.env.XDG_CONFIG_HOME}/`), "only isolated config may be changed")
const { runOpenCode2Installer } = await import(pathToFileURL(join(repo,
  "packages/omo-opencode/src/cli/install-opencode2.ts")))
const update = await runOpenCode2Installer()
assert.equal(update.configPath, configPath)
const installed = JSON.parse(readFileSync(configPath, "utf8"))
assert.deepEqual(installed.plugins, [join(repo, "packages/omo-opencode2/src")])
assert.ok(Object.hasOwn(installed.mcp.servers, "context7"))
assert.ok(Object.hasOwn(installed.mcp.servers, "grep_app"))
assert.ok(Object.values(installed.mcp.servers).every((entry) => entry.disabled === true), "user-disabled MCPs must stay disabled")
assert.equal((await runOpenCode2Installer()).changed, false, "production installer must be idempotent")
console.log(JSON.stringify({ update, plugins: installed.plugins, mcps: Object.keys(installed.mcp.servers) }))
