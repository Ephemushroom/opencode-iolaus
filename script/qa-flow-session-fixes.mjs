import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"

const root = resolve(new URL("..", import.meta.url).pathname)
const evidence = resolve(process.argv[2] ?? join(root, ".iolaus/evidence/flow-session-fixes/live"))
assert.ok(evidence.startsWith(`${root}/.iolaus/evidence/`))
mkdirSync(evidence, { recursive: true })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-session-fixes-")))
const home = join(sandbox, "home"), config = join(sandbox, "config"), project = join(sandbox, "project"), pkg = join(sandbox, "plugin")
for (const dir of [home, project, pkg, join(home, ".iolaus"), join(config, "opencode")]) mkdirSync(dir, { recursive: true })
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const trace = join(evidence, "trace.ndjson"), routes = join(evidence, "routes.ndjson"), destination = join(sandbox, "destination.json")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const until = async (read, label, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = read(); if (value) return value; await sleep(100) }
  throw new Error(`timeout: ${label}`)
}
const hostPaths = [join(homedir(), ".iolaus/iolaus.json"), join(homedir(), ".config/opencode/opencode.json")]
const hostState = () => hostPaths.map((path) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent")
const before = hostState(), requests = [], checks = [], isolation = []
const runningHolds = new Map()
let staleFailures = 0
const events = (id, text, call) => {
  const result = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } }]
  if (call) {
    const args = JSON.stringify(call.args)
    result.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id, call_id: id, name: call.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id, call_id: id, name: call.name, arguments: args, status: "completed" } })
  } else result.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id } },
    { type: "response.output_text.delta", item_id: id, output_index: 0, delta: text }, { type: "response.output_item.done", output_index: 0, item: { type: "message", id } })
  result.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  return result
}
const mock = http.createServer(async (req, res) => {
  if (req.url !== "/v1/responses" || req.method !== "POST") return res.writeHead(404).end()
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString()), input = body.input ?? []
  const lastUser = input.findLastIndex((item) => item.type === "message" && item.role === "user" && !/Iolaus Flow notice|<subagent /.test(JSON.stringify(item)))
  const command = JSON.stringify(input[lastUser]).match(/QA_COMMAND:([A-Za-z0-9+/=]+)/)?.[1]
  const outputs = input.slice(lastUser).filter((item) => item.type === "function_call_output")
  const record = { sequence: requests.length, command, outputs, input }
  requests.push(record)
  appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(record) + "\n")
  if (body.tools?.length && !command && JSON.stringify(input).includes("STALE_ATTEMPT_QA") && staleFailures++ === 0) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "QA failed attempt A", type: "invalid_request_error", code: "invalid_api_key" } }))
    return
  }
  const runningMode = body.tools?.length && !command && JSON.stringify(input).match(/NATIVE_RUNNING_QA_(on|off)/)?.[1]
  if (runningMode) await new Promise((done) => runningHolds.set(runningMode, done))
  const call = body.tools?.length && command && !outputs.length ? JSON.parse(Buffer.from(command, "base64").toString()) : undefined
  const text = JSON.stringify(input).includes("NATIVE_CHILD_QA") ? "NATIVE_CHILD_RESULT" : "SCHEDULER_CHILD_RESULT"
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events(`qa_${requests.length}`, text, call)) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end("data: [DONE]\n\n")
})
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, PWD: project,
  XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
  OPENCODE_TEST_HOME: home, IOLAUS_HOME: join(home, ".iolaus"), IOLAUS_TRACE: trace, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
const socket = `iolaus-session-fixes-${process.pid}`
const tmux = (...args) => spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" })
const keys = (...args) => assert.equal(tmux("send-keys", "-t", "qa:0.0", ...args).status, 0)
const screen = (name) => {
  const text = tmux("capture-pane", "-p", "-t", "qa:0.0").stdout
  writeFileSync(join(evidence, `${name}.txt`), text)
  return text
}
const click = (x, y) => { keys("-l", `\x1b[<0;${x + 1};${y + 1}M`); keys("-l", `\x1b[<0;${x + 1};${y + 1}m`) }
const routeEvents = () => existsSync(routes) ? readFileSync(routes, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
const sql = (query) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", join(home, ".iolaus/iolaus.db"), query], { encoding: "utf8" }) || "[]")
const command = async (name, args) => {
  const encoded = Buffer.from(JSON.stringify({ name, args })).toString("base64")
  keys("-l", `QA_COMMAND:${encoded}`); keys("Enter")
  const result = await until(() => requests.findLast((item) => item.command === encoded && item.outputs.length), `tool ${name}`)
  await sleep(500)
  return result.outputs.at(-1).output
}
const launch = async (mode, owner) => {
  env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify({ tabs: { mode }, plugins: [pkg, join(sandbox, "probe")] })
  const result = tmux("new-session", "-d", "-s", "qa", "-c", project, `${binary} --standalone${owner ? ` --session ${owner}` : ""}`)
  assert.equal(result.status, 0, result.stderr)
  tmux("resize-window", "-t", "qa", "-x", "170", "-y", "50")
  await until(() => routeEvents().at(-1)?.mode === mode, `TUI ${mode} ready`)
  await sleep(1500)
  const panePID = Number(tmux("display-message", "-p", "-t", "qa:0.0", "#{pane_pid}").stdout.trim())
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
  const pids = [panePID]; for (const pid of pids) for (const [child, parent] of rows) if (parent === pid) pids.push(child)
  const files = spawnSync("lsof", ["-Fn", "-p", pids.join(",")], { encoding: "utf8" }).stdout.split("\n").filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line)).map((line) => line.slice(1))
  assert.ok(files.some((path) => path === join(sandbox, "data/opencode/opencode.db")))
  assert.ok(files.every((path) => path.startsWith(`${sandbox}/`)))
  isolation.push({ mode, pids, databasePaths: [...new Set(files)] })
}
const returnOwner = async (owner) => {
  for (let step = 0; step < 3; step++) { keys("Escape"); await sleep(300) }
  keys("F8")
  await until(() => routeEvents().at(-1)?.sessionID === owner, "return owner")
  await sleep(700)
}
const selectNode = async (label, name) => {
  const sidebarLabel = label === "Native QA" ? "Subagent calls" : label
  const text = screen(`${name}-before`).split("\n")
  const row = text.findIndex((line) => line.lastIndexOf(sidebarLabel) > 125)
  assert.ok(row >= 0, `missing sidebar node ${label}`)
  click(text[row].lastIndexOf(sidebarLabel) + 2, row)
  await sleep(600)
  if (["Scheduled QA", "Judge QA", "Unavailable QA", "Future QA"].includes(label)) {
    keys("k", "k", "k", "k")
    const index = ["Scheduled QA", "Judge QA", "Unavailable QA", "Future QA"].indexOf(label)
    for (let step = 0; step < index; step++) keys("j")
    await sleep(250)
  }
  assert.match(screen(name), /Node details/)
}
let failure, owner, native, scheduled
try {
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  symlinkSync(join(root, "dist"), join(pkg, "dist"), "dir")
  symlinkSync(join(root, "node_modules"), join(pkg, "node_modules"), "dir")
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "opencode-iolaus", type: "module", exports: { ".": "./dist/index.js", "./tui": "./dist/tui.js" } }))
  const probe = join(sandbox, "probe"); mkdirSync(probe)
  writeFileSync(join(probe, "package.json"), JSON.stringify({ type: "module", exports: { "./tui": "./tui.tsx" } }))
  writeFileSync(join(probe, "tui.tsx"), `import { Plugin } from "@opencode/plugin/tui"; import { createEffect } from "solid-js"; import { appendFileSync, readFileSync } from "node:fs";
export default Plugin.define({id:"qa-route-probe", setup(ctx) { ctx.ui.slot({append:"app",render:()=>{createEffect(()=>appendFileSync(${JSON.stringify(routes)}, JSON.stringify({...ctx.ui.router.current(),mode:ctx.ui.tabs.enabled()?"on":"off"})+"\\n"));ctx.keymap.layer(()=>({mode:"global",commands:[{bind:"f8",run:()=>ctx.ui.router.navigate({type:"session",sessionID:JSON.parse(readFileSync(${JSON.stringify(destination)},"utf8")).owner})}]})); return null}})}})`)
  const model = "openai/gpt-5.5"
  writeFileSync(join(home, ".iolaus/iolaus.json"), JSON.stringify({ mcps: [], gh: false, astGrep: false, verify: false, models: { categories: { quick: model }, agents: { momus: model } } }))
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({ plugins: [{ package: join(pkg, "dist") }], model, permissions: [{ action: "*", resource: "*", effect: "allow" }],
    provider: { openai: { options: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } } }))
  await launch("on")
  await command("iolaus_flow", { action: "create", definition: { schemaVersion: 1, name: "Session Routing QA", nodes: [
    { id: "work", title: "Scheduled QA", agent: "quick", prompt: "SCHEDULER_CHILD_QA", dependsOn: [] },
    { id: "judge", title: "Judge QA", kind: "judge", agent: "momus", prompt: "JUDGE_QA", dependsOn: ["work"] },
    { id: "gate", title: "Unavailable QA", kind: "gate", prompt: "Keep waiting", dependsOn: ["judge"] },
    { id: "future", title: "Future QA", agent: "quick", prompt: "Future task", dependsOn: ["gate"] },
  ] } })
  await until(() => sql("SELECT * FROM dag_runs WHERE status='paused'").length, "paused flow")
  const flow = sql("SELECT * FROM dag_runs WHERE name='Session Routing QA'")[0]
  owner = flow.owner_session_id
  writeFileSync(destination, JSON.stringify({ owner }))
  scheduled = JSON.parse(sql("SELECT execution_json FROM dag_nodes WHERE node_id='work'")[0].execution_json).sessionID
  const nodesBefore = sql("SELECT * FROM dag_nodes ORDER BY run_id,node_id")
  const refused = await command("subagent", { agent: "quick", description: "Wrong Flow continuation", sessionID: scheduled, prompt: "Follow up" })
  assert.match(refused, /scheduler-owned/)
  assert.deepEqual(sql("SELECT * FROM dag_nodes ORDER BY run_id,node_id"), nodesBefore)
  checks.push("Flow continuation refused before any observed node creation")
  await command("subagent", { agent: "quick", description: "Native QA", prompt: "NATIVE_CHILD_QA" })
  native = JSON.parse(sql("SELECT execution_json FROM dag_nodes WHERE node_id LIKE '%subagent%' OR run_id IN (SELECT run_id FROM dag_runs WHERE json_extract(definition_json,'$.observed')=1)")[0].execution_json).sessionID
  const observedBefore = sql("SELECT * FROM dag_nodes WHERE run_id IN (SELECT run_id FROM dag_runs WHERE json_extract(definition_json,'$.observed')=1)")
  const followed = await command("subagent", { agent: "quick", description: "Native QA", sessionID: native, prompt: "NATIVE_CHILD_QA followup" })
  assert.match(followed, /NATIVE_CHILD_RESULT/)
  const observedAfter = sql("SELECT * FROM dag_nodes WHERE run_id IN (SELECT run_id FROM dag_runs WHERE json_extract(definition_json,'$.observed')=1)")
  assert.equal(observedAfter.length, 1)
  assert.equal(observedAfter[0].attempt, observedBefore[0].attempt + 1)
  const beforeRefusal = sql("SELECT * FROM dag_nodes ORDER BY run_id,node_id")
  assert.match(await command("subagent", { agent: "quick", description: "Wrong Flow continuation again", sessionID: scheduled, prompt: "Another follow up" }), /scheduler-owned/)
  assert.deepEqual(sql("SELECT * FROM dag_nodes ORDER BY run_id,node_id"), beforeRefusal)
  checks.push("Native followup succeeded and reopened only its existing observed node; repeated Flow misuse left it untouched")
  await command("iolaus_flow", { action: "create", definition: { schemaVersion: 1, name: "Stale Attempt QA", nodes: [
    { id: "stale", agent: "quick", prompt: "STALE_ATTEMPT_QA", dependsOn: [] },
  ] } })
  const staleFlow = await until(() => sql("SELECT * FROM dag_runs WHERE name='Stale Attempt QA' AND status='failed'")[0], "attempt A failed")
  const attemptA = JSON.parse(sql(`SELECT execution_json FROM dag_nodes WHERE run_id='${staleFlow.run_id}'`)[0].execution_json).sessionID
  await command("iolaus_flow", { action: "retry", run_id: staleFlow.run_id, node_id: "stale" })
  await until(() => sql(`SELECT * FROM dag_runs WHERE run_id='${staleFlow.run_id}' AND status='completed'`)[0], "attempt B completed")
  const attemptB = JSON.parse(sql(`SELECT execution_json FROM dag_nodes WHERE run_id='${staleFlow.run_id}'`)[0].execution_json).sessionID
  assert.notEqual(attemptA, attemptB)
  const beforeStale = sql("SELECT * FROM dag_nodes ORDER BY run_id,node_id")
  const staleRefusal = await command("subagent", { agent: "quick", description: "Stale attempt followup", sessionID: attemptA, prompt: "Follow up old failed attempt" })
  assert.match(staleRefusal, /direct native child/)
  assert.doesNotMatch(staleRefusal, /scheduler-owned/)
  assert.deepEqual(sql("SELECT * FROM dag_nodes ORDER BY run_id,node_id"), beforeStale)
  checks.push(`Failed attempt A ${attemptA} refused after explicit retry B ${attemptB}, with no observed-state changes and no unverified ownership claim`)
  for (const mode of ["on", "off"]) {
    if (mode === "off") { tmux("kill-session", "-t", "qa"); await sleep(1200); await launch(mode, owner) }
    for (const [label, id] of [["Native QA", native], ["Scheduled QA", scheduled]]) for (const key of ["Enter", "o"]) {
      await returnOwner(owner)
      const name = `${mode}-${label.split(" ")[0]}-${key}`
      await selectNode(label, name)
      keys(key)
      await until(() => routeEvents().at(-1)?.sessionID === id, `exact ${name}`)
      await sleep(500)
      assert.doesNotMatch(screen(`${name}-opened`), /Node details/)
      checks.push(`${name} navigated exact session ${id}`)
    }
    for (const [label, reason] of [["Unavailable QA", /Human gates do not have/], ["Judge QA", /Judge nodes use a model call/], ["Future QA", /session is not available yet/]]) {
      await returnOwner(owner)
      await selectNode(label, `${mode}-${label.split(" ")[0]}-unavailable`)
      assert.match(screen(`${mode}-${label.split(" ")[0]}-reason`), reason)
      keys("Enter"); await sleep(300)
      assert.equal(routeEvents().at(-1).sessionID, owner)
      assert.match(screen(`${mode}-${label.split(" ")[0]}-still-open`), /Node details/)
      keys("Escape")
      checks.push(`${mode}-${label} explains unavailable session and stays in details`)
    }
    await returnOwner(owner)
    await command("subagent", { agent: "quick", description: `Running QA ${mode}`, prompt: `NATIVE_RUNNING_QA_${mode}`, background: true })
    await until(() => runningHolds.has(mode), `running native child ${mode}`)
    const runningNode = await until(() => sql(`SELECT * FROM dag_nodes WHERE status='running' AND json_extract(node_json,'$.title')='Running QA ${mode}'`)[0], "running observed node")
    const runningID = JSON.parse(runningNode.execution_json).sessionID
    for (const key of ["Enter", "o"]) {
      await returnOwner(owner)
      await selectNode(`Running QA ${mode}`, `${mode}-running-${key}`)
      assert.match(screen(`${mode}-running-${key}-selected`), /Status: Running/)
      keys(key)
      await until(() => routeEvents().at(-1)?.sessionID === runningID, `exact running ${mode} ${key}`)
      assert.equal(sql(`SELECT status FROM dag_nodes WHERE run_id='${runningNode.run_id}' AND node_id='${runningNode.node_id}'`)[0].status, "running")
      screen(`${mode}-running-${key}-opened`)
      checks.push(`${mode}-Running-native-${key} navigated exact active child ${runningID} while its node remained running`)
    }
    runningHolds.get(mode)(); runningHolds.delete(mode)
    await until(() => sql(`SELECT status FROM dag_nodes WHERE run_id='${runningNode.run_id}' AND node_id='${runningNode.node_id}'`)[0].status === "completed", "running child completed after release")
  }
} catch (error) {
  failure = String(error.stack ?? error)
  screen("failure")
} finally {
  for (const done of runningHolds.values()) done()
  tmux("kill-server")
  await sleep(800)
  mock.closeAllConnections(); await new Promise((done) => mock.close(done))
  const remaining = spawnSync("pgrep", ["-f", sandbox], { encoding: "utf8" }).stdout.trim()
  assert.equal(remaining, "", "sandbox processes leaked")
  assert.deepEqual(hostState(), before)
  rmSync(sandbox, { recursive: true, force: true })
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ verdict: failure ? "FAIL" : "PASS", failure, version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), checks, owner, native, scheduled, isolation, hostConfigUnchanged: JSON.stringify(before) === JSON.stringify(hostState()), remainingSandboxProcesses: remaining, sandboxRemoved: !existsSync(sandbox) }, null, 2))
}
if (failure) throw new Error(failure)
console.log(JSON.stringify({ verdict: "PASS", checks: checks.length, evidence }, null, 2))
