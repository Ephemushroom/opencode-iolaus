import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const evidence = resolve(process.argv[2] ?? join(root, ".iolaus/evidence/flow-owner-rescue/host-contract"))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence")}/`))
mkdirSync(evidence, { recursive: true })
assert.ok(!existsSync(join(evidence, "receipt.json")), "use a fresh evidence directory")
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const checks = [], requests = [], cleanupErrors = []
let sandbox, env, server, exited, serverError, failure, version, log = ""
const hostState = () => Object.fromEntries([
  join(homedir(), ".iolaus/iolaus.json"),
  join(homedir(), ".config/opencode/opencode.json"),
  join(homedir(), ".config/opencode/opencode.jsonc"),
].map((path) => [path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent"]))
const before = hostState()
const passed = (name, detail = {}) => checks.push({ name, verdict: "PASS", ...detail })
const mock = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") return response.writeHead(404).end()
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const record = { sequence: requests.length, path: request.url, model: body.model, input: body.input, instructions: body.instructions }
    requests.push(record)
    appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(record) + "\n")
    response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "QA provider unavailable", type: "invalid_api_key", code: "invalid_api_key" } }))
  } catch (error) {
    failure = String(error.stack ?? error)
    response.writeHead(500).end()
  }
})
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(30) }
  throw new Error(`Timeout: ${label}`)
}
try {
  const temporaryRoot = existsSync(join(tmpdir(), "opencode")) ? join(tmpdir(), "opencode") : tmpdir()
  sandbox = realpathSync(mkdtempSync(join(temporaryRoot, "iolaus-owner-rescue-qa-")))
  const home = join(sandbox, "home"), project = join(sandbox, "project"), config = join(sandbox, "config"), plugin = join(sandbox, "plugin")
  env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox,
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"), IOLAUS_HOME: join(home, ".iolaus"), OPENCODE_TEST_HOME: home,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
  for (const path of [home, project, plugin, env.IOLAUS_HOME, join(config, "opencode")]) mkdirSync(path, { recursive: true })
  symlinkSync(join(root, "node_modules"), join(plugin, "node_modules"), "dir")
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "iolaus-rescue-contract-probe", type: "module", main: "./index.js" }))
  writeFileSync(join(evidence, "plugin.ndjson"), "")
  writeFileSync(join(plugin, "index.js"), `import { Plugin } from "@opencode/plugin/effect";
import { Effect, Stream } from "effect";
import { appendFileSync } from "node:fs";
const record = (value) => appendFileSync(${JSON.stringify(join(evidence, "plugin.ndjson"))}, JSON.stringify(value) + "\\n");
export default Plugin.define({ id: "rescue-contract-probe", effect: (ctx) => Effect.gen(function* () {
  record({ type: "context", version: ctx.app.version, keys: Object.keys(ctx), session: Object.keys(ctx.session), event: Object.keys(ctx.event), app: Object.keys(ctx.app) });
  yield* Stream.runForEach(ctx.event.subscribe(), (event) => Effect.sync(() => {
    if (event.type.startsWith("session.inbox") || event.type.startsWith("session.execution")) record(event);
  })).pipe(Effect.forkScoped);
}) });
`)
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
    plugins: [{ package: plugin }], model: "openai/gpt-5.5", default_agent: "build",
    provider: { openai: { options: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/v1` },
      models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } },
  }))
  version = execFileSync(binary, ["--version"], { cwd: project, env, encoding: "utf8" }).trim()
  assert.equal(version, "opencode v2.0.27")
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  exited = new Promise((done) => { server.once("exit", done); server.once("error", (error) => { serverError = error; done() }) })
  server.stdout.on("data", (data) => { log += data }); server.stderr.on("data", (data) => { log += data })
  const base = await until(() => { if (serverError) throw serverError; return log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] }, "server")
  const password = await until(() => log.match(/server password (\S+)/)?.[1], "authentication")
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text(); assert.ok(response.ok, `${response.status}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  const sessionID = (await api("POST", "/api/session", { agent: "build", model: { providerID: "openai", id: "gpt-5.5" }, location: { directory: project } })).data.id
  const inspect = async () => ({ info: (await api("GET", `/api/session/${sessionID}`)).data,
    context: (await api("GET", `/api/session/${sessionID}/context`)).data,
    inbox: (await api("GET", `/api/session/${sessionID}/inbox`)).data })
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "QA_ORIGINAL_TASK" })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  const previous = await inspect()
  assert.equal(previous.info.outcome, "failed")
  const terminal = previous.context.findLast((message) => message.type === "idle")
  assert.equal(terminal.error.type, "provider.auth"); assert.equal(terminal.error.status, 401)
  assert.equal(previous.inbox.length, 0)
  passed("actual failed provider call classified by host terminal message", { terminal, sessionID })
  const queued = await api("POST", `/api/session/${sessionID}/synthetic`, { text: "QA_QUEUED_REQUIREMENT_DO_NOT_DROP", delivery: "queue", resume: false })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  const after = await inspect()
  assert.equal(after.info.outcome, "failed"); assert.deepEqual(after.context, previous.context)
  assert.equal(after.inbox.length, 1); assert.equal(after.inbox[0].payload.text, "QA_QUEUED_REQUIREMENT_DO_NOT_DROP")
  passed("wait/context cannot certify absence of pending task-changing input")
  const count = requests.length; await sleep(200); assert.equal(requests.length, count)
  passed("queued input does not wake failed session")
  const records = () => readFileSync(join(evidence, "plugin.ndjson"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  const contexts = () => records().filter((entry) => entry.type === "context")
  const contract = await until(() => contexts()[0], "plugin context")
  assert.equal(contract.version, "2.0.27"); assert.ok(!contract.session.includes("inbox"))
  passed("installed plugin context lacks inbox inspection", { contract })
  const loaded = contexts().length
  await api("POST", "/api/location/reload"); await api("GET", `/api/session/${sessionID}/context`)
  await until(() => contexts().length > loaded, "reload")
  const reloaded = await inspect(); assert.deepEqual(reloaded.inbox, after.inbox)
  await sleep(150)
  const events = records(), lastLoad = events.findLastIndex((entry) => entry.type === "context")
  assert.ok(!events.slice(lastLoad + 1).some((entry) => entry.type === "session.inbox.enqueued" && entry.data.sessionID === sessionID))
  passed("queued requirement survives reload without event replay")
  writeFileSync(join(evidence, "queued-input.json"), JSON.stringify({ previous, queued, after, reloaded }, null, 2))
} catch (error) { failure = String(error.stack ?? error) }
finally {
  const cleanup = async (label, action) => { try { await action() } catch (error) { cleanupErrors.push(`${label}: ${error.stack ?? error}`) } }
  const signal = (name) => { try { process.kill(-server.pid, name) } catch (error) { if (error.code !== "ESRCH") cleanupErrors.push(`${name}: ${error.stack ?? error}`) } }
  await cleanup("server", async () => {
    if (!server?.pid) return
    signal("SIGTERM")
    const watchdog = setTimeout(() => signal("SIGKILL"), 5000)
    let deadline
    try { await Promise.race([exited, new Promise((done, reject) => { deadline = setTimeout(() => reject(new Error("server cleanup timeout")), 10000) })]) }
    finally { clearTimeout(watchdog); clearTimeout(deadline) }
    signal("SIGKILL")
  })
  await cleanup("mock", async () => { mock.closeAllConnections(); if (mock.listening) await new Promise((done, reject) => mock.close((error) => error ? reject(error) : done())) })
  await cleanup("sandbox", () => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }) })
  await cleanup("log", () => writeFileSync(join(evidence, "server.log"), log.replace(/server password \S+/g, "server password <REDACTED>")))
}
let processGone = !server?.pid
try {
  if (server?.pid) { await until(() => { try { process.kill(-server.pid, 0); return false } catch (error) { if (error.code === "ESRCH") return true; throw error } }, "process cleanup", 5000); processGone = true }
} catch (error) { cleanupErrors.push(String(error.stack ?? error)) }
const after = hostState()
try { assert.deepEqual(after, before) } catch (error) { cleanupErrors.push(String(error.stack ?? error)) }
const cleanup = { sandboxRemoved: !sandbox || !existsSync(sandbox), processGone, mockClosed: !mock.listening }
const verdict = failure || cleanupErrors.length || Object.values(cleanup).some((value) => !value) ? "FAIL" : "BLOCKED"
const receipt = { verdict, failure, version, checks, cleanup, cleanupErrors, isolation: { env, before, after }, requestCount: requests.length,
  blocker: "Rescue implementation not shipped; plugin inbox inspection unavailable. This is a host-contract counterexample, not positive rescue QA.",
  unverified: ["fallback/maxAttempts then one owner attempt", "owner selection/variants/capabilities", "rescue identity/permissions/workspace", "failure exclusions and one-shot persistence", "safe steering/progress handoff", "rescue cancellation/reload/provenance", "rescue reservation notice"],
  limitations: ["Probe plugin only; no rescue implementation loaded.", "No external action executed and no semantic exactly-once claim.", "Production DB was not opened or mutated; isolation is environment-based, real configuration hashes checked."] }
writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ verdict, failure, checks: checks.length, cleanup }, null, 2))
process.exitCode = verdict === "FAIL" ? 1 : 2
