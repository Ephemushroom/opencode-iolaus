import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(new URL("..", import.meta.url).pathname)
const evidence = resolve(process.argv[2] ?? join(root, ".omo/evidence/20260924-iolaus-dag-tui"))
assert.ok(evidence.startsWith(`${join(root, ".omo/evidence")}/`))
mkdirSync(evidence, { recursive: false })

const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-tui-qa-")))
const project = join(sandbox, "project")
const localPackage = join(sandbox, "iolaus-package")
const home = join(sandbox, "home")
const config = join(sandbox, "config")
const tracePath = join(evidence, "trace.ndjson")
const tmuxLog = join(evidence, "tmux.log")
mkdirSync(project, { recursive: true })
mkdirSync(localPackage, { recursive: true })
mkdirSync(join(config, "opencode"), { recursive: true })
mkdirSync(home, { recursive: true })
mkdirSync(join(project, "node_modules"), { recursive: true })
mkdirSync(join(config, "opencode/plugins/iolaus"), { recursive: true })
symlinkSync(root, join(project, "node_modules/opencode-iolaus"), "dir")
symlinkSync(join(root, "dist"), join(localPackage, "dist"), "dir")
writeFileSync(join(localPackage, "package.json"), JSON.stringify({ name: "opencode-iolaus", type: "module", main: "./dist/index.js", exports: { ".": "./dist/index.js", "./tui": "./dist/tui.js" } }))

const realHome = homedir()
const realConfig = join(realHome, ".config/opencode/opencode.json")
const realDatabase = join(realHome, ".local/share/opencode/opencode.db")
const digest = async (path) => {
  if (!existsSync(path)) return "absent"
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
const realBefore = { config: await digest(realConfig), database: await digest(realDatabase) }

writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
  plugins: [{ package: join(project, "node_modules/opencode-iolaus"), options: { enabled: true } }],
  model: "openai/gpt-5.5",
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  provider: { openai: { options: { apiKey: "fake-key", baseURL: "http://127.0.0.1:9/v1" }, models: {
    "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } },
  } } },
}))
writeFileSync(join(config, "opencode/cli.json"), JSON.stringify({ plugins: [localPackage] }))
writeFileSync(join(config, "opencode/plugins/iolaus/package.json"), JSON.stringify({ type: "module", exports: { "./tui": "./tui.ts" } }))
writeFileSync(join(config, "opencode/plugins/iolaus/tui.ts"), `export { default } from ${JSON.stringify(join(root, "dist/tui.js"))}\n`)

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PWD: project,
  XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: join(sandbox, "data"),
  XDG_CACHE_HOME: join(sandbox, "cache"),
  XDG_STATE_HOME: join(sandbox, "state"),
  OPENCODE_TEST_HOME: home,
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  IOLAUS_TRACE: tracePath,
  OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [localPackage] }),
}

const session = `iolaus-tui-${process.pid}`
const start = spawnSync("tmux", ["new-session", "-d", "-s", session, "-c", project, `${binary} --standalone --print-logs --log-level debug`], { env, encoding: "utf8" })
assert.equal(start.status, 0, start.stderr)
spawnSync("tmux", ["pipe-pane", "-t", `${session}:0.0`, "-o", `cat >> ${tmuxLog}`], { env, encoding: "utf8" })

try {
  await new Promise((resolve) => setTimeout(resolve, 5000))
  spawnSync("tmux", ["send-keys", "-t", `${session}:0.0`, "C-c"], { env, encoding: "utf8" })
  await new Promise((resolve) => setTimeout(resolve, 500))
} finally {
  spawnSync("tmux", ["kill-session", "-t", session], { env, encoding: "utf8" })
  rmSync(sandbox, { recursive: true, force: true })
}

const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : ""
assert.match(trace, /iolaus\.tui\.loaded/)
const realAfter = { config: await digest(realConfig), database: await digest(realDatabase) }
assert.deepEqual(realAfter, realBefore)
writeFileSync(join(evidence, "receipt.json"), JSON.stringify({
  binary,
  version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
  tracePath,
  tmuxLog,
  nativeTuiLoaded: true,
  realBefore,
  realAfter,
  sandboxRemoved: !existsSync(sandbox),
  omitted: "No provider credentials, auth files, prompts, or inherited secret-bearing environment values were recorded.",
}, null, 2) + "\n")
console.log(JSON.stringify({ evidence, verdict: "PASS", nativeTuiLoaded: true, sandboxRemoved: !existsSync(sandbox) }, null, 2))
