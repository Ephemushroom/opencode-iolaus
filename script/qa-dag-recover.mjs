import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"
import { once } from "node:events"

// Live QA for controller recovery and the confirmed cancel keybind. A real standalone TUI runs a DAG whose first node
// is still working when the plugin hot-reloads (the host re-imports a rewritten dist); the new controller must pick the
// child up and finish the run. A second run is then cancelled from the details dialog with `c` and a confirmation.
const root = resolve(new URL("..", import.meta.url).pathname)
const packageRoot = resolve(process.env.IOLAUS_QA_PACKAGE_ROOT ?? root)
const evidence = resolve(process.argv[2] ?? join(root, `.omo/evidence/${new Date().toISOString().replace(/[:.]/g, "-")}-dag-recover`))
assert.ok(evidence.startsWith(`${join(root, ".omo/evidence")}/`))
mkdirSync(evidence, { recursive: false })

const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-recover-qa-")))
const project = join(sandbox, "project"), home = join(sandbox, "home"), config = join(sandbox, "config")
const localPackage = join(sandbox, "iolaus-package")
const tracePath = join(evidence, "trace.ndjson")
const release = join(sandbox, "release-slow")
for (const dir of [project, home, join(config, "opencode/plugins/iolaus"), localPackage]) mkdirSync(dir, { recursive: true })
// A copy, not a symlink: the reload rewrites this dist and must not touch the repository build.
cpSync(join(packageRoot, "dist"), join(localPackage, "dist"), { recursive: true })
symlinkSync(join(packageRoot, "node_modules"), join(localPackage, "node_modules"), "dir")
writeFileSync(join(localPackage, "package.json"), JSON.stringify({ name: "opencode-iolaus", type: "module", main: "./dist/index.js", exports: { ".": "./dist/index.js", "./tui": "./dist/tui.js" } }))

const realConfig = join(homedir(), ".config/opencode/opencode.json")
const realDatabase = join(homedir(), ".local/share/opencode/opencode.db")
const digest = async (path) => {
  if (!existsSync(path)) return "absent"
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
const realBefore = { config: await digest(realConfig), database: await digest(realDatabase) }

const requests = []
function events(text, call) {
  const id = `resp_${requests.length}`, item = `item_${requests.length}`
  const result = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } }]
  if (call) {
    const args = JSON.stringify(call.args)
    result.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: item, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: args, status: "completed" } })
  } else {
    result.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: item } },
      { type: "response.output_text.delta", item_id: item, output_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: item } })
  }
  result.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  return result
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const node = (id, prompt, dependsOn = []) => ({ id, title: id, agent: "sisyphus", model: "openai/gpt-5.5", prompt, dependsOn })
const RUNS = {
  IOLAUS_QA_RECOVER: { schemaVersion: 1, name: "QA recover", nodes: [node("slow", "IOLAUS_NODE_SLOW"), node("after", "IOLAUS_NODE_AFTER", ["slow"])] },
  IOLAUS_QA_CANCEL: { schemaVersion: 1, name: "QA cancel", nodes: [node("hang", "IOLAUS_NODE_HANG")] },
}
const mock = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const input = body.input ?? []
  const tools = (body.tools ?? []).map((t) => t.name ?? t.function?.name)
  const messages = input.filter((item) => item?.type === "message").map((item) => JSON.stringify(item)).join("\n")
  const lastUser = input.findLastIndex((item) => item?.type === "message" && item.role === "user")
  const task = Object.keys(RUNS).find((key) => JSON.stringify(input[lastUser] ?? "").includes(key))
  requests.push({ tools: tools.length, text: messages.slice(-160) })
  let text = "IOLAUS_QA_OK", call
  if (messages.includes("IOLAUS_NODE_SLOW")) {
    // Keep the child working until the reload has happened, so its result arrives after the old controller is gone.
    const until = Date.now() + 60000
    while (!existsSync(release) && Date.now() < until) await sleep(200)
    text = "IOLAUS_SLOW_DONE"
  } else if (messages.includes("IOLAUS_NODE_HANG")) { await sleep(60000); text = "IOLAUS_HANG_DONE" }
  else if (messages.includes("IOLAUS_NODE_AFTER")) text = "IOLAUS_AFTER_DONE"
  else if (task && tools.includes("iolaus_dag")) {
    const created = input.slice(lastUser).some((item) => item?.type === "function_call_output")
    if (!created) call = { name: "iolaus_dag", args: { action: "create", definition: RUNS[task] } }
    else text = "IOLAUS_QA_CREATED"
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  for (const event of events(text, call)) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end("data: [DONE]\n\n")
})
mock.listen(0, "127.0.0.1"); await once(mock, "listening")
const mockURL = `http://127.0.0.1:${mock.address().port}/v1`
mkdirSync(join(home, ".iolaus"), { recursive: true })
writeFileSync(join(home, ".iolaus", "iolaus.json"), JSON.stringify({ enabled: true, mcps: [], gh: false, verify: false, models: { agents: { sisyphus: "openai/gpt-5.5" } } }))
writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
  plugins: [{ package: join(localPackage, "dist") }], model: "openai/gpt-5.5", default_agent: "build",
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  provider: { openai: { options: { apiKey: "fake-key", baseURL: mockURL }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } },
}))
writeFileSync(join(config, "opencode/plugins/iolaus/package.json"), JSON.stringify({ type: "module", exports: { "./tui": "./tui.ts" } }))
writeFileSync(join(config, "opencode/plugins/iolaus/tui.ts"), `export { default } from ${JSON.stringify(join(localPackage, "dist/tui.js"))}\n`)
const env = {
  ...process.env, HOME: home, USERPROFILE: home, PWD: project, XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
  OPENCODE_TEST_HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  IOLAUS_TRACE: tracePath, IOLAUS_HOME: join(home, ".iolaus"), IOLAUS_DAG_DB: join(project, ".iolaus/dag/state.db"),
  OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [localPackage] }),
}
const session = `iolaus-recover-${process.pid}`
const tmux = (...args) => spawnSync("tmux", ["-L", session, ...args], { env, encoding: "utf8" })
assert.equal(tmux("new-session", "-d", "-s", session, "-x", "160", "-y", "45", "-c", project, `${binary} --standalone`).status, 0)
const target = `${session}:0.0`
const keys = (...args) => tmux("send-keys", "-t", target, ...args)
const screens = {}
const capture = (name) => {
  const out = tmux("capture-pane", "-p", "-t", target).stdout ?? ""
  writeFileSync(join(evidence, `${name}.txt`), out.replace(/[ \t]+$/gm, "").replace(/\n+$/, "\n"))
  return (screens[name] = out)
}
const trace = () => existsSync(tracePath) ? readFileSync(tracePath, "utf8") : ""
const traceCount = (pattern) => trace().split("\n").filter((line) => pattern.test(line)).length
const waitFor = async (pattern, timeoutMs, label, above = 0) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) { if (traceCount(pattern) > above) return; await sleep(300) }
  throw new Error(`timed out waiting for ${label}`)
}
const runStatus = (name) => {
  const out = spawnSync("sqlite3", [env.IOLAUS_DAG_DB, `select status from dag_runs where name='${name}'`], { encoding: "utf8" })
  return out.stdout.trim()
}
const checks = []
const isolation = { databasePaths: [] }
// This QA may run while the user's own host session writes the real DB, so its digest can change for unrelated
// reasons. Isolation is proven directly: no process of the sandbox TUI opens a database outside the sandbox.
const sandboxDatabases = () => {
  const pane = Number(tmux("display-message", "-p", "-t", target, "#{pane_pid}").stdout.trim())
  const table = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
  const pids = [pane]
  for (const pid of pids) for (const [child, parent] of table) if (parent === pid) pids.push(child)
  const files = spawnSync("lsof", ["-Fn", "-p", pids.join(",")], { encoding: "utf8" }).stdout
  return [...new Set(files.split("\n").filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line)).map((line) => line.slice(1)))].sort()
}
let failure
try {
  await waitFor(/iolaus\.tui\.loaded/, 20000, "tui load")
  await sleep(1500)
  isolation.databasePaths = sandboxDatabases()
  assert.ok(isolation.databasePaths.some((path) => path === join(env.XDG_DATA_HOME, "opencode/opencode.db")), "standalone process did not open the sandbox DB")
  assert.ok(isolation.databasePaths.every((path) => path.startsWith(`${sandbox}/`)), `standalone process opened a DB outside the sandbox: ${isolation.databasePaths}`)
  // 1. Recovery: the slow node is running when the plugin reloads.
  keys("-l", "Run IOLAUS_QA_RECOVER"); keys("Enter")
  await waitFor(/iolaus\.dag\.node\.started.*"nodeID":"slow"/, 30000, "slow node start")
  await sleep(1000)
  const loadsBefore = traceCount(/"event":"iolaus\.loaded"/)
  appendFileSync(join(localPackage, "dist/index.js"), "\n// qa reload\n")
  await waitFor(/"event":"iolaus\.loaded"/, 20000, "plugin reload", loadsBefore)
  checks.push({ name: "plugin reloaded mid-run", verdict: "PASS", loads: traceCount(/"event":"iolaus\.loaded"/) })
  await sleep(2000)
  writeFileSync(release, "go")
  await waitFor(/iolaus\.dag\.node\.completed.*"nodeID":"slow"/, 30000, "slow node settled after the reload")
  await waitFor(/iolaus\.dag\.node\.completed.*"nodeID":"after"/, 30000, "dependent node after the reload")
  await waitFor(/iolaus\.dag\.run\.completed/, 10000, "recovered run completion")
  assert.match(trace(), /iolaus\.dag\.recovered.*"nodeID":"slow".*"outcome":"reattached"/, "the new controller did not reattach the running node")
  assert.equal(runStatus("QA recover"), "completed")
  checks.push({ name: "running node reattached and run completed", verdict: "PASS" })
  // 2. Cancel: `c` asks first; declining keeps the run, confirming cancels it.
  keys("-l", "Run IOLAUS_QA_CANCEL"); keys("Enter")
  await waitFor(/iolaus\.dag\.node\.started.*"nodeID":"hang"/, 30000, "hang node start")
  await sleep(800)
  keys("C-x"); await sleep(150); keys("d"); await sleep(800)
  capture("01-dialog-running")
  assert.match(screens["01-dialog-running"], /DAG details/)
  assert.match(screens["01-dialog-running"], /c cancel run/, "the footer must name the cancel keybind")
  assert.doesNotMatch(screens["01-dialog-running"], /\[Cancel run\]/, "the clickable cancel text must be gone")
  keys("c"); await sleep(600)
  capture("02-confirm-shown")
  assert.match(screens["02-confirm-shown"], /Cancel DAG run\?/, "c must ask for confirmation")
  keys("Escape"); await sleep(800)
  capture("03-confirm-declined")
  assert.equal(runStatus("QA cancel"), "running", "declining must keep the run")
  assert.ok(!/iolaus\.tui\.action.*"action":"cancel"/.test(trace()), "declining must not send cancel")
  assert.match(screens["03-confirm-declined"], /DAG details/, "the details dialog must return after declining")
  keys("c"); await sleep(600)
  capture("04-confirm-again")
  assert.match(screens["04-confirm-again"], /Cancel DAG run\?/)
  keys("Enter"); await sleep(1200)
  capture("05-after-confirm")
  if (!/iolaus\.tui\.action.*"action":"cancel"/.test(trace())) {
    // The host's confirm dialog may default to its cancel button; move to the confirm button explicitly.
    keys("c"); await sleep(600); keys("Left"); await sleep(200); keys("Enter"); await sleep(1200)
    capture("05b-after-confirm")
  }
  await waitFor(/iolaus\.tui\.cancel\.confirmed/, 5000, "cancel confirmation")
  await waitFor(/iolaus\.dag\.run\.cancelled/, 10000, "run cancelled")
  assert.equal(runStatus("QA cancel"), "cancelled")
  checks.push({ name: "cancel keybind declines and confirms", verdict: "PASS" })
  const after = sandboxDatabases()
  assert.ok(after.every((path) => path.startsWith(`${sandbox}/`)), `standalone process opened a DB outside the sandbox: ${after}`)
  isolation.databasePathsAtEnd = after
} catch (error) {
  failure = error
  if (tmux("has-session", "-t", session).status === 0) capture("99-failure")
} finally {
  tmux("kill-session", "-t", session)
  mock.closeAllConnections(); await new Promise((done) => mock.close(done))
  rmSync(sandbox, { recursive: true, force: true })
}
const realAfter = { config: await digest(realConfig), database: await digest(realDatabase) }
const hostConfigUnchanged = realAfter.config === realBefore.config
const cleanup = { sandboxRemoved: !existsSync(sandbox), mockClosed: !mock.listening, tmuxStopped: tmux("has-session", "-t", session).status !== 0 }
if (!hostConfigUnchanged) failure ??= new Error("real host config changed during isolated QA")
if (!cleanup.sandboxRemoved || !cleanup.mockClosed || !cleanup.tmuxStopped) failure ??= new Error("QA cleanup incomplete")
writeFileSync(join(evidence, "receipt.json"), JSON.stringify({
  verdict: failure ? "FAIL" : "PASS", failure: failure ? String(failure.message) : undefined,
  binary, version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), packageRoot,
  checks, screens: Object.keys(screens), requestCount: requests.length, realBefore, realAfter, hostConfigUnchanged, realDatabaseDigestChanged: realAfter.database !== realBefore.database, isolation, cleanup,
  omitted: "No provider credentials, auth files or inherited secret-bearing environment values were recorded.",
}, null, 2) + "\n")
if (failure) throw failure
console.log(JSON.stringify({ evidence, verdict: "PASS", checks }, null, 2))
