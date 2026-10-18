import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"

const evidence = dirname(fileURLToPath(import.meta.url))
const root = resolve(evidence, "../../../..")
const binary = "/opt/homebrew/bin/opencode"
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const checks = []
const hostState = () => Object.fromEntries([
  join(homedir(), ".iolaus/iolaus.json"),
  join(homedir(), ".config/opencode/opencode.json"),
  join(homedir(), ".config/opencode/opencode.jsonc"),
].map((path) => [path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent"]))
const before = hostState()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-owner-rescue-contract-")))
const home = join(sandbox, "home")
const project = join(sandbox, "project")
const config = join(sandbox, "config")
const plugin = join(sandbox, "plugin")
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox,
  XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"),
  XDG_STATE_HOME: join(sandbox, "state"), IOLAUS_HOME: join(home, ".iolaus"), OPENCODE_TEST_HOME: home,
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
let server, exited, log = "", requestCount = 0, failure
const mock = http.createServer((request, response) => {
  requestCount++
  response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "QA provider unavailable", type: "invalid_api_key", code: "invalid_api_key" } }))
})
async function until(read, label) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(30) }
  throw new Error(`Timeout: ${label}`)
}
try {
  writeFileSync(join(evidence, "plugin.ndjson"), "")
  for (const path of [home, project, plugin, join(config, "opencode")]) mkdirSync(path, { recursive: true })
  symlinkSync(join(root, "node_modules"), join(plugin, "node_modules"), "dir")
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "iolaus-rescue-contract-probe", type: "module", main: "./index.js" }))
  writeFileSync(join(plugin, "index.js"), `import { Plugin } from "@opencode/plugin/effect";
import { Effect, Stream } from "effect";
import { appendFileSync } from "node:fs";
const record = (value) => appendFileSync(${JSON.stringify(join(evidence, "plugin.ndjson"))}, JSON.stringify(value) + "\\n");
export default Plugin.define({ id: "rescue-contract-probe", effect: (ctx) => Effect.gen(function* () {
  record({ type: "context", pid: process.pid, version: ctx.app.version, keys: Object.keys(ctx), session: Object.keys(ctx.session), event: Object.keys(ctx.event), app: Object.keys(ctx.app) });
  yield* Stream.runForEach(ctx.event.subscribe(), (event) => Effect.sync(() => {
    if (event.type.startsWith("session.inbox") || event.type.startsWith("session.execution")) record(event);
  })).pipe(Effect.forkScoped);
}) });
`)
  mock.listen(0, "127.0.0.1")
  await once(mock, "listening")
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
    plugins: [{ package: plugin }], model: "openai/gpt-5.5", default_agent: "build",
    provider: { openai: { options: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/v1` },
      models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } },
  }))
  assert.equal(execFileSync(binary, ["--version"], { cwd: project, env, encoding: "utf8" }).trim(), "opencode v2.0.27")
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  exited = new Promise((done) => server.once("exit", done))
  server.stdout.on("data", (data) => { log += data })
  server.stderr.on("data", (data) => { log += data })
  const base = await until(() => log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], "server")
  const password = await until(() => log.match(/server password (\S+)/)?.[1], "authentication")
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text()
    assert.ok(response.ok, `${response.status}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  const created = await api("POST", "/api/session", { agent: "build", model: { providerID: "openai", id: "gpt-5.5" }, location: { directory: project } })
  const sessionID = created.data.id
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "QA_ORIGINAL_TASK" })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  const previous = { info: (await api("GET", `/api/session/${sessionID}`)).data,
    context: (await api("GET", `/api/session/${sessionID}/context`)).data,
    inbox: (await api("GET", `/api/session/${sessionID}/inbox`)).data }
  assert.equal(previous.info.outcome, "failed")
  assert.equal(previous.inbox.length, 0)
  const queued = await api("POST", `/api/session/${sessionID}/synthetic`, { text: "QA_QUEUED_REQUIREMENT_DO_NOT_DROP", delivery: "queue", resume: false })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  const after = { info: (await api("GET", `/api/session/${sessionID}`)).data,
    context: (await api("GET", `/api/session/${sessionID}/context`)).data,
    inbox: (await api("GET", `/api/session/${sessionID}/inbox`)).data }
  assert.equal(after.info.outcome, "failed")
  assert.deepEqual(after.context, previous.context)
  assert.equal(after.inbox.length, 1)
  assert.equal(after.inbox[0].payload.text, "QA_QUEUED_REQUIREMENT_DO_NOT_DROP")
  checks.push("wait returns with failed outcome and unchanged context while a task-changing input remains queued")
  const count = requestCount
  await sleep(200)
  assert.equal(requestCount, count)
  checks.push("queued input does not resume the failed session")
  const contexts = () => readFileSync(join(evidence, "plugin.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.type === "context")
  await until(() => existsSync(join(evidence, "plugin.ndjson")) && contexts().length, "plugin context")
  const contract = contexts()[0]
  assert.equal(contract.version, "2.0.27")
  assert.ok(!contract.session.includes("inbox"))
  assert.deepEqual(contract.event, ["subscribe"])
  assert.deepEqual(contract.app, ["name", "version", "channel"])
  writeFileSync(join(evidence, "host-context.json"), JSON.stringify(contract, null, 2))
  writeFileSync(join(evidence, "queued-input.json"), JSON.stringify({ previous, queued, after }, null, 2))
  checks.push(`runtime session methods: ${contract.session.join(", ")}`)
  const loaded = contexts().length
  await api("POST", "/api/location/reload")
  await api("GET", `/api/session/${sessionID}/context`)
  await until(() => contexts().length > loaded, "plugin reload")
  const reloadedInbox = (await api("GET", `/api/session/${sessionID}/inbox`)).data
  assert.deepEqual(reloadedInbox, after.inbox)
  checks.push("pending input survives plugin reload")
  await sleep(100)
  const records = readFileSync(join(evidence, "plugin.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const lastLoad = records.findLastIndex((entry) => entry.type === "context")
  assert.ok(!records.slice(lastLoad + 1).some((entry) => entry.type === "session.inbox.enqueued" && entry.data.sessionID === sessionID))
  checks.push("new plugin event subscription does not replay the pending admission")
} catch (error) {
  failure = error
} finally {
  if (server && server.exitCode === null) {
    process.kill(-server.pid, "SIGTERM")
    await Promise.race([exited, sleep(5000)])
    if (server.exitCode === null && server.signalCode === null) { process.kill(-server.pid, "SIGKILL"); await exited }
  }
  if (server) assert.throws(() => process.kill(-server.pid, 0), { code: "ESRCH" })
  mock.closeAllConnections()
  if (mock.listening) await new Promise((done) => mock.close(done))
  assert.deepEqual(hostState(), before)
  checks.push("real host configuration hashes unchanged; sandbox process stopped")
  writeFileSync(join(evidence, "server.log"), log.replace(/server password \S+/g, "server password [REDACTED]"))
  writeFileSync(join(evidence, "assertions.json"), JSON.stringify({ checks, requestCount, hostStateUnchanged: true,
    serverStopped: !server || server.exitCode !== null || server.signalCode !== null,
    ...(failure ? { error: String(failure.stack ?? failure) } : {}) }, null, 2))
  rmSync(sandbox, { recursive: true, force: true })
}
if (failure) throw failure
console.log(JSON.stringify(checks, null, 2))
