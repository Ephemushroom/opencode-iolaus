import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"

const scripts = dirname(fileURLToPath(import.meta.url))
const evidence = resolve(process.env.QA_EVIDENCE_DIR ?? join(scripts, "live"))
const source = process.env.QA_OPENCODE_SOURCE ?? "/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode/owner-rescue-opencode-2.0.27"
const binary = process.env.QA_OPENCODE_BIN ?? join(scripts, "patched-opencode.sh")
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const checks = []
const installed = execFileSync("/bin/sh", ["-c", "command -v opencode"], { encoding: "utf8" }).trim()
const hostState = () => Object.fromEntries([
  join(homedir(), ".iolaus/iolaus.json"),
  join(homedir(), ".config/opencode/opencode.json"),
  join(homedir(), ".config/opencode/opencode.jsonc"),
  join(homedir(), ".config/opencode/cli.json"),
  installed,
].map((path) => [path, existsSync(path) ? { realpath: realpathSync(path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") } : "absent"]))
const before = hostState()
let sandbox, server, exited, releaseFailure, log = "", requestCount = 0, failure
const records = { source, started: new Date().toISOString(), requests: [], reads: [], mockRequests: [] }
const cleanup = { errors: [] }
const sockets = new Set()
const mock = http.createServer((request, response) => {
  requestCount++
  records.mockRequests.push({ method: request.method, url: request.url, status: 401 })
  const reject = () => response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "QA provider unavailable", type: "invalid_api_key", code: "invalid_api_key" } }))
  if (request.method === "POST" && !releaseFailure) releaseFailure = reject
  else reject()
})
mock.on("connection", (socket) => {
  sockets.add(socket)
  socket.once("close", () => sockets.delete(socket))
})
async function until(read, label) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(30) }
  throw new Error(`Timeout: ${label}`)
}
function groupAlive() {
  if (!server?.pid) return false
  try { process.kill(-server.pid, 0); return true }
  catch (error) { if (error.code === "ESRCH") return false; throw error }
}
async function clean(name, action) {
  try { await action() }
  catch (error) { cleanup.errors.push({ name, error: String(error.stack ?? error) }) }
}
mkdirSync(evidence, { recursive: true })
try {
  records.sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim()
  assert.equal(records.sha, "1f4d07a4a519185955ae8ab2ea3607805509e386")
  sandbox = realpathSync(mkdtempSync("/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode/inbox-live-"))
  const home = join(sandbox, "home"), project = join(sandbox, "project"), config = join(sandbox, "config")
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox,
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"), IOLAUS_HOME: join(home, ".iolaus"), OPENCODE_TEST_HOME: home,
    QA_SANDBOX: sandbox, QA_OPENCODE_SOURCE: source, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
  records.env = env
  writeFileSync(join(sandbox, ".inbox-qa-sandbox"), "isolated inbox contract probe\n")
  for (const path of [home, project, join(config, "opencode")]) mkdirSync(path, { recursive: true })
  if (process.env.QA_PROBE_FAULT === "partial-setup") throw new Error("Injected partial-setup failure")
  const plugins = ["effect", "promise"].map((mode) => {
    const plugin = join(sandbox, mode)
    mkdirSync(plugin)
    symlinkSync(join(source, "packages/core/node_modules"), join(plugin, "node_modules"), "dir")
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: `inbox-${mode}-probe`, type: "module", main: "./index.ts" }))
    const shared = `import { Plugin, Rpc } from "@opencode/plugin${mode === "effect" ? "/effect" : ""}";
import { Effect, Schema } from "effect";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { z } from "zod";
import { randomUUID } from "node:crypto";
const definition = Rpc.define({ id: "inbox-${mode}", methods: { read: { input: z.object({ sessionID: z.string() }), output: z.unknown() } }, events: {} });
const encode = (value) => JSON.parse(JSON.stringify(value));
`
    const effect = `export default Plugin.define({ id: "inbox-effect-probe", effect: (ctx) => Effect.gen(function* () {
  const instance = randomUUID();
  yield* ctx.rpc.register(definition, { read: ({sessionID}) => Effect.gen(function* () {
    const result = yield* ctx.session.inbox.list({sessionID}).pipe(Effect.match({ onSuccess: (items) => ({items: Schema.encodeSync(Schema.Array(SessionInbox.Info))(items)}), onFailure: (error) => ({error: encode(error)}) }));
    return {...result, methods: Object.keys(ctx.session.inbox), pid: process.pid, instance, location: ctx.location.directory};
  }) });
}) });`
    const promise = `export default Plugin.define({ id: "inbox-promise-probe", async setup(ctx) {
  const instance = randomUUID();
  await ctx.rpc.register(definition, { async read({sessionID}) {
    const result = await ctx.session.inbox.list({sessionID}).then((items) => ({items}), (error) => ({error: {message: String(error), tag: error._tag}}));
    return {...result, methods: Object.keys(ctx.session.inbox), pid: process.pid, instance, location: ctx.location.directory};
  } });
} });`
    writeFileSync(join(plugin, "index.ts"), shared + (mode === "effect" ? effect : promise))
    writeFileSync(join(evidence, `${mode}-plugin.ts`), shared + (mode === "effect" ? effect : promise))
    return { package: plugin }
  })
  mock.listen(0, "127.0.0.1")
  await once(mock, "listening")
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
    plugins, model: "openai/gpt-5.5", default_agent: "build",
    provider: { openai: { options: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/v1` },
      models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } },
  }))
  records.version = execFileSync(binary, ["--version"], { cwd: project, env, encoding: "utf8" }).trim()
  records.help = execFileSync(binary, ["--help"], { cwd: project, env, encoding: "utf8" })
  assert.match(records.help, /serve/)
  records.launch = { binary, args: ["serve", "--hostname", "127.0.0.1", "--port", "0"], cwd: project }
  server = spawn(process.env.QA_PROBE_FAULT === "spawn" ? `${binary}.missing` : binary, records.launch.args,
    { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  exited = new Promise((done) => server.once("close", done))
  server.stdout.on("data", (data) => { log += data })
  server.stderr.on("data", (data) => { log += data })
  await once(server, "spawn")
  records.serverPID = server.pid
  const base = await until(() => {
    assert.equal(server.exitCode, null, `server exited: ${log}`)
    return log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  }, "server")
  const password = await until(() => log.match(/server password (\S+)/)?.[1], "authentication")
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text()
    records.requests.push({ method, path, body, status: response.status, response: text ? JSON.parse(text) : null, requestCount })
    assert.ok(response.ok, `${response.status}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  const query = new URLSearchParams({ "location[directory]": project })
  const read = async (mode, sessionID) => (await api("POST", `/api/rpc/inbox-${mode}/read?${query}`, { input: { sessionID } })).output
  const sessionID = (await api("POST", "/api/session", { title: "Inbox contract QA", agent: "build", model: { providerID: "openai", id: "gpt-5.5" }, location: { directory: project } })).data.id
  records.sessionID = sessionID
  records.plugins = await api("GET", `/api/plugin?${query}`)
  for (const mode of ["effect", "promise"]) assert.deepEqual((await read(mode, sessionID)).items, [])
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "QA_ORIGINAL_TASK" })
  await until(() => releaseFailure, "first provider request held for control admission")
  records.setup = "compact/move always wake in v2.0.27. Admit controls behind a disposable queued input during a held request. Release 401; the coalesced wake consumes that input and fails again, leaving both controls pending. Then admit user/synthetic with resume:false. Reads must not wake or consume any of the four."
  await api("POST", `/api/session/${sessionID}/synthetic`, { text: "QA_CONTROL_WAKE_BARRIER", delivery: "queue", resume: false })
  await api("POST", `/api/session/${sessionID}/compact`, { delivery: "queue" })
  await api("POST", `/api/session/${sessionID}/move`, { directory: project, delivery: "queue" })
  assert.deepEqual((await api("GET", `/api/session/${sessionID}/inbox`)).data.map((item) => item.type), ["synthetic", "compaction", "move"])
  releaseFailure()
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  assert.equal((await api("GET", `/api/session/${sessionID}`)).data.outcome, "failed")
  assert.ok(requestCount > 0, "failure must come from the local provider")
  records.requestsAfterFailure = requestCount
  const context = (await api("GET", `/api/session/${sessionID}/context`)).data
  assert.deepEqual((await api("GET", `/api/session/${sessionID}/inbox`)).data.map((item) => item.type), ["compaction", "move"])
  await api("POST", `/api/session/${sessionID}/synthetic`, { text: "QA_QUEUED_REQUIREMENT_DO_NOT_DROP", delivery: "queue", resume: false })
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "QA_PENDING_USER", delivery: "queue", resume: false })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  assert.deepEqual((await api("GET", `/api/session/${sessionID}/context`)).data, context)
  const pending = (await api("GET", `/api/session/${sessionID}/inbox`)).data
  assert.deepEqual(pending.map((item) => item.type), ["compaction", "move", "synthetic", "user"])
  records.pending = pending
  const instances = {}
  for (const phase of ["before-reload", "after-reload"]) {
    if (phase === "after-reload") {
      await api("POST", "/api/location/reload")
      await api("GET", `/api/session/${sessionID}/context`)
    }
    for (const mode of ["effect", "promise"]) {
      const result = await read(mode, sessionID)
      assert.deepEqual(result.methods, ["list"])
      assert.equal(result.location, project)
      assert.equal(result.pid, server.pid)
      assert.deepEqual(result.items, pending)
      assert.equal(result.items[2].payload.text, "QA_QUEUED_REQUIREMENT_DO_NOT_DROP")
      assert.equal(result.items[3].payload.text, "QA_PENDING_USER")
      assert.deepEqual((await read(mode, sessionID)).items, result.items)
      const missing = await read(mode, "ses_missing_qa")
      assert.equal(missing.error.tag ?? missing.error._tag, "Session.NotFoundError")
      if (phase === "after-reload") assert.notEqual(result.instance, instances[mode])
      instances[mode] = result.instance
      records.reads.push({ phase, mode, result, missing })
      checks.push(`${mode} ${phase}: all four pending types visible, stable read, list only, missing session rejected`)
    }
  }
  assert.deepEqual((await api("GET", `/api/session/${sessionID}/inbox`)).data, pending)
  assert.deepEqual((await api("GET", `/api/session/${sessionID}/context`)).data, context)
  assert.equal((await api("GET", `/api/session/${sessionID}`)).data.outcome, "failed")
  await sleep(1000)
  assert.equal(requestCount, records.requestsAfterFailure)
  checks.push("failed outcome plus wait/context still hides pending requirements; plugin API now sees them without resuming or consuming")
} catch (error) {
  failure = error
} finally {
  await clean("server", async () => {
    if (groupAlive()) process.kill(-server.pid, "SIGTERM")
    if (exited) await Promise.race([exited, sleep(5000)])
    if (groupAlive()) process.kill(-server.pid, "SIGKILL")
    await until(() => !groupAlive(), "private process group termination")
    cleanup.serverStopped = true
  })
  await clean("mock", async () => {
    mock.closeAllConnections()
    for (const socket of sockets) socket.destroy()
    if (mock.listening) await new Promise((done, reject) => mock.close((error) => error ? reject(error) : done()))
    await until(() => sockets.size === 0, "mock sockets closed")
    cleanup.mockStopped = !mock.listening
    cleanup.mockSocketsRemaining = sockets.size
  })
  await clean("host-state", () => {
    cleanup.after = hostState()
    assert.deepEqual(cleanup.after, before)
    cleanup.hostStateUnchanged = true
  })
  await clean("logs", () => {
    const logs = sandbox && join(sandbox, "data/opencode/log")
    if (logs && existsSync(logs)) {
      for (const file of readdirSync(logs)) {
        if (file.endsWith(".log")) writeFileSync(join(evidence, `host-${file}`), readFileSync(join(logs, file), "utf8").replace(/server password \S+/g, "server password [REDACTED]"))
      }
    }
  })
  await clean("sandbox", () => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true })
    cleanup.sandboxRemoved = !sandbox || !existsSync(sandbox)
    assert.equal(cleanup.sandboxRemoved, true)
  })
  writeFileSync(join(evidence, "server.log"), log.replace(/server password \S+/g, "server password [REDACTED]"))
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify(records, null, 2))
  writeFileSync(join(evidence, "assertions.json"), JSON.stringify({ status: failure || cleanup.errors.length ? "FAIL" : "PASS", checks, requestCount, before, cleanup,
    ...(failure ? { error: String(failure.stack ?? failure) } : {}) }, null, 2))
}
if (failure) throw failure
assert.deepEqual(cleanup.errors, [])
console.log("HOST_CONTRACT: PASS")
