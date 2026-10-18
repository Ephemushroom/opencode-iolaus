// Same-session model switch probe: does a failed child session continue on another model
// (different provider wire format) without losing progress, agent, or queued input?
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const evidence = join(dirname(fileURLToPath(import.meta.url)), process.argv[2] ?? "run")
mkdirSync(evidence, { recursive: false })
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const hostState = () => Object.fromEntries([".iolaus/iolaus.json", ".config/opencode/opencode.json", ".config/opencode/cli.json"]
  .map((f) => join(homedir(), f)).map((p) => [p, existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent"]))
const before = hostState()
const requests = [], checks = [], holds = new Map()
const hold = (key) => new Promise((done) => holds.set(key, done))
const release = (key) => { holds.get(key)?.(); holds.delete(key) }
const until = async (read, label, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await read(); if (v) return v; await sleep(50) }
  throw new Error(`timeout: ${label}`)
}
const pass = (name, detail = {}) => { checks.push({ name, verdict: "PASS", ...detail }); writeFileSync(join(evidence, "assertions.json"), JSON.stringify(checks, null, 2)) }

const sse = (res, events, named) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const e of events) res.write(`${named ? `event: ${e.type}\n` : ""}data: ${JSON.stringify(e)}\n\n`)
  res.end(named ? "" : "data: [DONE]\n\n")
}
const openaiEvents = (id, text, call) => [
  { type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } },
  ...(call ? [
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id, call_id: id, name: call.name, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: JSON.stringify(call.args) },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id, call_id: id, name: call.name, arguments: JSON.stringify(call.args), status: "completed" } },
  ] : [
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id } },
    { type: "response.output_text.delta", item_id: id, output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id } },
  ]),
  { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
]
const anthropicEvents = (id, text) => [
  { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-qa", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
]
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  const record = { seq: requests.length, url: req.url, model: body.model, body }
  requests.push(record); res.on("finish", () => appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(record) + "\n"))
  if (requests.length > 60) { res.writeHead(500); return res.end() }
  const all = JSON.stringify(body)
  const titled = !body.tools?.length
  if (req.url === "/v1/responses") {
    if (titled) return sse(res, openaiEvents(`t${record.seq}`, "PROBE_TITLE"))
    const outputs = (body.input ?? []).filter((i) => i.type === "function_call_output")
    if (!outputs.length) return sse(res, openaiEvents(`o${record.seq}`, "", { name: "shell", args: { command: "echo STEP1_DONE > progress.txt && cat progress.txt", description: "probe step 1" } }))
    record.role = "openai-after-tool"
    record.sawSupplement = all.includes("PROBE_SUPPLEMENT")
    if (requests.filter((r) => r.role === "openai-after-tool").length === 1) await hold("openai-fail")
    res.writeHead(401, { "content-type": "application/json" })
    return res.end(JSON.stringify({ error: { message: "probe: provider auth failure", type: "invalid_request_error", code: "invalid_api_key" } }))
  }
  if (req.url.startsWith("/v1/messages")) {
    if (titled) return sse(res, anthropicEvents(`t${record.seq}`, "PROBE_TITLE"), true)
    record.role = "anthropic-continue"
    record.sawTask = all.includes("PROBE_TASK")
    record.sawToolResult = all.includes("STEP1_DONE")
    record.sawSupplement = all.includes("PROBE_SUPPLEMENT")
    record.sawContinue = all.includes("PROBE_CONTINUE")
    return sse(res, anthropicEvents(`a${record.seq}`, `ANTHROPIC_CONTINUED supplement=${record.sawSupplement}`), true)
  }
  res.writeHead(404).end()
})
let sandbox, server, exited, log = "", failure
try {
  sandbox = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "iolaus-same-session-")))
  const home = join(sandbox, "home"), project = join(sandbox, "project"), config = join(sandbox, "config")
  for (const p of [home, project, join(config, "opencode")]) mkdirSync(p, { recursive: true })
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, IOLAUS_HOME: join(home, ".iolaus"),
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
    OPENCODE_TEST_HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  const url = `http://127.0.0.1:${mock.address().port}/v1`
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({ plugins: [], model: "openai/gpt-5.5", default_agent: "build",
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    provider: {
      openai: { options: { apiKey: "mock", baseURL: url }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } },
      anthropic: { options: { apiKey: "mock", baseURL: url }, models: { "claude-qa": { tool_call: true, limit: { context: 200000, output: 8192 } } } },
    } }))
  const version = execFileSync(binary, ["--version"], { env, cwd: project, encoding: "utf8" }).trim()
  pass("host version", { version, binary })
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  exited = new Promise((done) => server.once("exit", done))
  server.stdout.on("data", (d) => { log += d }); server.stderr.on("data", (d) => { log += d })
  const base = await until(() => log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], "server")
  const password = await until(() => log.match(/server password (\S+)/)?.[1], "password")
  const api = async (method, path, body, ok = true) => {
    const r = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(60000), headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await r.text(); if (ok) assert.ok(r.ok, `${method} ${path} ${r.status}: ${text}`)
    let data; try { data = text ? JSON.parse(text) : undefined } catch { data = text }
    return { status: r.status, data }
  }
  const unwrap = (r) => r.data?.data ?? r.data
  const get = async (id) => unwrap(await api("GET", `/api/session/${id}`))
  const context = async (id) => unwrap(await api("GET", `/api/session/${id}/context`))
  const inbox = async (id) => unwrap(await api("GET", `/api/session/${id}/inbox`, undefined, false))
  const wait = (id) => api("POST", `/api/experimental/session/${id}/wait`, undefined, false)
  const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2))

  const id = unwrap(await api("POST", "/api/session", { agent: "build", model: { providerID: "openai", id: "gpt-5.5" }, location: { directory: project } })).id
  await api("POST", `/api/session/${id}/prompt`, { text: "PROBE_TASK: write progress then finish" })
  await until(() => requests.some((r) => r.role === "openai-after-tool"), "openai second turn")
  // Queue a supplement while the doomed turn is still in flight.
  save("queued-response.json", await api("POST", `/api/session/${id}/prompt`, { text: "PROBE_SUPPLEMENT: also mention fontsource", delivery: "queue" }, false))
  save("inbox-before-failure.json", await inbox(id))
  release("openai-fail")
  save("wait-1.json", await wait(id))
  await sleep(500)
  const failed = await get(id)
  save("session-after-failure.json", failed); save("context-after-failure.json", await context(id)); save("inbox-after-failure.json", await inbox(id))
  const progress = existsSync(join(project, "progress.txt")) ? readFileSync(join(project, "progress.txt"), "utf8").trim() : null
  pass("first model turn ended after real tool effect", { outcome: failed.outcome, agent: failed.agent, model: failed.model, progress,
    anthropicCallsSoFar: requests.filter((r) => r.role === "anthropic-continue").length })

  const sw = await api("POST", `/api/session/${id}/model`, { model: { providerID: "anthropic", id: "claude-qa" } }, false)
  save("switch-response.json", sw)
  pass("switchModel on ended session", { status: sw.status, body: sw.data })
  const mark = requests.length
  save("continue-response.json", await api("POST", `/api/session/${id}/prompt`, { text: "PROBE_CONTINUE" }, false))
  save("wait-2.json", await wait(id))
  await sleep(500)
  const done = await get(id), ctx = await context(id)
  save("session-after-continue.json", done); save("context-after-continue.json", ctx); save("inbox-after-continue.json", await inbox(id))
  const after = requests.slice(mark).filter((r) => r.body.tools?.length)
  const cont = requests.filter((r) => r.role === "anthropic-continue")
  pass("continuation result", { outcome: done.outcome, agent: done.agent, model: done.model,
    providerCallsAfterSwitch: after.map((r) => ({ url: r.url, model: r.model })),
    anthropic: cont.map((r) => ({ seq: r.seq, sawTask: r.sawTask, sawToolResult: r.sawToolResult, sawSupplement: r.sawSupplement, sawContinue: r.sawContinue })) })
} catch (error) { failure = String(error.stack ?? error) }
finally {
  for (const k of [...holds.keys()]) release(k)
  if (server && server.exitCode === null) { try { process.kill(-server.pid, "SIGTERM") } catch {} ; await Promise.race([exited, sleep(5000)]) }
  mock.close()
  writeFileSync(join(evidence, "server.log"), log)
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
  const hostAfter = hostState()
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ failure, hostUnchanged: JSON.stringify(before) === JSON.stringify(hostAfter), sandboxRemoved: sandbox ? !existsSync(sandbox) : null, checks: checks.length }, null, 2))
  console.log(JSON.stringify({ failure, checks }, null, 2))
  process.exit(failure ? 1 : 0)
}
