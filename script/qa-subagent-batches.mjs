import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"

const root = resolve(new URL("..", import.meta.url).pathname)
const evidence = resolve(process.argv[2] ?? join(root, ".iolaus/evidence/subagent-batch-grouping/live"))
assert.ok(evidence.startsWith(`${root}/.iolaus/evidence/`))
mkdirSync(evidence, { recursive: true })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-batches-")))
const home = join(sandbox, "home"), config = join(sandbox, "config"), project = join(sandbox, "project"), pkg = join(sandbox, "plugin"), probe = join(sandbox, "probe")
for (const dir of [home, project, pkg, probe, join(home, ".iolaus"), join(config, "opencode")]) mkdirSync(dir, { recursive: true })
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const trace = join(evidence, "trace.ndjson"), hooks = join(evidence, "hooks.ndjson"), routes = join(evidence, "routes.ndjson")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const until = async (read, label, timeout = 40000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = read(); if (value) return value; await sleep(100) }
  throw new Error(`timeout: ${label}`)
}
const hostPaths = [join(homedir(), ".iolaus/iolaus.json"), join(homedir(), ".config/opencode/opencode.json")]
const hostState = () => hostPaths.map((path) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent")
const before = hostState(), checks = [], isolation = [], requests = []
const plan = (steps) => `QA_PLAN:${Buffer.from(JSON.stringify(steps)).toString("base64")}`
const native = (description, prompt = "CHILD_OK", extra = {}) => ({ name: "subagent", args: { agent: "quick", description, prompt, ...extra } })
const events = (id, calls) => {
  const result = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } }]
  if (calls?.length) calls.forEach((call, index) => {
    const item = `${id}_${index}`, args = JSON.stringify(call.args)
    result.push({ type: "response.output_item.added", output_index: index, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: item, output_index: index, delta: args },
      { type: "response.output_item.done", output_index: index, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: args, status: "completed" } })
  })
  else result.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id } }, { type: "response.output_text.delta", item_id: id, output_index: 0, delta: "QA_DONE" }, { type: "response.output_item.done", output_index: 0, item: { type: "message", id } })
  result.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  return result
}
const mock = http.createServer(async (req, res) => {
  if (req.url !== "/v1/responses" || req.method !== "POST") return res.writeHead(404).end()
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString()), input = body.input ?? []
  const lastUser = input.findLastIndex((item) => item.type === "message" && item.role === "user" && !/Iolaus Flow notice|<subagent /.test(JSON.stringify(item)))
  const text = JSON.stringify(input[lastUser] ?? "")
  if (body.tools?.length && text.includes("CHILD_FAIL")) return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "QA old failed batch", type: "invalid_request_error", code: "invalid_api_key" } }))
  const encoded = text.match(/QA_PLAN:([A-Za-z0-9+/=]+)/)?.[1]
  const outputs = input.slice(lastUser).filter((item) => item.type === "function_call_output")
  let calls
  if (body.tools?.length && encoded) {
    let offset = 0
    for (const step of JSON.parse(Buffer.from(encoded, "base64").toString())) {
      if (outputs.length === offset) { calls = step; break }
      offset += step.length
    }
  }
  requests.push({ encoded, outputs: outputs.map((item) => item.output), done: !calls })
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events(`qa_${requests.length}`, calls)) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end("data: [DONE]\n\n")
})
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, PWD: project,
  XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
  OPENCODE_TEST_HOME: home, IOLAUS_HOME: join(home, ".iolaus"), IOLAUS_TRACE: trace, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
const socket = `iolaus-batches-${process.pid}`
const tmux = (...args) => spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" })
const keys = (...args) => assert.equal(tmux("send-keys", "-t", "qa:0.0", ...args).status, 0)
const screen = (name) => { const text = tmux("capture-pane", "-p", "-t", "qa:0.0").stdout; writeFileSync(join(evidence, `${name}.txt`), text); return text }
const db = join(home, ".iolaus/iolaus.db")
const sql = (query) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, query], { encoding: "utf8" }) || "[]")
const runs = () => sql("SELECT * FROM dag_runs ORDER BY created_at").map((run) => ({ ...run, definition: JSON.parse(run.definition_json) }))
const observed = () => runs().filter((run) => run.definition.observed)
const nodes = (runID) => sql(`SELECT * FROM dag_nodes WHERE run_id='${runID}'`).map((node) => ({ ...node, definition: JSON.parse(node.node_json), execution: node.execution_json && JSON.parse(node.execution_json) }))
const launch = async (owner) => {
  env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify({ plugins: [pkg, probe] })
  assert.equal(tmux("new-session", "-d", "-s", "qa", "-c", project, `${binary} --standalone${owner ? ` --session ${owner}` : ""}`).status, 0)
  tmux("resize-window", "-t", "qa", "-x", "175", "-y", "55")
  await sleep(4000)
  const panePID = Number(tmux("display-message", "-p", "-t", "qa:0.0", "#{pane_pid}").stdout.trim())
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
  const pids = [panePID]; for (const pid of pids) for (const [child, parent] of rows) if (parent === pid) pids.push(child)
  const files = spawnSync("lsof", ["-Fn", "-p", pids.join(",")], { encoding: "utf8" }).stdout.split("\n").filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line)).map((line) => line.slice(1))
  assert.ok(files.some((path) => path === join(sandbox, "data/opencode/opencode.db")))
  assert.ok(files.every((path) => path.startsWith(`${sandbox}/`)))
  isolation.push({ pids, databasePaths: [...new Set(files)] })
}
const submit = async (steps) => {
  const prompt = plan(steps), encoded = prompt.slice(8), start = requests.length
  keys("-l", prompt); keys("Enter")
  const result = await until(() => requests.slice(start).find((item) => item.encoded === encoded && item.done), "plan finished", 90000)
  await sleep(600)
  return result
}
let failure, owner
try {
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  symlinkSync(join(root, "dist"), join(pkg, "dist"), "dir")
  symlinkSync(join(root, "node_modules"), join(pkg, "node_modules"), "dir")
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "opencode-iolaus", type: "module", exports: { ".": "./dist/index.js", "./tui": "./dist/tui.js" } }))
  writeFileSync(join(probe, "package.json"), JSON.stringify({ type: "module", exports: { ".": "./index.ts", "./tui": "./tui.tsx" } }))
  writeFileSync(join(probe, "tui.tsx"), `import { Plugin } from "@opencode/plugin/tui"; import { createEffect } from "solid-js"; import { appendFileSync } from "node:fs";
export default Plugin.define({id:"qa-batch-route",setup(ctx){ctx.ui.slot({append:"app",render:()=>{createEffect(()=>appendFileSync(${JSON.stringify(routes)},JSON.stringify(ctx.ui.router.current())+"\\n"));return null}})}})`)
  writeFileSync(join(probe, "index.ts"), `import { Plugin } from "@opencode/plugin"; import { appendFileSync } from "node:fs";
export default Plugin.define({id:"qa-batch-probe",async setup(ctx){await ctx.tool.hook("execute.before",async event=>{if(event.tool!=="subagent")return;const messages=await ctx.session.context({sessionID:event.sessionID});appendFileSync(${JSON.stringify(hooks)},JSON.stringify({id:event.id,sessionID:event.sessionID,messageID:event.messageID,messages:messages.map(({id,type})=>({id,type}))})+"\\n")});await ctx.tool.transform(editor=>editor.add({name:"qa_queue",description:"Queue QA input",options:{codemode:false},input:{type:"object",properties:{prompt:{type:"string"}},required:["prompt"]},execute:async(input,context)=>{await ctx.session.prompt({sessionID:context.sessionID,text:input.prompt,delivery:"queue"});return {content:"queued"}}}))}})`)
  const model = "openai/gpt-5.5"
  writeFileSync(join(home, ".iolaus/iolaus.json"), JSON.stringify({ mcps: [], gh: false, astGrep: false, verify: false, models: { categories: { quick: model } } }))
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({ plugins: [{ package: join(pkg, "dist") }, probe], model, experimental: { subagent_depth: 4 }, permissions: [{ action: "*", resource: "*", effect: "allow" }],
    provider: { openai: { options: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } } }))
  await launch()
  await submit([[native("Old failure", "CHILD_FAIL")]])
  const old = observed()[0]; assert.equal(old.status, "failed"); assert.equal(old.definition.observedBatch.kind, "request"); owner = old.owner_session_id
  const steps = [[native("Work 1"), native("Work 2")], ...Array.from({ length: 10 }, (_, index) => [native(`Work ${index + 3}`)])]
  await submit(steps)
  assert.equal(observed().length, 2)
  const fresh = observed()[1]; assert.equal(fresh.status, "completed"); assert.equal(fresh.definition.nodes.length, 12)
  assert.deepEqual(fresh.definition.nodes.map((node) => node.id), Array.from({ length: 12 }, (_, index) => `${index + 1}-work-${index + 1}`))
  assert.equal(runs().find((run) => run.run_id === old.run_id).status, "failed")
  assert.notEqual(fresh.definition.observedBatch.id, old.definition.observedBatch.id)
  screen("separate-requests")
  keys("C-x", "d"); await sleep(700)
  const orderedScreen = screen("twelve-node-details")
  assert.ok(orderedScreen.indexOf("1-work-1") < orderedScreen.indexOf("2-work-2"))
  assert.ok(orderedScreen.indexOf("2-work-2") < orderedScreen.indexOf("10-work-10"))
  keys("Escape"); await sleep(600)
  assert.equal(JSON.parse(readFileSync(routes, "utf8").trim().split("\n").at(-1)).sessionID, owner)
  checks.push("One real user request: 2 parallel + 10 sequential calls share one request batch; next request isolates old failure/count/time; stable 1..12 definition order")
  const child = nodes(fresh.run_id).find((node) => node.node_id === "1-work-1").execution.sessionID
  const nestedPrompt = plan([[native("Grandchild")]])
  await submit([[native("Native parent", nestedPrompt)], [native("Independent")]])
  const nested = observed().at(-1); assert.equal(nodes(nested.run_id).length, 3)
  assert.equal(nodes(nested.run_id).filter((node) => node.definition.dependsOn.length === 1).length, 1)
  checks.push("Native nesting inherits exact observed run and local parent edge")
  assert.deepEqual(nested.definition.nodes.map((node) => node.id), ["1-native-parent", "2-grandchild", "3-independent"])
  keys("C-x", "d"); await sleep(800)
  const mixedScreen = screen("mixed-calls-parent")
  const cardRow = mixedScreen.split("\n").find((line) => line.includes("1-native-parent") && line.includes("2-grandchild") && line.includes("3-independent"))
  assert.ok(cardRow, "mixed calls must share a chronological card row")
  assert.ok(cardRow.indexOf("1-native-parent") < cardRow.indexOf("2-grandchild") && cardRow.indexOf("2-grandchild") < cardRow.indexOf("3-independent"))
  assert.doesNotMatch(mixedScreen, /▼|Depends on:|Unblocks:/)
  assert.match(mixedScreen, /Child calls: 2-grandchild/)
  keys("j"); await sleep(400)
  const childScreen = screen("mixed-calls-child")
  assert.match(childScreen.split("Node details")[1], /2-grandchild/)
  assert.match(childScreen, /Parent call: 1-native-parent/)
  assert.doesNotMatch(childScreen, /Parent call: 3-independent|▼/)
  keys("j"); await sleep(400)
  const independentScreen = screen("mixed-calls-independent")
  assert.match(independentScreen.split("Node details")[1], /3-independent/)
  assert.match(independentScreen, /Parent call: none \(root call\)/)
  assert.match(independentScreen, /Child calls: none/)
  keys("k"); await sleep(400)
  assert.match(screen("mixed-calls-child-reselected").split("Node details")[1], /2-grandchild/)
  keys("Enter"); await sleep(600)
  screen("mixed-calls-exact-child-opened")
  const mixedRoute = JSON.parse(readFileSync(routes, "utf8").trim().split("\n").at(-1))
  assert.equal(mixedRoute.sessionID, nodes(nested.run_id).find((node) => node.node_id === "2-grandchild").execution.sessionID)
  checks.push("Mixed root/child/root TUI: chronological cards and j/j/k selection; no wave arrows or false sibling links; actual parent/child identities; Enter opens exact nested child")
  tmux("kill-session", "-t", "qa"); await sleep(1200); await launch(owner)
  const flow = (name) => ({ name: "iolaus_flow", args: { action: "create", definition: { schemaVersion: 1, name, nodes: [{ id: "work", agent: "quick", prompt: plan([[native(`${name} child`, nestedPrompt)]]), dependsOn: [] }] } } })
  await submit([[flow("Source A"), flow("Source B")]])
  await until(() => runs().filter((run) => !run.definition.observed && run.status === "completed").length === 2, "both source flows")
  const sources = runs().filter((run) => !run.definition.observed)
  for (const source of sources) {
    const batch = observed().find((run) => run.definition.observedBatch?.id === source.run_id)
    assert.ok(batch); assert.equal(batch.definition.observedBatch.kind, "flow"); assert.equal(nodes(batch.run_id).length, 2)
    assert.equal(source.definition.nodes.length, 1)
    for (const node of nodes(batch.run_id)) for (const parent of node.definition.dependsOn) assert.ok(nodes(batch.run_id).some((candidate) => candidate.node_id === parent))
  }
  checks.push("Two scheduled flows keep distinct observed batches, including nested descendants; scheduled definitions unchanged; no cross-group edges")
  screen("scheduled-batches")
  tmux("kill-session", "-t", "qa"); await sleep(1200); await launch(owner)
  await submit([[native("Later followup", plan([[native("After reload descendant")]]), { sessionID: child })]])
  assert.equal(nodes(fresh.run_id).find((node) => node.node_id === "1-work-1").attempt, 2)
  assert.equal(nodes(fresh.run_id).length, 13)
  assert.equal(observed().length, 5)
  checks.push("Host restart/reload: later-request explicit native followup reopens original node, descendant inherits original batch, no new followup batch")
  const scheduledChild = nodes(sources[0].run_id)[0].execution.sessionID
  const countBefore = observed().length
  const refused = await submit([[native("Forbidden flow followup", "No", { sessionID: scheduledChild })]])
  assert.match(JSON.stringify(refused.outputs), /scheduler-owned/); assert.equal(observed().length, countBefore)
  checks.push("Scheduled continuation guard still refuses before observation")
  const queuedPrompt = plan([[native("Queued request child")]])
  const queuedResult = await submit([[{ name: "qa_queue", args: { prompt: queuedPrompt } }], [native("Before queued delivery")]])
  assert.match(JSON.stringify(queuedResult.outputs[0]), /queued/)
  await until(() => observed().some((run) => run.definition.nodes.some((node) => node.title === "Queued request child") && run.status === "completed"), "queued input delivered")
  const beforeQueue = observed().find((run) => run.definition.nodes.some((node) => node.title === "Before queued delivery"))
  const afterQueue = observed().find((run) => run.definition.nodes.some((node) => node.title === "Queued request child"))
  assert.ok(beforeQueue); assert.ok(afterQueue); assert.notEqual(beforeQueue.run_id, afterQueue.run_id)
  assert.equal(beforeQueue.definition.observedBatch.kind, "request"); assert.equal(afterQueue.definition.observedBatch.kind, "request")
  checks.push("Prompt admitted to queue during current execution does not steal its next sequential call; delivered queued user input creates a separate batch")
  execFileSync("sqlite3", [db, `INSERT INTO dag_runs SELECT 'legacy-batch',project,owner_session_id,name,json_remove(definition_json,'$.observedBatch'),fingerprint,generation,status,created_at-111600000,${Date.now()} FROM dag_runs WHERE run_id='${old.run_id}'; INSERT INTO dag_nodes SELECT 'legacy-batch',node_id,node_json,fingerprint,status,attempt,result_json,error,NULL,created_at-111600000,updated_at-111600000 FROM dag_nodes WHERE run_id='${old.run_id}';`])
  const legacyBefore = runs().find((run) => run.run_id === "legacy-batch")
  tmux("kill-session", "-t", "qa"); await sleep(1200); await launch(owner)
  await submit([[native("New after legacy")]])
  assert.equal(nodes("legacy-batch").length, 1)
  assert.equal(runs().find((run) => run.run_id === "legacy-batch").definition.observedBatch, undefined)
  assert.deepEqual(runs().find((run) => run.run_id === "legacy-batch"), legacyBefore)
  assert.match(screen("historical-label"), /Calls.*historical aggregate/)
  checks.push("Seeded isolated legacy unkeyed aggregate retained without reassignment or append")
  const hookRows = readFileSync(hooks, "utf8").trim().split("\n").map(JSON.parse)
  assert.ok(hookRows.every((row) => row.messages.some((message) => message.id === row.messageID && message.type === "assistant")))
  checks.push("Real 2.2 tool hooks expose current assistant in delivered context; persisted user IDs used instead of admission or assistant IDs")
  writeFileSync(join(evidence, "groups.json"), JSON.stringify(runs().map((run) => ({ id: run.run_id, source: run.definition.observedBatch, observed: !!run.definition.observed, status: run.status, created: run.created_at, updated: run.updated_at, nodes: run.definition.nodes.map((node) => ({ id: node.id, parents: node.dependsOn })) })), null, 2))
  keys("C-x", "d"); await sleep(800)
  assert.match(screen("batch-details"), /Calls.*request/)
  keys("Enter"); await sleep(600)
  assert.doesNotMatch(screen("direct-child-opened"), /Node details/)
  const lastRoute = JSON.parse(readFileSync(routes, "utf8").trim().split("\n").at(-1))
  const newest = observed().find((run) => run.definition.nodes.some((node) => node.title === "New after legacy"))
  assert.equal(lastRoute.sessionID, nodes(newest.run_id)[0].execution.sessionID)
  checks.push("Real TUI labels historical aggregate and Calls/request details, renders 1..12 order; Enter still navigates exact direct child")
} catch (error) { failure = String(error.stack ?? error); screen("failure") }
finally {
  tmux("kill-server"); await sleep(800)
  mock.closeAllConnections(); await new Promise((done) => mock.close(done))
  const remaining = spawnSync("pgrep", ["-f", sandbox], { encoding: "utf8" }).stdout.trim()
  assert.equal(remaining, "", "sandbox processes leaked"); assert.deepEqual(hostState(), before)
  rmSync(sandbox, { recursive: true, force: true })
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ verdict: failure ? "FAIL" : "PASS", failure, version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), checks, isolation, hostConfigUnchanged: JSON.stringify(before) === JSON.stringify(hostState()), remainingSandboxProcesses: remaining, sandboxRemoved: !existsSync(sandbox) }, null, 2))
}
if (failure) throw new Error(failure)
console.log(JSON.stringify({ verdict: "PASS", checks: checks.length, evidence }, null, 2))
