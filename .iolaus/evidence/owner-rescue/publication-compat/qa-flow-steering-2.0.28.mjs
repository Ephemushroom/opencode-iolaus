import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"

const root = "/Users/Bryan/.local/share/opencode/worktree/c1d0b7/flow-owner-rescue"
const evidence = resolve(process.argv[2] ?? join(root, ".iolaus/evidence/owner-rescue/publication-compat/live-matrix-2.0.28"))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence")}/`))
mkdirSync(evidence, { recursive: false })
let sandbox, home, project, config, iolaus, localPackage, env, server, exited, serverError, version, sdk
let log = "", failure, databasePaths = [], api, owner
const cleanupErrors = []
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const requests = [], checks = [], errors = [], holds = new Map(), released = new Set()
function hostState() {
  const paths = [join(homedir(), ".iolaus/iolaus.json"), join(homedir(), ".config/opencode/opencode.json"), join(homedir(), ".config/opencode/opencode.jsonc")]
  return Object.fromEntries(paths.map((path) => [path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent"]))
}
const before = hostState()
async function until(read, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(40) }
  throw new Error(`timeout: ${label}`)
}
async function hold(key) {
  if (released.has(key)) return
  await new Promise((done) => { const waiting = holds.get(key) ?? []; waiting.push(done); holds.set(key, waiting) })
}
function release(key) { released.add(key); for (const done of holds.get(key) ?? []) done(); holds.delete(key) }
function events(id, text, call) {
  const result = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } }]
  if (call) {
    const args = JSON.stringify(call.args)
    result.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id, call_id: id, name: call.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id, call_id: id, name: call.name, arguments: args, status: "completed" } })
  } else result.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id } },
    { type: "response.output_text.delta", item_id: id, output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id } })
  result.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  return result
}
const mock = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") return response.writeHead(404).end()
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()), input = body.input ?? []
    const lastUser = input.findLastIndex((item) => item.type === "message" && item.role === "user" && !/Iolaus Flow notice|<subagent /.test(JSON.stringify(item)))
    const last = JSON.stringify(input[lastUser] ?? ""), all = JSON.stringify(input)
    const command = last.match(/QA_COMMAND:([A-Za-z0-9+/=]+)/)?.[1]
    const first = JSON.stringify(input.find((item) => item.type === "message" && item.role === "user") ?? "")
    const marker = body.tools?.length && !command ? first.match(/QA_CHILD:([a-z0-9-]+)/)?.[1] : undefined
    const record = { sequence: requests.length, at: Date.now(), model: body.model, instructions: body.instructions ?? "", input, marker, command }
    requests.push(record); appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(record) + "\n")
    assert.ok(requests.length < 220, "unexpected provider loop")
    let text = "QA_TITLE", call
    if (body.tools?.length && command) {
      const outputs = input.slice(lastUser).filter((item) => item.type === "function_call_output")
      if (!outputs.length) call = JSON.parse(Buffer.from(command, "base64").toString())
      text = "QA_OWNER_AVAILABLE"
    } else if (marker) {
      const supplement = all.includes("QA_SUPPLEMENT")
      record.supplement = supplement
      await hold(`${marker}:${supplement ? "new" : "old"}`)
      text = supplement ? `NEW_RESULT_${marker}` : `OLD_RESULT_${marker}`
    } else if (last.includes("QA_OWNER_HOLD")) { await hold("owner"); text = "OWNER_HOLD_DONE" }
    else if (first.includes("QA_DOWNSTREAM")) text = "DOWNSTREAM_OK"
    else if (first.includes("QA_OBSERVED")) { await hold("observed"); text = "OBSERVED_DONE" }
    else if (first.includes("QA_PLANNING")) { await hold("planning"); text = "PLANNING_DONE" }
    else if (first.includes("QA_JUDGE")) { await hold("judge"); text = "VERDICT: PASS" }
    else if (first.includes("<iolaus-plan-ticket")) { await hold("atlas-ticket"); text = "TICKET_DONE" }
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of events(`qa_${record.sequence}`, text, call)) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) { errors.push(String(error.stack ?? error)); response.writeHead(500).end() }
})
const model = "openai/gpt-5.5"
const passed = (name, detail = {}) => { checks.push({ name, verdict: "PASS", ...detail }); writeFileSync(join(evidence, "assertions.json"), JSON.stringify(checks, null, 2)) }
const node = (id, marker, dependsOn = []) => ({ id, title: id, agent: "visual-engineering", model, prompt: `QA_CHILD:${marker}`, dependsOn })
try {
  sandbox = mkdtempSync(join(tmpdir(), "iolaus-steering-qa-"))
  sandbox = realpathSync(sandbox)
  home = join(sandbox, "home"); project = join(sandbox, "project"); config = join(sandbox, "config"); iolaus = join(home, ".iolaus")
  localPackage = join(sandbox, "plugin")
  env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, IOLAUS_HOME: iolaus,
    IOLAUS_TRACE: join(evidence, "trace.ndjson"), XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"), OPENCODE_TEST_HOME: home,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
  for (const path of [home, project, join(config, "opencode"), iolaus, localPackage]) mkdirSync(path, { recursive: true })
  cpSync(join(root, "dist"), join(localPackage, "dist"), { recursive: true })
  symlinkSync(join(root, "node_modules"), join(localPackage, "node_modules"), "dir")
  writeFileSync(join(localPackage, "package.json"), JSON.stringify({ name: "opencode-iolaus", type: "module", main: "./dist/index.js" }))
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  writeFileSync(join(iolaus, "iolaus.json"), JSON.stringify({ mcps: [], gh: false, astGrep: false, verify: false,
    models: { agents: { sisyphus: model, prometheus: model, atlas: model, momus: model }, categories: { "visual-engineering": model } } }))
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({ plugins: [{ package: join(localPackage, "dist") }], model, default_agent: "build",
    permissions: [{ action: "*", resource: "*", effect: "allow" }], provider: { openai: { options: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/v1` },
      models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } } }))
  version = execFileSync(binary, ["--version"], { env, cwd: project, encoding: "utf8" }).trim()
  sdk = JSON.parse(readFileSync(join(root, "package.json"))).peerDependencies["@opencode/plugin"]
  assert.equal(version, "opencode v2.0.28")
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  exited = new Promise((done) => {
    server.once("exit", done)
    server.once("error", (error) => { serverError = error; done() })
  })
  server.stdout.on("data", (data) => { log += data }); server.stderr.on("data", (data) => { log += data })
  const base = await until(() => { if (serverError) throw serverError; return log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] }, "server")
  const password = await until(() => log.match(/server password (\S+)/)?.[1], "password")
  api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(35000), headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text(); assert.ok(response.ok, `${response.status}: ${text}`); return text ? JSON.parse(text) : undefined
  }
  const session = async (agent = "build") => (await api("POST", "/api/session", { agent, model: { providerID: "openai", id: "gpt-5.5" }, location: { directory: project } })).data.id
  const wait = (id) => api("POST", `/api/experimental/session/${id}/wait`)
  const context = async (id) => (await api("GET", `/api/session/${id}/context`)).data
  const inbox = async (id) => (await api("GET", `/api/session/${id}/inbox`)).data
  const command = async (id, args, name = "iolaus_flow") => {
    const encoded = Buffer.from(JSON.stringify({ name, args })).toString("base64")
    await api("POST", `/api/session/${id}/prompt`, { text: `QA_COMMAND:${encoded}` }); await wait(id)
    const request = requests.findLast((item) => item.command === encoded && item.input.some((entry) => entry.type === "function_call_output"))
    if (!request) {
      const messages = await context(id)
      throw new Error(`no tool receipt: ${JSON.stringify(messages).slice(-3000)}`)
    }
    const output = request.input.filter((entry) => entry.type === "function_call_output").at(-1).output
    try { return JSON.parse(output) } catch { return { error: output } }
  }
  const runs = async (id = owner) => (await api("POST", `/api/rpc/iolaus-dag/snapshot?location[directory]=${encodeURIComponent(project)}`, { input: { sessionID: id } })).output.runs
  const run = async (runID) => (await runs()).find((item) => item.runID === runID)
  const create = async (name, nodes) => {
    const result = await command(owner, { action: "create", definition: { schemaVersion: 1, name, nodes } })
    assert.ok(result.runID, JSON.stringify(result)); return result
  }
  const steer = (runID, nodeID, requestID, id = owner, text = "QA_SUPPLEMENT Fontsource") => command(id, { action: "steer", run_id: runID, node_id: nodeID, request_id: requestID, text })
  const admittedSupplements = async () => {
    const ids = [...new Set((await runs()).flatMap((value) => value.nodes.map((item) => item.sessionID)).filter((id) => id?.startsWith("ses")))]
    let total = 0
    for (const id of ids) {
      total += (await context(id)).filter((item) => item.type === "synthetic" && item.text?.includes("QA_SUPPLEMENT")).length
      total += (await inbox(id)).filter((item) => item.type === "synthetic" && item.payload.text?.includes("QA_SUPPLEMENT")).length
    }
    return total
  }
  const reject = async (label, action, pattern) => {
    const sent = requests.filter((item) => item.supplement).length
    const admitted = await admittedSupplements()
    const receipt = await action(); assert.match(typeof receipt.error === "string" ? receipt.error : JSON.stringify(receipt.error ?? receipt), pattern)
    assert.equal(requests.filter((item) => item.supplement).length, sent, "refused input reached provider")
    assert.equal(await admittedSupplements(), admitted, "refused input reached host inbox/context")
    passed(label, { receipt, supplementalHostMessages: admitted })
  }
  owner = await session("sisyphus")
  const first = await create("interactive", [node("implement", "interactive"), { id: "after", title: "consume new result", agent: "visual-engineering", model, prompt: "QA_DOWNSTREAM", dependsOn: ["implement"], inputs: [{ node: "implement" }] }])
  await until(() => requests.some((item) => item.marker === "interactive"), "child request")
  assert.equal((await run(first.runID)).status, "running")
  const infoBefore = (await api("GET", `/api/session/${(await run(first.runID)).nodes.find((item) => item.id === "implement").sessionID}`)).data
  await api("POST", `/api/session/${owner}/prompt`, { text: "QA_OWNER_HOLD unrelated conversation" })
  await until(() => holds.has("owner"), "owner active turn")
  await api("POST", `/api/session/${owner}/interrupt`, { resume: false }); await wait(owner); release("owner")
  assert.equal((await run(first.runID)).status, "running")
  passed("owner turn ends, new turn is interactive, interruption leaves child running")
  const receipt = await steer(first.runID, "implement", "interactive-request")
  assert.equal(receipt.state, "admitted", JSON.stringify(receipt))
  assert.equal((await steer(first.runID, "implement", "interactive-request")).messageID, receipt.messageID)
  await reject("request id cannot change text", () => steer(first.runID, "implement", "interactive-request", owner, "different"), /different steering request/)
  release("interactive:old")
  await until(() => requests.some((item) => item.marker === "interactive" && item.supplement), "supplement provider request")
  await sleep(200)
  assert.equal((await run(first.runID)).nodes.find((item) => item.id === "after").status, "pending")
  release("interactive:new")
  const completed = await until(async () => { const value = await run(first.runID); return value.status === "completed" && value }, "new result downstream")
  const downstream = requests.find((item) => JSON.stringify(item.input.find((entry) => entry.type === "message" && entry.role === "user")).includes("QA_DOWNSTREAM"))
  assert.match(JSON.stringify(downstream.input), /NEW_RESULT_interactive/)
  assert.doesNotMatch(JSON.stringify(downstream.input), /OLD_RESULT_interactive/)
  const infoAfter = (await api("GET", `/api/session/${infoBefore.id}`)).data
  assert.equal(infoAfter.agent, infoBefore.agent); assert.deepEqual(infoAfter.model, infoBefore.model)
  const childContext = await context(infoBefore.id)
  assert.equal(childContext.filter((item) => item.id === receipt.messageID).length, 1)
  writeFileSync(join(evidence, "identity-ordering.json"), JSON.stringify({ infoBefore, infoAfter, receipt, childContext, completed }, null, 2))
  passed("same agent/model, one supplement, stale idle/result fenced from downstream")
  await until(async () => (await inbox(owner)).some((item) => item.payload?.metadata?.iolaus_dag_run === first.runID), "queued terminal notice")
  const terminalCount = requests.length; await sleep(250); assert.equal(requests.length, terminalCount)
  passed("terminal notice present in inbox without an owner provider turn")
  await reject("settled target", () => steer(first.runID, "implement", "settled"), /active flow|running node/)
  const gate = await create("human gate", [node("before", "gate-before"), { id: "gate", title: "human decision", kind: "gate", prompt: "Do not approve automatically", dependsOn: ["before"] }, node("pending", "pending", ["gate"])])
  await until(() => holds.has("gate-before:old"), "before gate child"); release("gate-before:old")
  await until(async () => (await run(gate.runID)).status === "paused", "gate")
  await until(async () => (await inbox(owner)).some((item) => item.payload?.metadata?.iolaus_dag_run === gate.runID), "queued gate notice")
  const noticesBefore = (await inbox(owner)).filter((item) => item.payload?.metadata?.iolaus_flow_notice)
  assert.ok(noticesBefore.length > 0)
  const count = requests.length; await sleep(350); assert.equal(requests.length, count)
  assert.equal((await run(gate.runID)).status, "paused")
  await api("POST", "/api/location/reload")
  const noticesAfter = (await inbox(owner)).filter((item) => item.payload?.metadata?.iolaus_flow_notice)
  assert.deepEqual(noticesAfter.map((item) => item.id), noticesBefore.map((item) => item.id))
  assert.equal((await run(gate.runID)).status, "paused")
  passed("gate/terminal notices queue without owner wake, reload dedupes, gate stays human-controlled", { noticeIDs: noticesAfter.map((item) => item.id) })
  await reject("gate target", () => steer(gate.runID, "gate", "gate"), /gate or judge/)
  await reject("pending initial target", () => steer(gate.runID, "pending", "pending"), /pending/)
  await command(owner, { action: "reject", run_id: gate.runID, node_id: "gate", note: "explicit QA human rejection" })
  const foreign = await session()
  const active = await create("refusals", [node("implement", "refusals")])
  await until(() => holds.has("refusals:old"), "refusal child")
  await reject("foreign owner", () => steer(active.runID, "implement", "foreign", foreign), /owner|owned|session/)
  const sibling = await create("sibling", [node("implement", "sibling")])
  await until(() => holds.has("sibling:old"), "sibling child")
  const siblingID = (await run(sibling.runID)).nodes[0].sessionID
  await api("POST", `/api/session/${siblingID}/interrupt`, { resume: false }); release("sibling:old"); await wait(siblingID)
  await reject("sibling child cannot steer foreign flow", () => steer(active.runID, "implement", "sibling", siblingID), /owner|owned|session/)
  await api("POST", `/api/session/${owner}/agent`, { agent: "prometheus" })
  await reject("planning owner", () => steer(active.runID, "implement", "planner"), /planner|Planner|planning|Planning/)
  await command(owner, { agent: "visual-engineering", description: "planning child", prompt: "QA_PLANNING", background: true }, "subagent")
  await until(() => holds.has("planning"), "inherited planning child")
  const planning = (await runs()).find((item) => item.name === "Subagent calls")
  const planningID = planning.nodes.find((item) => item.status === "running").sessionID
  release("planning"); await wait(planningID)
  await api("POST", `/api/session/${planningID}/agent`, { agent: "sisyphus" })
  await reject("inherited planning role survives switch to worker", () => steer(active.runID, "implement", "planning-to-worker", planningID), /planning|Planning/)
  await api("POST", `/api/session/${owner}/agent`, { agent: "sisyphus" })
  const observedResult = await command(owner, { agent: "visual-engineering", description: "observed child", prompt: "QA_OBSERVED", background: true }, "subagent")
  await until(() => holds.has("observed"), "observed child")
  const observed = (await runs()).find((item) => item.name === "Subagent calls")
  assert.ok(observed, JSON.stringify({ observedResult, runs: await runs() }))
  await reject("observed native target", () => steer(observed.runID, observed.nodes[0].id, "observed"), /observed/)
  const judge = await create("judge", [{ id: "judge", title: "judge", kind: "judge", agent: "momus", model, prompt: "QA_JUDGE", dependsOn: [] }])
  await until(() => holds.has("judge"), "judge request")
  await reject("judge target", () => steer(judge.runID, "judge", "judge"), /gate or judge/)
  release("judge"); release("observed"); release("refusals:old")
  passed("authorization refusals precede supplemental host/provider admission")
  const reload = await create("lost receipt reload", [node("implement", "reload"), { id: "after", title: "after", agent: "visual-engineering", model, prompt: "QA_DOWNSTREAM reload", dependsOn: ["implement"], inputs: [{ node: "implement" }] }])
  await until(() => holds.has("reload:old"), "reload child")
  const reloadReceipt = await steer(reload.runID, "implement", "reload-request")
  release("reload:old")
  await until(() => holds.has("reload:new"), "reload supplement")
  const db = join(iolaus, "iolaus.db")
  execFileSync("sqlite3", [db, "UPDATE dag_steering SET value_json=json_remove(json_set(value_json,'$.state','reserved'),'$.receipt') WHERE request_id='reload-request'"])
  await api("POST", "/api/location/reload")
  assert.equal((await steer(reload.runID, "implement", "reload-request")).messageID, reloadReceipt.messageID)
  release("reload:old"); release("reload:new")
  await until(async () => (await run(reload.runID)).status === "completed", "reload recovered result")
  const recoveredContext = await context((await run(reload.runID)).nodes.find((item) => item.id === "implement").sessionID)
  assert.equal(recoveredContext.filter((item) => item.id === reloadReceipt.messageID).length, 1)
  assert.equal(requests.filter((item) => item.marker === "reload" && item.supplement).length, 1)
  passed("lost Flow acknowledgement reconciles real host id after reload without replay", { faultInjection: "sandbox-only steering receipt reset to reserved", messageID: reloadReceipt.messageID })
  const cancel = await create("cancel race", [node("implement", "cancel")])
  await until(() => holds.has("cancel:old"), "cancel child")
  const racing = steer(cancel.runID, "implement", "cancel-request")
  await racing; release("cancel:old")
  await until(() => holds.has("cancel:new"), "cancel supplement admitted")
  const cancelled = command(owner, { action: "cancel", run_id: cancel.runID })
  await racing; await cancelled; release("cancel:old"); release("cancel:new")
  assert.equal((await run(cancel.runID)).status, "cancelled")
  await reject("steered execution cannot retry", () => command(owner, { action: "retry", run_id: cancel.runID }), /steered execution/)
  await reject("steered execution cannot resume", () => command(owner, { action: "resume", run_id: cancel.runID }), /steered execution/)
  await api("POST", "/api/location/reload")
  assert.equal((await run(cancel.runID)).status, "cancelled")
  passed("cancel/admission race and reload cannot publish late result or retry supplement")
  const native = await session()
  const atlas = await command(native, { action: "create", definition: { schemaVersion: 1, name: "Atlas target", nodes: [{ ...node("atlas", "atlas"), agent: "atlas" }] } })
  assert.ok(atlas.runID, JSON.stringify(atlas))
  await until(() => holds.has("atlas:old"), "Atlas target")
  await reject("Atlas-containing flow", () => steer(atlas.runID, "atlas", "atlas", native), /Atlas/)
  await command(native, { action: "cancel", run_id: atlas.runID }); release("atlas:old")
  mkdirSync(join(project, ".iolaus/plans/live/tickets"), { recursive: true })
  writeFileSync(join(project, ".iolaus/plans/live/spec.md"), "# Live\nProblem: verify authorization. Solution: hold a mock ticket.\n")
  writeFileSync(join(project, ".iolaus/plans/live/tickets/01-live.md"), "# 01: Live QA\n\n**Blocked by:** None\n\n- [ ] Mock QA result exists\n")
  const atlasOwner = await session("atlas")
  await api("POST", `/api/session/${atlasOwner}/prompt`, { text: "/start-work live" }); await wait(atlasOwner)
  await until(() => holds.has("atlas-ticket"), "authorized Atlas ticket")
  const authorized = (await runs(atlasOwner))[0]
  const ticket = authorized.nodes.find((item) => item.agent === "atlas" && item.status === "running")
  await reject("authorized-plan owner", () => steer(authorized.runID, ticket.id, "authorized", atlasOwner), /Atlas|authorized/)
  await api("POST", `/api/session/${atlasOwner}/agent`, { agent: "build" })
  await reject("authorized plan survives owner agent switch", () => steer(authorized.runID, ticket.id, "authorized-worker", atlasOwner), /Atlas|authorized/)
  await command(atlasOwner, { action: "cancel", run_id: authorized.runID }); release("atlas-ticket")
  const retry = await create("unsteered retry", [node("implement", "retry")])
  await until(() => holds.has("retry:old"), "retry first child")
  const retryBefore = (await command(owner, { action: "snapshot", run_id: retry.runID })).run.nodes[0]
  await command(owner, { action: "cancel", run_id: retry.runID })
  await command(owner, { action: "retry", run_id: retry.runID, node_id: "implement" })
  await until(() => requests.filter((item) => item.marker === "retry").length === 2, "retry second child")
  const retryAfter = (await command(owner, { action: "snapshot", run_id: retry.runID })).run.nodes[0]
  assert.notEqual(retryAfter.runtime.identity.token, retryBefore.runtime.identity.token)
  assert.notEqual(retryAfter.execution.sessionID, retryBefore.execution.sessionID)
  release("retry:old")
  await until(async () => (await run(retry.runID)).status === "completed", "retry completed")
  passed("unsteered retry allocates a fresh child and execution token", { before: retryBefore.execution, after: retryAfter.execution })
  const notification = await create("notice lost ack", [{ id: "gate", title: "gate", kind: "gate", prompt: "explicit human only", dependsOn: [] }])
  await until(async () => (await run(notification.runID)).status === "paused", "notice gate")
  const notificationSnapshot = await command(owner, { action: "snapshot", run_id: notification.runID })
  const notice = notificationSnapshot.notices[0]
  assert.equal(notice.state, "admitted")
  execFileSync("sqlite3", [db, `UPDATE dag_notices SET value_json=json_set(value_json,'$.state','reserved') WHERE run_id='${notification.runID}'`])
  await api("POST", "/api/location/reload")
  const afterNotice = await command(owner, { action: "snapshot", run_id: notification.runID })
  assert.equal(afterNotice.notices[0].state, "admitted")
  assert.equal((await context(owner)).filter((item) => item.id === notice.messageID).length, 1)
  assert.equal((await run(notification.runID)).status, "paused")
  passed("lost notification acknowledgement reconciles stable host id and never approves gate", { messageID: notice.messageID, faultInjection: "sandbox-only notice state reset to reserved" })
  await command(owner, { action: "reject", run_id: notification.runID, node_id: "gate", note: "explicit human decision" })
  const direct = await create("direct child API input", [node("implement", "direct")])
  await until(() => holds.has("direct:old"), "direct child")
  const directID = (await run(direct.runID)).nodes[0].sessionID
  const directBefore = (await api("GET", `/api/session/${directID}`)).data
  await api("POST", `/api/session/${directID}/prompt`, { text: "DIRECT_CHILD_INPUT consider Fontsource", delivery: "steer" })
  release("direct:old")
  await until(async () => (await run(direct.runID)).status === "completed", "direct child completion")
  const directAfter = (await api("GET", `/api/session/${directID}`)).data
  assert.equal(directAfter.agent, directBefore.agent); assert.deepEqual(directAfter.model, directBefore.model)
  writeFileSync(join(evidence, "direct-child-api.json"), JSON.stringify({ before: directBefore, after: directAfter, context: await context(directID), screenshotTriggerReproduced: false }, null, 2))
  passed("direct-child API typing does not change identity; screenshot trigger not reproduced")
  const drift = await create("explicit child identity drift", [node("implement", "drift")])
  await until(() => holds.has("drift:old"), "drift child")
  const driftID = (await run(drift.runID)).nodes[0].sessionID
  await api("POST", `/api/session/${driftID}/agent`, { agent: "sisyphus" })
  const driftReceipt = await steer(drift.runID, "implement", "drift-request")
  assert.match(driftReceipt.error, /identity drift/)
  assert.equal((await api("GET", `/api/session/${driftID}`)).data.agent, "sisyphus")
  assert.equal((await context(driftID)).filter((item) => item.text?.includes("QA_SUPPLEMENT")).length, 0)
  release("drift:old")
  await until(async () => (await run(drift.runID)).status === "failed", "identity-drift finalization")
  assert.equal((await run(drift.runID)).nodes[0].result, undefined)
  passed("explicit child agent drift fails closed before supplemental admission and is not silently repaired", { receipt: driftReceipt })
  const bundlePath = join(localPackage, "dist/index.js")
  let bundle = readFileSync(bundlePath, "utf8")
  const effectName = bundle.match(/const admit = \(ref\) => (\w+)\.gen/)?.[1]
  assert.ok(effectName)
  const pauses = join(sandbox, "pauses"); mkdirSync(pauses)
  bundle = `import { existsSync as __qaExists, writeFileSync as __qaWrite } from 'node:fs';\nasync function __qaPause(key, sessionID) { const path = ${JSON.stringify(pauses)} + '/' + key; __qaWrite(path + '.hit', sessionID); while (!__qaExists(path + '.release')) await new Promise(done => setTimeout(done, 20)); }\n` + bundle
  const injections = [
    ["    pendingPrompts.delete(ref.sessionID);", `    if (ref.nodeID === 'initial-pause') yield* ${effectName}.promise(() => __qaPause('initial', ref.sessionID));\n    pendingPrompts.delete(ref.sessionID);`],
    ["    const text = assistantText(messages.slice(after + 1));", `    if (ref.nodeID === 'final-pause' && !requests.length) yield* ${effectName}.promise(() => __qaPause('final', ref.sessionID));\n    const text = assistantText(messages.slice(after + 1));`],
    ["      pendingPrompts.set(String(session.id), prompt);", `      if (input.node.id === 'starting-pause' && input.attempt === 1) yield* ${effectName}.promise(() => __qaPause('starting', String(session.id)));\n      pendingPrompts.set(String(session.id), prompt);`],
    ["      const receipt = yield* ctx.session.synthetic({", `      if (ref.nodeID === 'cancel-pause') yield* ${effectName}.promise(() => __qaPause('cancel', ref.sessionID));\n      const receipt = yield* ctx.session.synthetic({`],
    ["      const receipt = yield* ctx.session.synthetic({", `      if (ref.nodeID === 'owner-before') yield* ${effectName}.promise(() => __qaPause('owner-before', ref.sessionID));\n      const receipt = yield* ctx.session.synthetic({`],
    ["      return { messageID: String(receipt.id) };", `      if (ref.nodeID === 'owner-after') yield* ${effectName}.promise(() => __qaPause('owner-after', ref.sessionID));\n      return { messageID: String(receipt.id) };`],
  ]
  for (const [match, replacement] of injections) { assert.ok(bundle.includes(match), `QA injection seam missing: ${match}`); bundle = bundle.replace(match, replacement) }
  writeFileSync(bundlePath, bundle)
  writeFileSync(join(evidence, "fault-injection.json"), JSON.stringify({ scope: "sandbox plugin copy only, after all unmodified-plugin scenarios", effectName, injections }, null, 2))
  await api("POST", "/api/location/reload")
  const pauseHit = (key) => until(() => existsSync(join(pauses, `${key}.hit`)), `${key} pause`)
  const pauseRelease = (key) => writeFileSync(join(pauses, `${key}.release`), "release")
  const initial = await create("initial admission race", [node("initial-pause", "initial")])
  await pauseHit("initial")
  await reject("running child before initial host admission", () => steer(initial.runID, "initial-pause", "too-early"), /initial prompt admission/)
  const initialID = readFileSync(join(pauses, "initial.hit"), "utf8")
  assert.equal((await context(initialID)).filter((item) => item.type === "user").length, 0)
  pauseRelease("initial"); release("initial:old")
  await until(async () => (await run(initial.runID)).status === "completed", "initial release")
  passed("pre-initial refusal does not enter host context", { sessionID: initialID, faultInjection: "pause before initial prompt on sandbox plugin copy" })
  const starting = await create("late creation cancel retry", [node("starting-pause", "starting")])
  await pauseHit("starting")
  await reject("starting execution", () => steer(starting.runID, "starting-pause", "starting"), /starting/)
  await command(owner, { action: "cancel", run_id: starting.runID })
  await command(owner, { action: "retry", run_id: starting.runID, node_id: "starting-pause" })
  await until(() => holds.has("starting:old"), "second attempt prompt")
  pauseRelease("starting"); release("starting:old")
  await until(async () => (await run(starting.runID)).status === "completed", "late creation retry")
  const lateID = readFileSync(join(pauses, "starting.hit"), "utf8")
  assert.equal((await context(lateID)).filter((item) => item.type === "user").length, 0)
  assert.notEqual((await run(starting.runID)).nodes[0].sessionID, lateID)
  passed("cancel/retry fences late-created attempt before prompting", { lateID, faultInjection: "pause after native child creation but before runner ref publication" })
  const finalRace = await create("idle final capture race", [node("final-pause", "final"), { id: "after", title: "after", agent: "visual-engineering", model, prompt: "QA_DOWNSTREAM final", dependsOn: ["final-pause"], inputs: [{ node: "final-pause" }] }])
  await until(() => holds.has("final:old"), "final old request"); release("final:old")
  await pauseHit("final")
  const idleReceipt = await steer(finalRace.runID, "final-pause", "idle-race")
  assert.equal(idleReceipt.state, "admitted")
  await until(() => holds.has("final:new"), "idle supplement restarted same child")
  pauseRelease("final"); await sleep(150)
  assert.equal((await run(finalRace.runID)).nodes.find((item) => item.id === "after").status, "pending")
  release("final:new")
  await until(async () => (await run(finalRace.runID)).status === "completed", "idle supplement result")
  const finalDownstream = requests.find((item) => JSON.stringify(item.input.find((entry) => entry.type === "message" && entry.role === "user")).includes("QA_DOWNSTREAM final"))
  assert.match(JSON.stringify(finalDownstream.input), /NEW_RESULT_final/)
  assert.doesNotMatch(JSON.stringify(finalDownstream.input), /OLD_RESULT_final/)
  passed("accepted supplement while old result captured at idle fences downstream", { faultInjection: "pause after real host context capture before returning old result" })
  const concurrent = await create("concurrent cancel admission", [node("cancel-pause", "concurrent")])
  await until(() => holds.has("concurrent:old"), "concurrent old request")
  const admitting = steer(concurrent.runID, "cancel-pause", "concurrent-request")
  await pauseHit("cancel")
  let cancelFinished = false
  const cancelling = api("POST", `/api/rpc/iolaus-dag/action?location[directory]=${encodeURIComponent(project)}`, { input: { sessionID: owner, action: "cancel", runID: concurrent.runID, generation: concurrent.generation } }).then((value) => { cancelFinished = true; return value })
  await sleep(150); assert.equal(cancelFinished, false, "cancellation must wait for in-flight admission")
  pauseRelease("cancel")
  const concurrentReceipt = await admitting; await cancelling
  assert.equal(concurrentReceipt.state, "admitted")
  release("concurrent:old"); release("concurrent:new")
  assert.equal((await run(concurrent.runID)).status, "cancelled")
  assert.equal((await run(concurrent.runID)).nodes[0].result, undefined)
  passed("concurrent RPC cancellation serializes behind owner-mediated host admission", { receipt: concurrentReceipt, faultInjection: "pause immediately before native synthetic admission on sandbox plugin copy" })
  for (const target of ["owner-before", "owner-after"]) {
    const interrupted = await create(target, [node(target, target), { id: "after", title: "consume interrupted steering", agent: "visual-engineering", model, prompt: `QA_DOWNSTREAM ${target}`, dependsOn: [target], inputs: [{ node: target }] }])
    await until(() => holds.has(`${target}:old`), `${target} old request`)
    const childID = (await run(interrupted.runID)).nodes.find((item) => item.id === target).sessionID
    const identityBefore = (await api("GET", `/api/session/${childID}`)).data
    const args = { action: "steer", run_id: interrupted.runID, node_id: target, request_id: target, text: "QA_SUPPLEMENT Fontsource" }
    const encoded = Buffer.from(JSON.stringify({ name: "iolaus_flow", args })).toString("base64")
    await api("POST", `/api/session/${owner}/prompt`, { text: `QA_COMMAND:${encoded}` })
    await pauseHit(target)
    const requestState = () => JSON.parse(execFileSync("sqlite3", [db, `SELECT value_json FROM dag_steering WHERE request_id='${target}'`], { encoding: "utf8" }))
    assert.equal(requestState().state, "reserved")
    await api("POST", `/api/session/${owner}/interrupt`, { resume: false }); await wait(owner)
    assert.equal(requestState().state, "reserved")
    assert.equal((await run(interrupted.runID)).status, "running")
    pauseRelease(target)
    await until(() => requestState().state === "admitted", `${target} finalized without controller reload`)
    release(`${target}:old`)
    await until(() => holds.has(`${target}:new`), `${target} supplement request`)
    assert.equal((await run(interrupted.runID)).nodes.find((item) => item.id === "after").status, "pending")
    release(`${target}:new`)
    await until(async () => (await run(interrupted.runID)).status === "completed", `${target} completion without controller reload`)
    assert.equal(requestState().state, "delivered")
    const downstream = requests.find((item) => JSON.stringify(item.input.find((entry) => entry.type === "message" && entry.role === "user")).includes(`QA_DOWNSTREAM ${target}`))
    assert.match(JSON.stringify(downstream.input), new RegExp(`NEW_RESULT_${target}`))
    assert.doesNotMatch(JSON.stringify(downstream.input), new RegExp(`OLD_RESULT_${target}`))
    assert.equal((await context(childID)).filter((item) => item.id === requestState().messageID).length, 1)
    const identityAfter = (await api("GET", `/api/session/${childID}`)).data
    assert.equal(identityAfter.agent, identityBefore.agent); assert.deepEqual(identityAfter.model, identityBefore.model)
    passed(`${target}: owner tool interruption preserves admission and result tracking in the same controller`, { runID: interrupted.runID, request: requestState(), faultInjection: target === "owner-before" ? "pause before native synthetic admission" : "pause after native synthetic admission before returning receipt" })
  }
  const processTable = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
  const sandboxPIDs = [server.pid]
  for (const parent of sandboxPIDs) for (const [pid, ppid] of processTable) if (ppid === parent) sandboxPIDs.push(pid)
  const paths = execFileSync("lsof", ["-Fn", "-p", sandboxPIDs.join(",")], { encoding: "utf8" })
  databasePaths = paths.split("\n").filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line)).map((line) => line.slice(1))
  assert.ok(databasePaths.some((path) => path === join(env.XDG_DATA_HOME, "opencode/opencode.db")))
  assert.ok(databasePaths.every((path) => path.startsWith(`${sandbox}/`)))
  assert.deepEqual(errors, [])
  passed("isolated live host only opened sandbox databases", { databasePaths })
} catch (error) { failure = String(error.stack ?? error) }
finally {
  const cleanup = async (label, action) => {
    try { await action() } catch (error) { cleanupErrors.push(`${label}: ${error.stack ?? error}`) }
  }
  const signal = (name) => {
    try { process.kill(-server.pid, name) } catch (error) { if (error.code !== "ESRCH") cleanupErrors.push(`${name}: ${error.stack ?? error}`) }
  }
  for (const key of holds.keys()) release(key)
  await cleanup("server", async () => {
    if (!server?.pid) return
    signal("SIGTERM")
    const watchdog = setTimeout(() => signal("SIGKILL"), 5000)
    let deadline
    try { await Promise.race([exited, new Promise((done, reject) => {
      deadline = setTimeout(() => reject(new Error("server cleanup timed out")), 10000)
    })]) } finally { clearTimeout(watchdog); clearTimeout(deadline) }
    signal("SIGKILL")
  })
  await cleanup("mock", async () => {
    mock.closeAllConnections()
    if (mock.listening) await new Promise((done, reject) => mock.close((error) => error ? reject(error) : done()))
  })
  await cleanup("server log", () => writeFileSync(join(evidence, "server.log"), log.replace(/server password \S+/g, "server password <REDACTED>")))
  await cleanup("sandbox", () => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }) })
}
let after
try { after = hostState(); assert.deepEqual(after, before) } catch (error) { cleanupErrors.push(`host isolation: ${error.stack ?? error}`) }
let processGone = !server?.pid
if (server?.pid) {
  try { await until(() => {
    try { process.kill(-server.pid, 0); return false } catch (error) { if (error.code === "ESRCH") return true; throw error }
  }, "server process group cleanup", 5000); processGone = true } catch (error) { cleanupErrors.push(String(error.stack ?? error)) }
}
const cleanup = { sandboxRemoved: !sandbox || !existsSync(sandbox), processGone, mockClosed: !mock.listening }
if (cleanupErrors.length || Object.values(cleanup).some((value) => !value)) failure = [failure, ...cleanupErrors, "cleanup failed"].filter(Boolean).join("\n")
const receipt = { verdict: failure ? "FAIL" : "PASS", failure, cleanupErrors, command: `node .iolaus/evidence/owner-rescue/publication-compat/qa-flow-steering-2.0.28.mjs ${evidence}`, version, sdk, checks, errors,
  isolation: { env, databasePaths, before, after }, cleanup,
  limitations: ["No screenshot/direct-child TUI typing reproduced; API sessions only.", "Initial admission, late creation, idle capture, and owner interruption races use deterministic pauses in the isolated plugin copy; other scenarios run the unmodified build.", "Lost-ack simulation resets only isolated Flow receipts after actual host admission; it is not a network-loss experiment."] }
writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ verdict: receipt.verdict, failure, checks: checks.length, cleanup: receipt.cleanup }, null, 2))
process.exitCode = failure || !processGone ? 1 : 0
