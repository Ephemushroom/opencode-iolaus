import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"
import { once } from "node:events"

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

// Local mock model: the main session creates a plan-review DAG and waits; children answer by role. The reviewer (a
// judge) fails once so the graph shows a revise branch, then passes so the accept gate waits on screen.
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
const mock = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const tools = (body.tools ?? []).map((t) => t.name ?? t.function?.name)
  const messageText = (body.input ?? []).filter((item) => item?.type === "message").map((item) => JSON.stringify(item)).join("\n")
  requests.push({ tools, hasInstructions: Boolean(body.instructions), text: messageText.slice(0, 200) })
  let text = "IOLAUS_TUI_QA_DONE", call
  if (messageText.includes("You are the reviewer node")) {
    // Slow the judge a little so the sidebar has time to show the running node; then FAIL once, PASS on the revised plan.
    await new Promise((done) => setTimeout(done, 1500))
    text = messageText.includes("This is the revised plan") ? "Looks right.\nVERDICT: PASS" : "Step 2 has no verification.\nVERDICT: FAIL"
  } else if (messageText.includes("Write the work plan")) { await new Promise((done) => setTimeout(done, 2500)); text = "IOLAUS_TUI_PLAN_V1" }
  else if (messageText.includes("The reviewer rejected the plan")) { await new Promise((done) => setTimeout(done, 2500)); text = "IOLAUS_TUI_PLAN_V2" }
  else if (messageText.includes("Execute the approved plan")) text = "IOLAUS_TUI_EXECUTED"
  else if (tools.includes("iolaus_dag")) {
    const prior = (body.input ?? []).filter((item) => item?.type === "function_call_output").at(-1)?.output
    let result; try { result = JSON.parse(prior); if (result?.run && result?.events) result = result.run } catch {}
    if (!result) call = { name: "iolaus_dag", args: { action: "create", template: { template: "plan-review", task: "IOLAUS_TUI_TASK", executor: "sisyphus" } } }
    else if (result.status === "running" || result.status === "paused") { await new Promise((done) => setTimeout(done, 3000)); call = { name: "iolaus_dag", args: { action: "snapshot", run_id: result.runID } } }
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  for (const event of events(text, call)) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end("data: [DONE]\n\n")
})
mock.listen(0, "127.0.0.1"); await once(mock, "listening")
const mockURL = `http://127.0.0.1:${mock.address().port}/v1`

writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
  plugins: [{ package: join(root, "dist"), options: { enabled: true, mcps: [], gh: false, verify: false, models: { agents: { prometheus: "openai/gpt-5.5", momus: "openai/gpt-5.5", sisyphus: "openai/gpt-5.5" } } } }],
  model: "openai/gpt-5.5",
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  provider: { openai: { options: { apiKey: "fake-key", baseURL: mockURL }, models: {
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
const start = spawnSync("tmux", ["new-session", "-d", "-s", session, "-c", project, `${binary} --standalone`], { env, encoding: "utf8" })
assert.equal(start.status, 0, start.stderr)
spawnSync("tmux", ["pipe-pane", "-t", `${session}:0.0`, "-o", `cat >> ${tmuxLog}`], { env, encoding: "utf8" })

const target = `${session}:0.0`
const keys = (...args) => spawnSync("tmux", ["send-keys", "-t", target, ...args], { env, encoding: "utf8" })
const capture = (name) => { const out = spawnSync("tmux", ["capture-pane", "-p", "-t", target], { env, encoding: "utf8" }).stdout ?? ""; writeFileSync(join(evidence, `${name}.txt`), out); return out }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const traceHas = (pattern) => existsSync(tracePath) && pattern.test(readFileSync(tracePath, "utf8"))
const waitFor = async (pattern, timeoutMs, label) => { const until = Date.now() + timeoutMs; while (Date.now() < until) { if (traceHas(pattern)) return; await sleep(300) } throw new Error(`timed out waiting for ${label}`) }
const screens = {}
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "")
spawnSync("tmux", ["resize-window", "-t", session, "-x", "160", "-y", "45"], { env, encoding: "utf8" })
try {
  await waitFor(/iolaus\.tui\.loaded/, 20000, "tui load")
  await sleep(1500)
  screens.idle = capture("01-idle")
  // Cycle the primary agents with Shift+Tab (the host footer shows "shift+tab agents") and record each footer, back to Build.
  const footers = []
  for (let i = 0; i < 10; i++) {
    keys("BTab"); await sleep(400)
    const footer = strip(capture(`01-agent-${i}`)).split("\n").find((line) => / · GPT-5\.5/.test(line)) ?? ""
    footers.push(footer.trim())
    if (/\bBuild · GPT-5\.5/.test(footer)) break
  }
  screens.agents = footers.join("\n")
  writeFileSync(join(evidence, "01-agent-footers.txt"), screens.agents + "\n")
  keys("Run a plan-review DAG for IOLAUS_TUI_TASK", "Enter")
  await waitFor(/iolaus\.dag\.node\.started.*"nodeID":"plan"/, 30000, "plan node start")
  await sleep(800)
  screens.running = capture("02-running")
  await waitFor(/iolaus\.dag\.node\.waiting.*"nodeID":"approve"/, 60000, "approve gate")
  await sleep(1200)
  screens.gate = capture("03-gate-waiting")
  // Approve through the sidebar keybind. The gate is auto-selected because it is the node that needs the user.
  keys("Escape"); await sleep(200); keys("a")
  await waitFor(/iolaus\.tui\.action.*"action":"approve"/, 10000, "approve via keybind")
  await waitFor(/iolaus\.dag\.run\.completed/, 30000, "run completion")
  await sleep(1200)
  screens.completed = capture("04-completed")
  // Move the selection to a node that ran as a child session (the gate has none), then open it with `o`.
  for (let i = 0; i < 6 && !traceHas(/iolaus\.tui\.open/); i++) { keys("j"); await sleep(150); keys("o"); await sleep(400) }
  await sleep(1200)
  screens.opened = capture("05-opened-child")
  keys("C-c"); await sleep(500)
} catch (error) {
  capture("99-failure"); writeFileSync(join(evidence, "failure.txt"), String(error?.stack ?? error))
  throw error
} finally {
  spawnSync("tmux", ["kill-session", "-t", session], { env, encoding: "utf8" })
  mock.closeAllConnections(); await new Promise((done) => mock.close(done))
  rmSync(sandbox, { recursive: true, force: true })
}

const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : ""
assert.match(trace, /iolaus\.tui\.loaded/)
assert.match(screens.agents, /\bSisyphus · GPT-5\.5/, `agent cycle did not show "Sisyphus": ${screens.agents}`)
// Hephaestus is a subagent and is not in the primary cycle; Prometheus and Atlas are.
assert.match(screens.agents, /\bPrometheus · GPT-5\.5/, `agent cycle did not show "Prometheus": ${screens.agents}`)
assert.match(screens.agents, /\bAtlas · GPT-5\.5/, `agent cycle did not show "Atlas": ${screens.agents}`)
assert.ok(!/iolaus-(sisyphus|hephaestus|prometheus|atlas)/.test(screens.agents), `primary agents still show the iolaus- prefix: ${screens.agents}`)
assert.match(strip(screens.running), /Iolaus DAG/, "sidebar header missing")
assert.match(strip(screens.running), /DAG · 1 run/, "footer summary missing on the running screen")
assert.match(strip(screens.running), /▶ plan|plan.*▶/, "running plan node not rendered with the running glyph")
assert.match(strip(screens.running), /\[[█░]+\] \d+\/\d+/, "progress bar missing")
assert.match(strip(screens.gate), /⏸ approve/, "waiting gate not rendered")
assert.match(strip(screens.gate).replace(/\s+/g, " "), /gate: Plan for "IOLAUS_TUI_TASK" passed review/, "gate prompt not rendered")
assert.match(strip(screens.gate), /↷ (revise|rereview)|✓ revise/, "review branch state not rendered")
assert.match(strip(screens.gate), /waiting approval/, "footer did not report the waiting gate")
assert.match(strip(screens.gate).replace(/\s+/g, " "), /o open agent · a approve · r reject/, "keybind hint missing")
assert.match(trace, /iolaus\.tui\.action.*"action":"approve".*"nodeID":"approve"/, "approve keybind did not reach the RPC")
assert.match(strip(screens.completed), /✓ execute/, "execute node not shown completed")
assert.match(trace, /iolaus\.tui\.open.*"sessionID":"ses_/, "open keybind did not target a child session")
const nodeOrder = [...trace.matchAll(/iolaus\.dag\.node\.(?:completed|approved)[^\n]*"nodeID":"([a-z]+)"/g)].map((m) => m[1])
assert.deepEqual(nodeOrder, ["plan", "review", "revise", "rereview", "approve", "execute"], `unexpected node order ${nodeOrder}`)
assert.ok(!/iolaus\.agent\.rendered[^\n]*"agent":"momus"/.test(trace), "judge review opened a momus child session")
const realAfter = { config: await digest(realConfig), database: await digest(realDatabase) }
assert.deepEqual(realAfter, realBefore)
writeFileSync(join(evidence, "receipt.json"), JSON.stringify({
  binary,
  version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
  tracePath,
  tmuxLog,
  nativeTuiLoaded: true,
  screens: Object.keys(screens),
  nodeOrder,
  requestCount: requests.length,
  realBefore,
  realAfter,
  sandboxRemoved: !existsSync(sandbox),
  omitted: "No provider credentials, auth files, prompts, or inherited secret-bearing environment values were recorded.",
}, null, 2) + "\n")
console.log(JSON.stringify({ evidence, verdict: "PASS", nativeTuiLoaded: true, sandboxRemoved: !existsSync(sandbox) }, null, 2))
