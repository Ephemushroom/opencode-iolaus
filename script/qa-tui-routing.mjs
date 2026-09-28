import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"
import { once } from "node:events"
import { createDagQuery } from "../src/tui/data.ts"

const root = resolve(new URL("..", import.meta.url).pathname)
const evidence = resolve(process.argv[2] ?? join(root, ".omo/evidence/tui-routing"))
assert.ok(evidence.startsWith(`${join(root, ".omo/evidence")}/`))
mkdirSync(evidence, { recursive: true })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-routing-")))
const a = join(sandbox, "a"), b = join(sandbox, "b"), home = join(sandbox, "home"), config = join(sandbox, "config")
for (const path of [a, b, home, join(config, "opencode")]) mkdirSync(path, { recursive: true })
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const digest = async (path) => {
  if (!existsSync(path)) return "absent"
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
const hostPaths = [join(homedir(), ".config/opencode/opencode.json"), join(homedir(), ".local/share/opencode/opencode.db")]
const before = await Promise.all(hostPaths.map(digest))
let requestCount = 0
const mock = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const id = `qa_${++requestCount}`
  const done = (body.input ?? []).some((item) => item.type === "function_call_output")
  const args = JSON.stringify({ action: "create", definition: { schemaVersion: 1, name: "routing-qa", nodes: [{ id: "gate", kind: "gate", prompt: "Approve routing QA", dependsOn: [] }] } })
  const events = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } }]
  if (!done && (body.tools ?? []).some((tool) => tool.name === "iolaus_dag")) {
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id, call_id: id, name: "iolaus_dag", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id, call_id: id, name: "iolaus_dag", arguments: args, status: "completed" } },
    )
  } else events.push(
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id } },
    { type: "response.output_text.delta", item_id: id, output_index: 0, delta: "Routing QA ready" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id } },
  )
  events.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end("data: [DONE]\n\n")
})
mock.listen(0, "127.0.0.1"); await once(mock, "listening")
mkdirSync(join(home, ".iolaus"), { recursive: true })
writeFileSync(join(home, ".iolaus", "iolaus.json"), JSON.stringify({ mcps: [], gh: false, verify: false }))
writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
  plugins: [{ package: join(root, "dist") }],
  model: "openai/gpt-5.5", permissions: [{ action: "*", resource: "*", effect: "allow" }],
  provider: { openai: { options: { apiKey: "fake-key", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } },
}))
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox,
  XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
  OPENCODE_TEST_HOME: home, IOLAUS_HOME: join(home, ".iolaus"), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: a, env, stdio: ["ignore", "pipe", "pipe"] })
const exited = once(server, "exit")
let log = ""
server.stdout.on("data", (data) => { log += data })
server.stderr.on("data", (data) => { log += data })
const until = async (read) => {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("QA condition timed out")
}
let receipt
try {
  const base = await until(() => log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0])
  const password = await until(() => log.match(/server password (\S+)/)?.[1])
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const api = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body) })
    const data = await response.json()
    assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`)
    return data
  }
  const rpc = (method, input, directory) => api(`/api/rpc/iolaus-dag/${method}${directory ? `?location[directory]=${encodeURIComponent(directory)}` : ""}`, { input }).then((value) => value.output)
  const sessions = []
  for (const directory of [a, b]) {
    const { data: session } = await api("/api/session", { title: "Routing QA", agent: "build", location: { directory } })
    await api(`/api/session/${session.id}/prompt`, { text: "Create a gate-only DAG for routing QA." })
    const run = await until(async () => (await rpc("snapshot", { sessionID: session.id }, directory)).runs.find((run) => run.status === "paused"))
    sessions.push({ sessionID: session.id, directory, run })
  }
  const [first, second] = sessions
  const omitted = await rpc("snapshot", { sessionID: second.sessionID })
  assert.deepEqual(omitted.runs, [], "omitting location should reproduce the old default-project query")
  const states = []
  const query = createDagQuery((input, options) => rpc("snapshot", input, options.location.directory), (state) => states.push(state))
  await query.refresh(first)
  assert.equal(states.at(-1).runs[0].runID, first.run.runID)
  await query.refresh(second)
  assert.equal(states.at(-1).runs[0].runID, second.run.runID)
  const approved = await rpc("action", { action: "approve", sessionID: second.sessionID, runID: second.run.runID, generation: 1, nodeID: "gate" }, b)
  assert.equal(approved.runs[0].status, "completed")
  assert.equal((await rpc("snapshot", { sessionID: first.sessionID }, a)).runs[0].status, "paused")
  assert.deepEqual((await rpc("snapshot", { sessionID: second.sessionID }, a)).runs, [])
  query.dispose()
  receipt = { verdict: "PASS", version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), requestCount,
    omittedLocationReproducedEmpty: true, explicitRoutingFoundBothRuns: true, actionOnlyChangedProjectB: true, unrelatedOwnerHidden: true }
} finally {
  server.kill("SIGTERM")
  await exited
  mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve))
  writeFileSync(join(evidence, "server.log"), log.replace(/server password \S+/g, "server password <REDACTED>"))
  rmSync(sandbox, { recursive: true, force: true })
}
const after = await Promise.all(hostPaths.map(digest))
assert.deepEqual(after, before)
writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ ...receipt, before, after, sandboxRemoved: !existsSync(sandbox), serverStopped: server.exitCode !== null || server.signalCode !== null }, null, 2))
console.log(JSON.stringify(receipt, null, 2))
