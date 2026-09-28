import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"
import { once } from "node:events"

// Live QA for the role policy: a real `opencode serve` in a sandboxed HOME, a local mock model, the built plugin.
// `serve` (not `run`) so a session outlives its first reply, which the goal loop needs.
const root = resolve(new URL("..", import.meta.url).pathname)
const evidence = resolve(process.argv[2] ?? join(root, ".omo/evidence/roles"))
assert.ok(evidence.startsWith(`${join(root, ".omo/evidence")}/`))
mkdirSync(evidence, { recursive: true })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-roles-qa-")))
const project = join(sandbox, "project"), home = join(sandbox, "home"), config = join(sandbox, "config")
for (const path of [join(project, "src"), home, join(config, "opencode")]) mkdirSync(path, { recursive: true })
writeFileSync(join(project, "src/a.ts"), "const x = 1\nexport default x\n")
writeFileSync(join(project, "fixture.txt"), "IOLAUS_FIXTURE\n")
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const trace = join(evidence, "trace.ndjson")
rmSync(trace, { force: true })
// Same isolation check as qa-live: host config files by hash, host sessions by count. The host database itself is
// written by any OpenCode session the user has open, so its bytes are not a sandbox signal.
function hostState() {
  const config = join(homedir(), ".config")
  const db = join(homedir(), ".local/share/opencode/opencode.db")
  const sql = (query) => execFileSync("sqlite3", ["-readonly", db, query], { encoding: "utf8" }).trim()
  const tables = existsSync(db) ? sql("SELECT name FROM sqlite_master WHERE type='table'").split("\n") : []
  const files = [join(config, "opencode/opencode.json"), join(config, "opencode/opencode.jsonc"), join(homedir(), ".local/share/opencode/auth.json")]
  return { files: Object.fromEntries(files.map((p) => [p, existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent"])),
    sessions: Object.fromEntries(["session", "session_v2"].map((t) => [t, tables.includes(t) ? sql(`SELECT count(*) FROM ${t}`) : "absent"])) }
}
const before = hostState()

const requests = []
let active = ""
const PLAN = "*** Begin Patch\n*** Add File: .iolaus/plans/cache/spec.md\n+# Cache\n+Problem: x is wrong. Solution: set x to 2 and add b.\n*** Add File: .iolaus/plans/cache/tickets/01-set-x.md\n+# 01: Set x\n+\n+**Blocked by:** None\n+\n+- [ ] x is 2\n*** Add File: .iolaus/plans/cache/tickets/02-add-b.md\n+# 02: Add b\n+\n+**Blocked by:** 01\n+\n+- [ ] src/b.ts exists\n*** End Patch"
const updateA = (to) => `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const x = 1\n+const x = ${to}\n*** End Patch`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Scripted replies: returns { call } or { text } for the request, per scenario and per session role. */
async function reply(body, instructions, input) {
  const items = body.input ?? []
  const outs = items.filter((item) => item?.type === "function_call_output")
  const last = items.at(-1)
  const lastOut = String(outs.at(-1)?.output ?? "")
  const first = JSON.stringify(items.find((item) => item?.type === "message" && item.role === "user") ?? "")
  if (first.includes("Review the implementation of plan")) return { text: "Nothing blocking.\nVERDICT: PASS" }
  const ticket = first.match(/<iolaus-plan-ticket plan=\\?"cache\\?" ticket=\\?"(\d+)\\?"/)?.[1]
  if (ticket) {
    if (outs.length) return { text: `TICKET_${ticket}_DONE` }
    return { call: { name: "patch", args: { patchText: ticket === "01" ? updateA(2) : "*** Begin Patch\n*** Add File: src/b.ts\n+export const b = 1\n*** End Patch" } } }
  }
  if (first.includes("<iolaus-planning>") && !instructions.includes("<iolaus-planner>")) {
    return outs.length ? { text: "CONSULT_DONE" } : { call: { name: "shell", args: { command: "ls", description: "consult" } } }
  }
  if (active === "observe") {
    const lastUser = JSON.stringify([...items].reverse().find((item) => item?.type === "message" && item.role === "user") ?? "")
    if (first.includes("OBS_NESTED")) return { text: "OBS_NESTED_DONE" }
    if (first.includes("OBS_BG")) { await sleep(1500); return { text: "OBS_BG_DONE" } }
    if (first.includes("OBS_FG")) {
      if (lastUser.includes("OBS_FOLLOW")) return { text: "OBS_FOLLOW_DONE" }
      return outs.length ? { text: "OBS_FG_DONE" } : { call: { name: "subagent", args: { agent: "general", description: "nested", prompt: "OBS_NESTED" } } }
    }
    if (first.includes("OBS_REFUSED")) {
      return outs.length ? { text: "OBS_REFUSED_DONE" } : { call: { name: "subagent", args: { agent: "general", description: "no tool", prompt: "OBS_NEVER" } } }
    }
    const fg = outs[1] ? String(outs[1].output).match(/sessionID="(ses_\w+)"/)?.[1] : undefined
    if (outs.length === 0) return { call: { name: "subagent", args: { agent: "general", description: "bg scan", prompt: "OBS_BG", background: true } } }
    if (outs.length === 1) return { call: { name: "subagent", args: { agent: "metis", description: "fg check", prompt: "OBS_FG" } } }
    if (outs.length === 2) return fg ? { call: { name: "subagent", args: { agent: "metis", description: "fg check", sessionID: fg, prompt: "OBS_FOLLOW" } } } : { text: "NO_FG" }
    if (outs.length === 3) return { call: { name: "subagent", args: { agent: "general", description: "refused nest", prompt: "OBS_REFUSED" } } }
    await sleep(2500)
    return { text: "OBS_PARENT_DONE" }
  }
  switch (active) {
    case "planner": return [
      { call: { name: "patch", args: { patchText: PLAN } } },
      { call: { name: "patch", args: { patchText: updateA(3) } } },
      { call: { name: "iolaus_dag", args: { action: "create", template: { template: "ultrawork", task: "implement it" } } } },
      { call: { name: "subagent", args: { agent: "explore", description: "consult", prompt: "IOLAUS_CONSULT look at src" } } },
    ][outs.length] ?? { text: "PLANNED" }
    case "atlas-unbound": return [
      { call: { name: "patch", args: { patchText: updateA(4) } } },
      { call: { name: "subagent", args: { agent: "general", description: "refused", prompt: "IOLAUS_REFUSED" } } },
    ][outs.length] ?? { text: "REFUSED" }
    case "worker-plans": return outs.length ? { text: "REFUSED" } : { call: { name: "patch", args: { patchText: "*** Begin Patch\n*** Update File: .iolaus/plans/cache/spec.md\n@@\n-# Cache\n+# Hacked\n*** End Patch" } } }
    case "start-work": {
      const runID = input.match(/started run ([0-9a-f-]{36})/)?.[1]
      if (!runID) return { text: "NO_RUN" }
      if (!outs.length) return { call: { name: "patch", args: { patchText: updateA(5) } } }
      let state
      try { state = JSON.parse(lastOut) } catch {}
      const run = state?.run ?? state
      if (run?.status === "completed") return { text: "RUN_COMPLETED" }
      if (run?.status === "paused") return { call: { name: "iolaus_dag", args: { action: "approve", run_id: runID, node_id: "accept", note: "QA approved" } } }
      if (run?.status === "running") await sleep(1000)
      return { call: { name: "iolaus_dag", args: { action: "snapshot", run_id: runID } } }
    }
    case "goal": {
      const rounds = input.split("Continue working toward the active session goal").length - 1
      if (rounds === 0) return outs.length ? { text: "STEP_ONE" } : { call: { name: "read", args: { path: "fixture.txt" } } }
      return last?.type === "function_call_output" ? { text: "GOAL_DONE" } : { call: { name: "update_goal", args: { status: "complete" } } }
    }
    default: return { text: `DONE_${active}` }
  }
}

function sse(id, result) {
  const events = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } }]
  if (result.call) {
    const args = JSON.stringify(result.call.args)
    events.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id, call_id: id, name: result.call.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id, call_id: id, name: result.call.name, arguments: args, status: "completed" } })
  } else events.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id } },
    { type: "response.output_text.delta", item_id: id, output_index: 0, delta: result.text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id } })
  events.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  return events
}

const mockErrors = []
const mock = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const instructions = body.instructions ?? ""
    const input = JSON.stringify(body.input ?? [])
    const session = instructions.match(/session ID: (ses_\w+)/)?.[1] ?? null
    const result = await reply(body, instructions, input)
    const record = { scenario: active, session, model: body.model, tools: (body.tools ?? []).map((t) => t.name), call: result.call ?? null, text: result.text ?? null,
      outputs: (body.input ?? []).filter((i) => i?.type === "function_call_output").map((i) => String(i.output).slice(0, 400)),
      roles: ["<iolaus-planner>", "<iolaus-atlas>", "<iolaus-goal-loop>", "<iolaus-mode-dag template=\"ultrawork\">", "You are Hephaestus", "Sisyphus Junior"].filter((m) => instructions.includes(m)),
      input: input.slice(0, 6000) }
    requests.push(record)
    appendFileSync(join(evidence, "requests.ndjson"), `${JSON.stringify({ ...record, input: undefined })}\n`)
    assert.ok(requests.length < 200, "Unexpected model loop")
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of sse(`qa_${requests.length}`, result)) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) { mockErrors.push(String(error)); res.writeHead(500).end() }
})
mock.listen(0, "127.0.0.1"); await once(mock, "listening")
const model = "openai/gpt-5.5"
writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
  plugins: [{ package: join(root, "dist"), options: { mcps: [], gh: false, verify: false, models: {
    agents: { sisyphus: model, prometheus: model, atlas: model, momus: model, explore: model, hephaestus: model, metis: model } } } }],
  // No global allow-all: it would override the per-agent deny rules this QA checks (tool visibility).
  model, default_agent: "build", experimental: { subagent_depth: 2 },
  provider: { openai: { options: { apiKey: "fake-key", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: {
    "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } }, "claude-opus-5-5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } },
}))
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, IOLAUS_TRACE: trace,
  XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
  OPENCODE_TEST_HOME: home, IOLAUS_HOME: join(home, ".iolaus"), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
const exited = once(server, "exit")
let log = ""
server.stdout.on("data", (data) => { log += data })
server.stderr.on("data", (data) => { log += data })
const until = async (read, what, ms = 90000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await sleep(250)
  }
  throw new Error(`QA timed out waiting for ${what}`)
}
const traces = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []
const results = []
async function check(name, fn) {
  try { await fn(); results.push({ name, verdict: "PASS" }) }
  catch (error) { results.push({ name, verdict: "FAIL", error: String(error?.stack ?? error).slice(0, 1500) }) }
  writeFileSync(join(evidence, "assertions.json"), JSON.stringify(results, null, 2))
}

try {
  const base = await until(() => log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], "server url")
  const password = await until(() => log.match(/server password (\S+)/)?.[1], "server password")
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", authorization }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : undefined
  }
  const create = async (agent, model) => (await api("POST", "/api/session", { title: `roles ${active}`, agent, location: { directory: project }, ...(model ? { model } : {}) })).data.id
  const agentOf = async (id) => { const info = await api("GET", `/api/session/${id}`); return String((info.data ?? info).agent ?? "") }
  const finished = (id, text) => until(() => requests.find((r) => r.session === id && (text ? r.text === text : r.text !== null)), `final reply of ${id}`)
  const of = (id) => requests.filter((r) => r.session === id)

  await check("ultrawork from build switches the session to Sisyphus", async () => {
    active = "ultrawork"
    const id = await create("build")
    await api("POST", `/api/session/${id}/prompt`, { text: "/ultrawork IOLAUS_UW" })
    await finished(id)
    assert.equal(await agentOf(id), "sisyphus")
    assert.ok(traces().some((t) => t.event === "iolaus.command.agent" && t.sessionID === id && t.from === "build" && t.to === "sisyphus" && t.ok))
    const first = of(id)[0]
    assert.ok(first.roles.includes("<iolaus-mode-dag template=\"ultrawork\">"), `ultrawork instruction missing: ${first.roles}`)
    assert.ok(!first.tools.includes("update_goal"), "goal tools must be hidden from Sisyphus")
  })

  await check("hyperplan switches to Prometheus; planner writes the plan, is refused code edits and implementing runs, and its consult is read-only", async () => {
    active = "planner"
    const id = await create("sisyphus")
    await api("POST", `/api/session/${id}/prompt`, { text: "/hyperplan IOLAUS_HP plan the cache" })
    await finished(id, "PLANNED")
    assert.equal(await agentOf(id), "prometheus")
    assert.ok(existsSync(join(project, ".iolaus/plans/cache/tickets/02-add-b.md")), "planner could not write the plan")
    assert.equal(readFileSync(join(project, "src/a.ts"), "utf8"), "const x = 1\nexport default x\n", "planner edited source")
    const outs = of(id).at(-1).outputs
    assert.match(outs[2], /\[iolaus planner\].*only planning runs/, `ultrawork create was not refused: ${outs[2]}`)
    // Scheduled runs emit node.ready; the observed run recording the planner's consult does not.
    assert.ok(!traces().some((t) => t.event === "iolaus.dag.node.ready"), "a run was scheduled by the planner")
    const child = await until(() => requests.find((r) => r.session !== id && r.scenario === "planner" && r.text === "CONSULT_DONE"), "consult child")
    assert.ok(child.input.includes("<iolaus-planning>"), "subagent prompt lacks the inherited planning notice")
    assert.match(child.outputs[0], /\[iolaus planning\].*no shell/, `consult shell was not refused: ${child.outputs[0]}`)
    assert.ok(traces().some((t) => t.event === "iolaus.role.inherited" && t.tool === "subagent"))
    assert.ok(traces().some((t) => t.event === "iolaus.role.recorded" && t.role === "planning" && t.sessionID === child.session))
    assert.ok(of(id)[0].roles.includes("<iolaus-planner>"))
  })

  await check("Atlas without a plan is read-only", async () => {
    active = "atlas-unbound"
    const id = await create("atlas")
    await api("POST", `/api/session/${id}/prompt`, { text: "Fix src/a.ts" })
    await finished(id, "REFUSED")
    assert.match(of(id).at(-1).outputs[0], /\[iolaus atlas-unbound\].*\/start-work/)
    assert.match(of(id).at(-1).outputs[1], /\[iolaus atlas-unbound\]/, "Atlas subagent call was not refused")
    assert.ok(!traces().some((t) => t.event === "iolaus.subagent.observed" && t.owner === id), "a refused subagent call was recorded")
    assert.equal(readFileSync(join(project, "src/a.ts"), "utf8"), "const x = 1\nexport default x\n")
  })

  await check("native subagent calls appear as an observed DAG run: background, foreground, nested and a follow-up", async () => {
    active = "observe"
    const id = await create("sisyphus")
    await api("POST", `/api/session/${id}/prompt`, { text: "OBS_PARENT" })
    await finished(id, "OBS_PARENT_DONE")
    const snapshot = async () => (await api("POST", `/api/rpc/iolaus-dag/snapshot?location[directory]=${encodeURIComponent(project)}`, { input: { sessionID: id } })).output
    const run = await until(async () => (await snapshot()).runs.find((r) => r.name === "Subagent calls" && !r.nodes.some((n) => n.status === "running")), "observed run to settle", 30000)
    const nodes = Object.fromEntries(run.nodes.map((n) => [n.id, n]))
    assert.deepEqual(Object.keys(nodes).sort(), ["1-bg-scan", "2-fg-check", "3-nested", "4-refused-nest", "5-no-tool"], `observed nodes: ${Object.keys(nodes)}`)
    const ran = ["1-bg-scan", "2-fg-check", "3-nested", "4-refused-nest"].map((n) => nodes[n])
    assert.ok(ran.every((n) => n.status === "completed" && n.sessionID?.startsWith("ses_") && n.model === model), JSON.stringify(run.nodes.map((n) => [n.id, n.status, n.sessionID, n.model])))
    // `general` has no subagent tool here, so the host refuses its nested call before running it: recorded as failed, not left running.
    assert.equal(nodes["5-no-tool"].status, "failed", `refused call: ${JSON.stringify(nodes["5-no-tool"])}`)
    assert.deepEqual(nodes["5-no-tool"].dependsOn, ["4-refused-nest"])
    assert.equal(run.status, "failed")
    assert.deepEqual(nodes["3-nested"].dependsOn, ["2-fg-check"], "nested call is not under its caller")
    assert.equal(nodes["2-fg-check"].attempt, 2, "follow-up did not reopen the node")
    assert.match(nodes["2-fg-check"].result, /OBS_FOLLOW_DONE/)
    assert.match(nodes["1-bg-scan"].result, /OBS_BG_DONE/, "background child's result was not recorded")
    assert.match(nodes["3-nested"].result, /OBS_NESTED_DONE/)
    assert.ok(traces().some((t) => t.event === "iolaus.subagent.observed" && t.owner === id && t.nested), "nested call trace missing")
    assert.ok(traces().some((t) => t.event === "iolaus.subagent.followed" && t.owner === id), "follow-up trace missing")
    // Native behaviour is untouched: the follow-up reached the same child, the background call returned at once.
    const parentOutputs = of(id).at(-1).outputs
    assert.match(parentOutputs[0], /working in the background/)
    assert.match(parentOutputs[3], /OBS_REFUSED_DONE/)
    assert.equal(parentOutputs[2].match(/sessionID="(ses_\w+)"/)?.[1], nodes["2-fg-check"].sessionID)
    // An observed run cannot be scheduled.
    const retry = await fetch(`${base}/api/rpc/iolaus-dag/action?location[directory]=${encodeURIComponent(project)}`, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ input: { sessionID: id, action: "retry", runID: run.runID, generation: run.generation } }) })
    assert.match(await retry.text(), /records native subagent calls/)
  })

  await check("other lanes may write plans", async () => {
    active = "worker-plans"
    const id = await create("sisyphus")
    await api("POST", `/api/session/${id}/prompt`, { text: "Edit the plan" })
    await finished(id, "REFUSED")
    assert.ok(!of(id).at(-1).outputs[0].includes("[iolaus"), `worker plan edit was refused: ${of(id).at(-1).outputs[0]}`)
    assert.ok(readFileSync(join(project, ".iolaus/plans/cache/spec.md"), "utf8").startsWith("# Hacked"), "worker plan edit did not apply")
    // Restore the planner's spec for the start-work scenarios below.
    writeFileSync(join(project, ".iolaus/plans/cache/spec.md"), "# Cache\nProblem: x is wrong. Solution: set x to 2 and add b.\n")
  })

  await check("start-work with an unknown plan starts nothing", async () => {
    active = "start-invalid"
    const id = await create("build")
    await api("POST", `/api/session/${id}/prompt`, { text: "/start-work nope" })
    const done = await finished(id)
    assert.equal(await agentOf(id), "atlas")
    assert.ok(done.input.includes("/start-work did not start") && done.input.includes("nope"), "rejection was not relayed to Atlas")
    assert.ok(traces().some((t) => t.event === "iolaus.startwork.rejected" && t.sessionID === id))
    assert.ok(!traces().some((t) => t.event === "iolaus.startwork.started"))
  })

  await check("start-work switches to Atlas and runs each ticket in a fresh Atlas session, then both reviews and the accept gate", async () => {
    active = "start-work"
    const id = await create("build")
    await api("POST", `/api/session/${id}/prompt`, { text: "/start-work cache" })
    await finished(id, "RUN_COMPLETED")
    assert.equal(await agentOf(id), "atlas")
    const started = traces().find((t) => t.event === "iolaus.startwork.started" && t.sessionID === id)
    assert.deepEqual(started?.tickets, ["01", "02"])
    assert.match(of(id).find((r) => r.outputs.length)?.outputs[0] ?? "", /\[iolaus atlas-orchestrator\]/, "orchestrator edit was not refused")
    assert.equal(readFileSync(join(project, "src/a.ts"), "utf8"), "const x = 2\nexport default x\n", "ticket 01 did not apply")
    assert.ok(existsSync(join(project, "src/b.ts")), "ticket 02 did not apply")
    const done = traces().filter((t) => t.event === "iolaus.dag.node.completed" && t.runID === started.runID).map((t) => t.nodeID)
    assert.deepEqual(done.slice(0, 2), ["t01", "t02"], `tickets ran out of order: ${done}`)
    assert.ok(done.includes("review-standards") && done.includes("review-spec"), `reviews missing: ${done}`)
    assert.ok(traces().some((t) => t.event === "iolaus.dag.node.skipped" && t.nodeID === "fix" && t.runID === started.runID), "fix ran although both reviews passed")
    assert.ok(traces().some((t) => t.event === "iolaus.dag.node.approved" && t.nodeID === "accept"))
    assert.ok(traces().some((t) => t.event === "iolaus.dag.run.completed" && t.runID === started.runID))
    const tickets = ["01", "02"].map((n) => requests.find((r) => r.text === `TICKET_${n}_DONE`))
    assert.ok(tickets.every((r) => r && r.session !== id), "a ticket ran in the orchestrator session")
    assert.notEqual(tickets[0].session, tickets[1].session, "tickets shared a session")
    assert.ok(tickets.every((r) => r.roles.includes("<iolaus-atlas>")), "ticket sessions did not run Atlas")
    assert.ok(tickets.every((r) => !r.input.includes("IOLAUS_HP")), "planning context leaked into a ticket session")
  })

  await check("/goal switches to Hephaestus, keeps the session's non-GPT model, and loops until update_goal complete", async () => {
    active = "goal"
    const id = await create("build", { providerID: "openai", id: "claude-opus-5-5" })
    await api("POST", `/api/session/${id}/command`, { name: "goal", text: "IOLAUS_GOAL_TASK read the fixture" })
    await until(() => traces().some((t) => t.event === "iolaus.goal.completed" && t.sessionID === id), "goal completion")
    await finished(id, "GOAL_DONE")
    await sleep(2500)
    assert.equal(await agentOf(id), "hephaestus")
    const mine = of(id)
    assert.ok(mine.every((r) => r.model === "claude-opus-5-5"), `Hephaestus did not keep the session's non-GPT model: ${[...new Set(mine.map((r) => r.model))]}`)
    assert.ok(mine[0].roles.includes("You are Hephaestus") && mine[0].roles.includes("<iolaus-goal-loop>") && !mine[0].roles.includes("Sisyphus Junior"), `wrong prompt: ${mine[0].roles}`)
    assert.ok(mine[0].tools.includes("update_goal"), "goal tools missing for Hephaestus")
    assert.equal(traces().filter((t) => t.event === "iolaus.goal.continued" && t.sessionID === id).length, 1)
    assert.ok(traces().some((t) => t.event === "iolaus.goal.set" && t.sessionID === id && t.via === "command"))
    const goal = JSON.parse(readFileSync(join(project, ".iolaus/goals", `${id}.json`), "utf8"))
    assert.equal(goal.status, "complete")
    assert.equal(of(id).length, mine.length, "the loop kept going after the goal completed")
    assert.equal(mine.at(-1).text, "GOAL_DONE")
  })

  await check("a goal that makes no progress pauses after three idle turns", async () => {
    active = "stall"
    const id = await create("hephaestus")
    await api("POST", `/api/session/${id}/prompt`, { text: "IOLAUS_STALL" })
    await until(() => traces().some((t) => t.event === "iolaus.goal.paused" && t.sessionID === id), "stagnation pause")
    await sleep(2500)
    assert.equal(traces().find((t) => t.event === "iolaus.goal.paused" && t.sessionID === id).reason, "stagnated")
    assert.equal(of(id).length, 3, `expected three turns, saw ${of(id).length}`)
  })
} finally {
  server.kill("SIGTERM")
  await exited
  mock.closeAllConnections(); await new Promise((done) => mock.close(done))
  writeFileSync(join(evidence, "server.log"), log.replace(/server password \S+/g, "server password <REDACTED>"))
  rmSync(sandbox, { recursive: true, force: true })
}
const after = hostState()
await check("host state isolation", () => assert.deepEqual(after, before))
await check("cleanup", () => { assert.ok(!existsSync(sandbox)); assert.ok(server.exitCode !== null || server.signalCode !== null); assert.ok(!mock.listening) })
await check("mock protocol", () => assert.deepEqual(mockErrors, []))
const verdict = results.every((r) => r.verdict === "PASS") ? "PASS" : "FAIL"
const receipt = { verdict, version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), results, requestCount: requests.length, before, after, sandboxRemoved: !existsSync(sandbox) }
writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ verdict, results: results.map((r) => `${r.verdict} ${r.name}${r.error ? `: ${r.error.split("\n")[0]}` : ""}`) }, null, 2))
process.exitCode = verdict === "PASS" ? 0 : 1
