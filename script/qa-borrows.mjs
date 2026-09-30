import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"
import { once } from "node:events"

// Live QA for the OMO borrows: runtime model fallback, empty-reply detection, deep-low → deep-high escalation,
// the team template in git worktrees, /start-work --worktree --make-pr, and compaction keeping Iolaus state.
// A real `opencode serve` in a sandboxed HOME, a local mock model, the built plugin, a git repository project.
const root = resolve(new URL("..", import.meta.url).pathname)
const evidence = resolve(process.argv[2] ?? join(root, `.iolaus/evidence/${new Date().toISOString().replace(/[:.]/g, "-")}-borrows`))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence")}/`))
mkdirSync(evidence, { recursive: true })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-borrows-qa-")))
const project = join(sandbox, "project"), home = join(sandbox, "home"), config = join(sandbox, "config")
for (const path of [project, home, join(config, "opencode")]) mkdirSync(path, { recursive: true })
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
git(project, "init", "-q", "-b", "main"); git(project, "config", "user.email", "qa@iolaus"); git(project, "config", "user.name", "qa")
writeFileSync(join(project, "a.txt"), "a\n"); writeFileSync(join(project, ".gitignore"), ".iolaus/\n")
git(project, "add", "."); git(project, "commit", "-qm", "init")
mkdirSync(join(project, ".iolaus/plans/cache/tickets"), { recursive: true })
writeFileSync(join(project, ".iolaus/plans/cache/spec.md"), "# Cache\nProblem: b is missing. Solution: add b.txt.\n")
writeFileSync(join(project, ".iolaus/plans/cache/tickets/01-add-b.md"), "# 01: Add b\n\n**Blocked by:** None\n\n- [ ] b.txt exists\n")
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const trace = join(evidence, "trace.ndjson")
rmSync(trace, { force: true }); rmSync(join(evidence, "requests.ndjson"), { force: true })

function hostState() {
  const db = join(homedir(), ".local/share/opencode/opencode.db")
  const sql = (query) => execFileSync("sqlite3", ["-readonly", db, query], { encoding: "utf8" }).trim()
  const tables = existsSync(db) ? sql("SELECT name FROM sqlite_master WHERE type='table'").split("\n") : []
  const files = [join(homedir(), ".config/opencode/opencode.json"), join(homedir(), ".config/opencode/opencode.jsonc"), join(homedir(), ".iolaus/iolaus.json")]
  return { files: Object.fromEntries(files.map((p) => [p, existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent"])),
    sessions: Object.fromEntries(["session", "session_v2"].map((t) => [t, tables.includes(t) ? sql(`SELECT count(*) FROM ${t}`) : "absent"])) }
}
const before = hostState()

const PRIMARY = "gpt-5.5", FALLBACK = "claude-opus-5-5"
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const requests = []
const node = (id, agent, prompt, extra = {}) => ({ id, title: id, agent, prompt, dependsOn: [], ...extra })
const CASES = {
  fallback: { action: "create", definition: { schemaVersion: 1, name: "QA fallback", nodes: [node("provider", "quick", "QA_FALLBACK_PROVIDER"), node("empty", "quick", "QA_FALLBACK_EMPTY"), node("pinned", "quick", "QA_FALLBACK_PINNED", { model: `openai/${PRIMARY}` })] } },
  escalate: { action: "create", definition: { schemaVersion: 1, name: "QA escalate", nodes: [node("decide", "deep-low", "QA_ESCALATE decide the cache design")] } },
  team: { action: "create", template: { template: "team", task: "QA_TEAM build two files", members: ["quick", "quick"], lead: "unspecified-high" } },
  outside: { action: "create", definition: { schemaVersion: 1, name: "QA outside", directory: sandbox, nodes: [node("n", "quick", "QA_NEVER")] } },
}

/** Scripted replies per request: { call } for a tool call, { text } for a message, { status } for an HTTP error. */
function reply(body, instructions) {
  const items = body.input ?? []
  const outs = items.filter((item) => item?.type === "function_call_output")
  const first = JSON.stringify(items.find((item) => item?.type === "message" && item.role === "user") ?? "")
  const all = JSON.stringify(items)
  const primary = body.model === PRIMARY
  if (instructions.includes("<iolaus-compaction-state>") || all.includes("<iolaus-compaction-state>")) return { text: "QA_SUMMARY" }
  const qaCase = first.match(/QA_CASE:(\w+)/)?.[1]
  if (qaCase) return outs.length ? { text: `QA_OWNER_${qaCase}` } : { call: { name: "iolaus_dag", args: CASES[qaCase] } }
  if (first.includes("QA_FALLBACK_PROVIDER")) return primary ? { status: 400 } : { text: "FALLBACK_PROVIDER_OK" }
  if (first.includes("QA_FALLBACK_EMPTY")) return primary ? { text: "" } : { text: "FALLBACK_EMPTY_OK" }
  if (first.includes("QA_FALLBACK_PINNED")) return { status: 400 }
  if (first.includes("QA_ESCALATE")) return first.includes("iolaus-escalation") ? { text: "ESCALATED_SETTLED" } : { text: "Two designs fit; evidence cannot pick.\nESCALATE: deep-high" }
  if (first.includes("You are the reviewer node")) return { text: "All good.\nVERDICT: PASS" }
  if (first.includes("Review the implementation of plan")) return { text: "Nothing blocking.\nVERDICT: PASS" }
  if (first.includes("split the task into exactly")) return { text: "## Assignment 1\nm1.txt\n## Assignment 2\nm2.txt\n## Integration\nmerge 1 then 2" }
  const branch = first.match(/iolaus-worktree branch=\\"(iolaus\/[a-z0-9._-]+)\\"/)?.[1]
  const assignment = first.match(/Do only \\"## Assignment (\d)\\"/)?.[1]
  if (assignment) return outs.length ? { text: `m${assignment} done\nBRANCH: ${branch}` }
    : { call: { name: "shell", args: { command: `printf m${assignment} > m${assignment}.txt && git add -A && git commit -qm m${assignment} && pwd`, description: "member work" } } }
  if (first.includes("Integrate the team")) {
    const members = [...new Set([...all.matchAll(/BRANCH: (iolaus\/[a-z0-9._-]+)/g)].map((m) => m[1]))].filter((b) => b !== branch)
    return outs.length ? { text: `merged ${members.join(" ")}\nBRANCH: ${branch}` }
      : { call: { name: "shell", args: { command: members.map((b) => `git merge --no-ff -q -m "merge ${b}" ${b}`).join(" && ") + " && ls", description: "integrate" } } }
  }
  const ticket = first.match(/iolaus-plan-ticket plan=\\"cache\\" ticket=\\"(\w+)\\"/)?.[1]
  if (ticket === "01") return outs.length ? { text: "TICKET_01_DONE b.txt exists" } : { call: { name: "shell", args: { command: "printf b > b.txt && pwd", description: "ticket" } } }
  if (ticket === "pr") return outs.length ? { text: "committed\nPR: https://example.invalid/qa/pull/1" }
    : { call: { name: "shell", args: { command: "git add b.txt && git commit -qm 'Add b' && git branch --show-current", description: "commit" } } }
  if (first.includes("/start-work")) return { text: "QA_ORCHESTRATOR_WAITING" }
  return { text: "QA_DEFAULT" }
}

function sse(id, result) {
  const events = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } }]
  if (result.call) {
    const args = JSON.stringify(result.call.args)
    events.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id, call_id: id, name: result.call.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id, call_id: id, name: result.call.name, arguments: args, status: "completed" } })
  } else events.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id } },
    ...(result.text ? [{ type: "response.output_text.delta", item_id: id, output_index: 0, delta: result.text }] : []),
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
    const result = reply(body, instructions)
    const record = { session: instructions.match(/session ID: (ses_\w+)/)?.[1] ?? null, model: body.model, call: result.call ?? null, text: result.text ?? null, status: result.status ?? 200,
      compactionState: instructions.includes("<iolaus-compaction-state>") || JSON.stringify(body.input ?? []).includes("<iolaus-compaction-state>"),
      first: JSON.stringify((body.input ?? []).find((i) => i?.type === "message" && i.role === "user") ?? "").slice(0, 3000),
      outputs: (body.input ?? []).filter((i) => i?.type === "function_call_output").map((i) => String(i.output).slice(0, 400)),
      instructions: instructions.includes("<iolaus-compaction-state>") ? instructions.slice(instructions.indexOf("<iolaus-compaction-state>"), instructions.indexOf("</iolaus-compaction-state>") + 30) : undefined }
    requests.push(record)
    appendFileSync(join(evidence, "requests.ndjson"), `${JSON.stringify(record)}\n`)
    assert.ok(requests.length < 300, "Unexpected model loop")
    if (result.status) return res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "QA injected invalid request", type: "invalid_request_error", code: "qa_injected" } }))
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of sse(`qa_${requests.length}`, result)) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) { mockErrors.push(String(error)); res.writeHead(500).end() }
})
mock.listen(0, "127.0.0.1"); await once(mock, "listening")
const main = `openai/${PRIMARY}`, backup = `openai/${FALLBACK}`
const iolausHome = join(home, ".iolaus")
mkdirSync(iolausHome, { recursive: true })
writeFileSync(join(iolausHome, "iolaus.json"), JSON.stringify({ mcps: [], gh: false, verify: false, models: {
  agents: { sisyphus: main, atlas: main, momus: main },
  categories: { quick: [main, backup], "deep-low": main, "deep-high": backup, "unspecified-high": main } } }))
writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
  plugins: [{ package: join(root, "dist") }], model: main, default_agent: "build",
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  provider: { openai: { options: { apiKey: "fake-key", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: {
    [PRIMARY]: { tool_call: true, limit: { context: 200000, output: 8192 } }, [FALLBACK]: { tool_call: true, limit: { context: 200000, output: 8192 } } } } },
}))
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, IOLAUS_TRACE: trace,
  XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
  OPENCODE_TEST_HOME: home, IOLAUS_HOME: iolausHome, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
const exited = once(server, "exit")
let log = ""
server.stdout.on("data", (data) => { log += data }); server.stderr.on("data", (data) => { log += data })
const until = async (read, what, ms = 90000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await sleep(300) }
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
  const rpc = (method, input) => api("POST", `/api/rpc/iolaus-dag/${method}?location[directory]=${encodeURIComponent(project)}`, { input })
  const create = async (agent) => (await api("POST", "/api/session", { title: "borrows QA", agent, location: { directory: project } })).data.id
  const session = async (id) => (await api("GET", `/api/session/${id}`)).data
  const runOf = async (owner, status) => until(async () => { const run = (await rpc("snapshot", { sessionID: owner })).output.runs.find((r) => r.name !== "Subagent calls"); return run && (!status || status.includes(run.status)) ? run : undefined }, `run of ${owner} in ${status}`)
  const byNode = (run) => Object.fromEntries(run.nodes.map((n) => [n.id, n]))
  const owner = async (qaCase) => { const id = await create("sisyphus"); await api("POST", `/api/session/${id}/prompt`, { text: `QA_CASE:${qaCase}` }); return id }

  await check("a node whose model fails (provider error or empty reply) moves to the lane's next configured model; a pinned model does not", async () => {
    const id = await owner("fallback")
    const run = await runOf(id, ["failed", "completed"])
    const nodes = byNode(run)
    assert.equal(nodes.provider.status, "completed", JSON.stringify(nodes.provider))
    assert.equal(nodes.provider.model, backup)
    assert.match(nodes.provider.result, /FALLBACK_PROVIDER_OK/)
    assert.equal(nodes.empty.status, "completed", JSON.stringify(nodes.empty))
    assert.equal(nodes.empty.model, backup)
    assert.match(nodes.empty.result, /FALLBACK_EMPTY_OK/)
    assert.equal(nodes.pinned.status, "failed", "a pinned model must not fall back")
    assert.equal(nodes.pinned.model, main)
    assert.equal(run.status, "failed")
    const fallbacks = traces().filter((t) => t.event === "iolaus.dag.node.fallback" && t.runID === run.runID).map((t) => t.nodeID).sort()
    assert.deepEqual(fallbacks, ["empty", "provider"])
    assert.ok(requests.some((r) => r.first.includes("QA_FALLBACK_PROVIDER") && r.model === PRIMARY && r.status === 400))
    assert.ok(!requests.some((r) => r.first.includes("QA_FALLBACK_PINNED") && r.model === FALLBACK))
  })

  await check("a deep-low node ending with ESCALATE: deep-high is rerun on deep-high with its findings", async () => {
    const id = await owner("escalate")
    const run = await runOf(id, ["failed", "completed"])
    const decide = byNode(run).decide
    assert.equal(run.status, "completed", JSON.stringify(run))
    assert.deepEqual([decide.agent, decide.model], ["deep-high", backup])
    assert.match(decide.result, /ESCALATED_SETTLED/)
    const high = requests.find((r) => r.first.includes("QA_ESCALATE") && r.model === FALLBACK)
    assert.ok(high?.first.includes("iolaus-escalation") && high.first.includes("Two designs fit"), "deep-high did not receive the findings")
    const child = await session(decide.sessionID)
    assert.equal(child.agent, "deep-high")
    assert.ok(traces().some((t) => t.event === "iolaus.dag.node.escalated" && t.runID === run.runID))
  })

  await check("team: members build in their own worktrees, the lead integrates on a branch, the user's tree is untouched", async () => {
    const id = await owner("team")
    const paused = await runOf(id, ["paused", "failed", "completed"])
    assert.equal(paused.status, "paused", JSON.stringify(paused.nodes.map((n) => [n.id, n.status, n.error])))
    const nodes = byNode(paused)
    const dirs = {}
    for (const name of ["member1", "member2", "integrate"]) {
      const child = await session(nodes[name].sessionID)
      dirs[name] = child.location.directory
      assert.ok(dirs[name].startsWith(`${project}-wt/iolaus-`), `${name} ran in ${dirs[name]}`)
    }
    assert.equal(new Set(Object.values(dirs)).size, 3)
    assert.ok(existsSync(join(dirs.integrate, "m1.txt")) && existsSync(join(dirs.integrate, "m2.txt")), "integration branch lacks the members' work")
    assert.ok(!existsSync(join(project, "m1.txt")) && !existsSync(join(project, "m2.txt")), "the user's tree was touched")
    assert.equal(git(project, "branch", "--show-current"), "main")
    const integrateBranch = git(dirs.integrate, "branch", "--show-current")
    assert.match(nodes.integrate.result, new RegExp(`BRANCH: ${integrateBranch.replace(/[.]/g, "\\.")}`))
    assert.equal(nodes.accept.status, "waiting_approval")
    const done = (await rpc("action", { sessionID: id, action: "approve", runID: paused.runID, generation: paused.generation, nodeID: "accept", note: "QA" })).output.runs.find((r) => r.runID === paused.runID)
    assert.equal(done.status, "completed")
    writeFileSync(join(evidence, "team-worktrees.json"), JSON.stringify({ dirs, integrateBranch, log: git(dirs.integrate, "log", "--oneline", "-6") }, null, 2))
  })

  await check("a run directory outside the project's repository is refused at create", async () => {
    const id = await owner("outside")
    // The mock sees no session ID in these requests, so a case is recognised by its prompt.
    const done = await until(() => requests.find((r) => r.text === "QA_OWNER_outside"), "outside owner")
    assert.match(done.outputs[0], /not a worktree of this project's repository/)
    assert.ok(!requests.some((r) => r.first.includes("QA_NEVER")))
  })

  let orchestrator, startRun
  await check("/start-work rejects an unknown option", async () => {
    const id = await create("build")
    await api("POST", `/api/session/${id}/prompt`, { text: "/start-work cache --bogus" })
    await until(() => traces().find((t) => t.event === "iolaus.startwork.rejected" && t.sessionID === id && /unknown \/start-work option --bogus/.test(JSON.stringify(t.errors))), "rejection")
    assert.ok(!existsSync(`${project}-wt/cache`))
  })

  await check("/start-work --make-pr works the tickets in a new worktree and opens the PR there after the accept gate", async () => {
    orchestrator = await create("build")
    await api("POST", `/api/session/${orchestrator}/prompt`, { text: "/start-work cache --make-pr" })
    const worktree = `${project}-wt/cache`
    const started = await until(() => traces().find((t) => t.event === "iolaus.startwork.worktree" && t.sessionID === orchestrator), "worktree trace")
    assert.deepEqual([started.path, started.branch, started.pr, started.ship], [worktree, "iolaus/cache", true, false])
    assert.equal(git(worktree, "branch", "--show-current"), "iolaus/cache")
    assert.ok(existsSync(join(worktree, ".iolaus/plans/cache/tickets/01-add-b.md")), "plan was not copied into the worktree")
    startRun = await runOf(orchestrator, ["paused", "failed", "completed"])
    assert.equal(startRun.status, "paused", JSON.stringify(startRun.nodes.map((n) => [n.id, n.status, n.error])))
    const ticket = await session(byNode(startRun).t01.sessionID)
    assert.equal(ticket.location.directory, worktree)
    assert.ok(existsSync(join(worktree, "b.txt")) && !existsSync(join(project, "b.txt")), "ticket did not work in the worktree")
    assert.equal(byNode(startRun).pr.status, "pending")
  })

  await check("compaction keeps the session's role and paused run in the summary request", async () => {
    assert.ok(orchestrator && startRun, "start-work run missing")
    await api("POST", `/api/session/${orchestrator}/compact`, {})
    const request = await until(() => requests.find((r) => r.compactionState && r.instructions?.includes(startRun.runID)), "compaction request")
    assert.match(request.instructions, /Session role: orchestrator for plan "cache"/)
    assert.match(request.instructions, new RegExp(`DAG run ${startRun.runID} .* is paused in ${project}-wt/cache; open nodes: .*accept=waiting_approval`))
    assert.ok(traces().some((t) => t.event === "iolaus.compaction.preserved" && t.sessionID === orchestrator && t.runs === 1))
  })

  await check("approving the gate runs the PR node in the worktree", async () => {
    const worktree = `${project}-wt/cache`
    const done = (await rpc("action", { sessionID: orchestrator, action: "approve", runID: startRun.runID, generation: startRun.generation, nodeID: "accept", note: "QA" })).output.runs.find((r) => r.runID === startRun.runID)
    const final = done.status === "completed" ? done : await runOf(orchestrator, ["completed", "failed"])
    assert.equal(final.status, "completed", JSON.stringify(final.nodes.map((n) => [n.id, n.status, n.error])))
    const pr = byNode(final).pr
    assert.match(pr.result, /PR: https:\/\/example\.invalid/)
    assert.equal((await session(pr.sessionID)).location.directory, worktree)
    const prompt = requests.find((r) => r.first.includes('ticket=\\"pr\\"'))?.first ?? ""
    assert.ok(prompt.includes("gh pr create") && prompt.includes("iolaus/cache"), "PR prompt lacks the branch and gh pr create")
    assert.equal(git(worktree, "log", "-1", "--format=%s"), "Add b")
    assert.equal(git(project, "log", "-1", "--format=%s"), "init")
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
writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ verdict, command: `node script/qa-borrows.mjs ${evidence}`, version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
  results, requestCount: requests.length, before, after, sandboxRemoved: !existsSync(sandbox), omitted: "No user credentials or inherited environment dumps. Local mock only." }, null, 2))
console.log(JSON.stringify({ verdict, results: results.map((r) => `${r.verdict} ${r.name}${r.error ? `: ${r.error.split("\n")[0]}` : ""}`) }, null, 2))
process.exitCode = verdict === "PASS" ? 0 : 1
