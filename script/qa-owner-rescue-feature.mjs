import assert from "node:assert/strict"
import { spawn, spawnSync, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const evidence = resolve(process.argv[2] ?? join(root, ".iolaus/evidence/owner-rescue/feature-live"))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence/owner-rescue")}/`))
mkdirSync(evidence, { recursive: true })
assert.ok(!existsSync(join(evidence, "receipt.json")), "use a fresh evidence directory")
const mode = process.env.QA_HOST_MODE ?? "patched"
assert.ok(["patched", "stock-off", "stock-on"].includes(mode))
const pinDirectory = join(root, ".iolaus/evidence/owner-rescue/upstream-inbox")
const pin = JSON.parse(readFileSync(join(pinDirectory, "source.json")))
const source = process.env.QA_OPENCODE_SOURCE ?? pin.source
const launcher = join(pinDirectory, "patched-opencode.sh")
const installed = "/opt/homebrew/bin/opencode"
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const hash = (path) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent"
const hostState = () => Object.fromEntries([join(homedir(), ".iolaus/iolaus.json"), join(homedir(), ".config/opencode/opencode.json"), join(homedir(), ".config/opencode/opencode.jsonc"), join(homedir(), ".config/opencode/cli.json"), installed, join(homedir(), ".iolaus/dist/index.js")].map((path) => [path, hash(path)]))
const before = hostState(), checks = [], requests = [], sockets = new Set(), errors = [], holds = new Map(), released = new Set(), cleanupErrors = []
let server, sandbox, env, project, plugin, api, exited, serverError, failure, log = "", owner, databasePaths = [], instrumentation = [], processGone = true
const passed = (name, detail = {}) => { checks.push({ name, verdict: "PASS", ...detail }); writeFileSync(join(evidence, "assertions.json"), JSON.stringify(checks, null, 2)) }
const artifact = (name, value) => writeFileSync(join(evidence, `${name}.json`), JSON.stringify(value, null, 2))
async function until(read, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(30) }
  throw new Error(`Timeout ${label}: ${log.slice(-1200).replace(/server password \S+/g, "server password <REDACTED>")}`)
}
async function hold(key) {
  if (released.has(key)) return
  await new Promise((done) => { const waiters = holds.get(key) ?? []; waiters.push(done); holds.set(key, waiters) })
}
function release(key) { released.add(key); for (const done of holds.get(key) ?? []) done(); holds.delete(key) }
function stream(response, record, text, call, reasoning = false) {
  const id = `qa_${record.sequence}`
  const events = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: record.model } }]
  if (reasoning) events.push({ type: "response.output_item.added", output_index: 1, item: { type: "reasoning", id: `${id}_reason`, summary: [] } }, { type: "response.reasoning_summary_text.delta", item_id: `${id}_reason`, output_index: 1, summary_index: 0, delta: "QA_FOREIGN_REASONING_DO_NOT_TRANSFER" }, { type: "response.output_item.done", output_index: 1, item: { type: "reasoning", id: `${id}_reason`, summary: [{ type: "summary_text", text: "QA_FOREIGN_REASONING_DO_NOT_TRANSFER" }], encrypted_content: "QA_PRIVATE_PROVIDER_STATE" } })
  if (call) {
    const args = JSON.stringify(call.args)
    events.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id, call_id: id, name: call.name, arguments: "" } }, { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: args }, { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id, call_id: id, name: call.name, arguments: args, status: "completed" } })
  } else events.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id } }, { type: "response.output_text.delta", item_id: id, output_index: 0, delta: text }, { type: "response.output_item.done", output_index: 0, item: { type: "message", id } })
  events.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end("data: [DONE]\n\n")
}
const mock = http.createServer(async (request, response) => {
  if (request.method !== "POST" || !["/primary/responses", "/rescue/responses"].includes(request.url)) return response.writeHead(404).end()
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()), input = body.input ?? []
    const lastUser = input.findLastIndex((item) => item.role === "user" && !/Iolaus Flow notice|<subagent /.test(JSON.stringify(item)))
    const last = JSON.stringify(input[lastUser] ?? ""), all = JSON.stringify(input)
    const command = last.match(/QA_COMMAND:([A-Za-z0-9+/=]+)/)?.[1]
    const exclusionStage = all.includes("Standards axis only") ? "standards" : all.includes("Spec axis only") ? "spec" : all.includes("<iolaus-plan-ticket") ? "ticket" : undefined
    const exclusionPlan = exclusionStage && ["success", "failure"].find((outcome) => all.includes(`rescue-exclusion-${outcome}`))
    const marker = !command ? exclusionPlan ? `authorized-excluded-${exclusionPlan}-${exclusionStage}` : all.match(/QA_CASE:([a-z0-9-]+)/)?.[1] ?? (all.includes("<iolaus-plan-ticket") ? "authorized" : undefined) : undefined
    const record = { sequence: requests.length, path: request.url, model: body.model, marker, command, body }
    requests.push(record); appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(record) + "\n")
    assert.ok(requests.length < 650, "unexpected provider loop")
    if (command && body.tools?.length) {
      const call = input.slice(lastUser).some((item) => item.type === "function_call_output") ? undefined : JSON.parse(Buffer.from(command, "base64").toString())
      return stream(response, record, "QA_OWNER_AVAILABLE", call)
    }
    if (!marker) return stream(response, record, "QA_TITLE_OR_OWNER")
    const outputs = input.filter((item) => item.type === "function_call_output")
    const rescued = request.url === "/rescue/responses"
    if (marker === "baseline") return stream(response, record, "QA_BASELINE")
    if (marker === "judge-success") return stream(response, record, "VERDICT: PASS")
    if (["cancel-fallback", "cancel-attempt"].includes(marker) && all.includes("checkpoints")) {
      if (!outputs.length) return stream(response, record, "", { name: "write", args: { path: join(project, `${marker}.txt`), content: "B_NATIVE_WORK\n" } })
      await hold(`${marker}:active`)
      return stream(response, record, "QA_LATE_B_RESULT")
    }
    if (marker === "cancel-excluded") {
      await hold(`${marker}:active`)
      return stream(response, record, "QA_EXCLUDED_CANCEL_SUCCESS")
    }
    if (marker.startsWith("excluded-success-") && body.model === "C") return stream(response, record, "QA_EXCLUDED_SUCCESS")
    if (marker.startsWith("authorized-excluded-") && body.model === "C" && (exclusionPlan === "success" || exclusionStage === "ticket")) return stream(response, record, "VERDICT: PASS")
    if (marker === "progress" && !rescued) {
      if (!outputs.length) return stream(response, record, "", { name: "write", args: { path: join(project, "draft.txt"), content: "ONE_NATIVE_EDIT\n" } }, true)
      const revision = all.includes("QA_SUPPLEMENT_TWO") ? 2 : all.includes("QA_SUPPLEMENT_ONE") ? 1 : 0
      await hold(`progress:${revision}`)
      if (revision < 2) return stream(response, record, `PROGRESS_REVISION_${revision}`)
    }
    if (["opaque", "opaque-fallback", "opaque-attempt"].includes(marker) && !outputs.length) return stream(response, record, "", { name: "shell", args: { command: "printf QA_OPAQUE", workdir: project } })
    if (marker === "pending-tool" && !outputs.length) return stream(response, record, "", { name: "write", args: { path: join(project, "pending.txt"), content: "MUST_NOT_EXIST" } })
    if (marker === "denied" && rescued && !outputs.length) return stream(response, record, "", { name: "write", args: { path: join(project, "blocked.txt"), content: "MUST_NOT_EXIST" } })
    if (["hidden-failure", "hidden-reload", "hidden-fallback", "hidden-attempt", "auth-flow", "auth-delegate", "planning-owner", "dedupe", "unknown", "pending-tool"].includes(marker) && !rescued) await hold(`${marker}:failure`)
    if (["cancel", "reload-running", "oldref"].includes(marker) && rescued) await hold(`${marker}:rescue`)
    if (rescued && marker !== "rescue-failure") return stream(response, record, `QA_RESCUED_${marker}`)
    response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "QA deterministic terminal provider failure", type: "invalid_api_key", code: "invalid_api_key" } }))
  } catch (error) { errors.push(String(error.stack ?? error)); response.writeHead(500).end() }
})
mock.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })

try {
  const temp = existsSync(join(tmpdir(), "opencode")) ? join(tmpdir(), "opencode") : tmpdir()
  sandbox = realpathSync(mkdtempSync(join(temp, "iolaus-rescue-feature-")))
  const home = join(sandbox, "home"), config = join(sandbox, "config")
  project = join(sandbox, "project"); plugin = join(sandbox, "plugin")
  env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"), IOLAUS_HOME: join(home, ".iolaus"), OPENCODE_TEST_HOME: home, QA_SANDBOX: sandbox, QA_OPENCODE_SOURCE: source, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", IOLAUS_TRACE: join(evidence, "trace.ndjson") }
  writeFileSync(join(sandbox, ".inbox-qa-sandbox"), "isolated feature QA\n")
  for (const path of [home, project, plugin, env.IOLAUS_HOME, join(config, "opencode")]) mkdirSync(path, { recursive: true })
  if (process.env.QA_FAULT === "partial-setup") throw new Error("QA_PARTIAL_SETUP")
  if (mode === "patched") {
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), pin.sha)
    const patch = readFileSync(join(pinDirectory, "upstream.patch"))
    assert.equal(createHash("sha256").update(patch).digest("hex"), pin.patchSha256)
    const added = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", "packages/core/test/plugin/session-inbox.test.ts"], { cwd: source })
    assert.equal(added.status, 1)
    assert.deepEqual(Buffer.concat([execFileSync("git", ["diff", "--binary"], { cwd: source }), added.stdout]), patch)
    execFileSync("git", ["apply", "--reverse", "--check", join(pinDirectory, "upstream.patch")], { cwd: source })
    assert.equal(hash(join(source, "bun.lock")), pin.lockSha256)
    cpSync(join(pinDirectory, "upstream.patch"), join(evidence, "upstream.patch"))
    artifact("source", { ...pin, source, launcher, launcherHash: hash(launcher), buildHash: hash(join(root, "dist/index.js")) })
  }
  cpSync(join(root, "dist"), join(plugin, "dist"), { recursive: true })
  symlinkSync(mode === "patched" ? join(source, "packages/core/node_modules") : join(root, "node_modules"), join(plugin, "node_modules"), "dir")
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "iolaus-rescue-feature-qa", type: "module", main: "./index.js" }))
  writeFileSync(join(plugin, "index.js"), 'export { default } from "./dist/index.js"\n')
  const probe = join(sandbox, "probe"); mkdirSync(probe)
  symlinkSync(join(plugin, "node_modules"), join(probe, "node_modules"), "dir")
  writeFileSync(join(probe, "package.json"), JSON.stringify({ name: "rescue-inbox-audit", type: "module", main: "./index.js" }))
  const probeText = `import { Plugin } from '@opencode/plugin/effect';
import { Effect, Stream } from 'effect';
import { appendFileSync } from 'node:fs';
const record = value => appendFileSync(${JSON.stringify(join(evidence, "plugin-inbox.ndjson"))}, JSON.stringify(value) + '\\n');
export default Plugin.define({ id: 'rescue-inbox-audit', effect: ctx => Effect.gen(function* () {
  record({ type: 'loaded', inbox: Object.keys(ctx.session.inbox ?? {}), version: ctx.app.version });
  yield* ctx.session.hook('title', event => Effect.sync(() => { event.result = 'QA title'; }));
  yield* ctx.session.hook('context', event => event.agent === 'quick' && JSON.stringify(event.messages).includes('QA_CASE:unknown') ? Effect.die(new Error('QA_UNCLASSIFIED_PLUGIN_FAILURE')) : Effect.void);
  yield* Stream.runForEach(ctx.event.subscribe(), event => Effect.gen(function* () {
    if (event.type === 'session.inbox.enqueued' && ctx.session.inbox) {
      const items = yield* ctx.session.inbox.list({ sessionID: event.data.sessionID });
      record({ type: 'inbox', sessionID: event.data.sessionID, items });
    }
  })).pipe(Effect.forkScoped);
}) });\n`
  writeFileSync(join(probe, "index.js"), probeText); writeFileSync(join(evidence, "audit-plugin.js"), probeText)
  writeFileSync(join(env.IOLAUS_HOME, "iolaus.json"), JSON.stringify({ agents: ["sisyphus", "prometheus", "atlas", "momus"], categories: ["quick"], modes: [], astGrep: false, gh: false, mcps: [], verify: false, ...(mode === "stock-off" ? {} : { rescue: { ownerModel: true } }), models: { agents: { sisyphus: "openai/A", prometheus: "openai/A", atlas: "openai/A", momus: "openai/A" }, categories: { quick: "openai/A" } } }))
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  const model = { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 200000, output: 8192 } }
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({ plugins: [{ package: plugin }, { package: probe }], model: "openai/A", default_agent: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "edit", resource: "*blocked.txt", effect: "deny" }, { action: "edit", resource: "*pending.txt", effect: "ask" }], providers: {
    openai: { package: "@opencode/ai/providers/openai/responses", settings: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/primary` }, models: { A: model, B: model, C: model } },
    rescue: { package: "@opencode/ai/providers/openai/responses", settings: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/rescue` }, models: { owner: { ...model, variants: [{ id: "actual", body: { qa_variant: "actual-owner" } }] } } },
  } }))
  const binary = process.env.QA_FAULT === "spawn" ? join(sandbox, "missing-binary") : mode === "patched" ? launcher : process.env.QA_OPENCODE_BIN ?? installed
  if (mode !== "patched" && process.env.QA_FAULT !== "spawn") assert.equal(execFileSync(binary, ["--version"], { cwd: project, env, encoding: "utf8" }).trim(), "opencode v2.0.27")
  artifact("command", { argv: ["node", "script/qa-owner-rescue-feature.mjs", evidence], controls: { QA_HOST_MODE: mode, QA_FAULT: process.env.QA_FAULT }, host: [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], env })
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  exited = new Promise((done) => { server.once("close", done); server.once("error", (error) => { serverError = error; done() }) })
  processGone = !server.pid
  server.stdout.on("data", (data) => { log += data }); server.stderr.on("data", (data) => { log += data })
  const base = await until(() => { if (serverError) throw serverError; assert.equal(server.exitCode, null, log); return log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] }, "server")
  const password = await until(() => log.match(/server password (\S+)/)?.[1], "authentication")
  api = async (method, path, body) => {
    const result = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await result.text(); assert.ok(result.ok, `${result.status} ${text}`); return text ? JSON.parse(text) : undefined
  }
  const info = async (id) => (await api("GET", `/api/session/${id}`)).data
  const context = async (id) => (await api("GET", `/api/session/${id}/context`)).data
  const inbox = async (id) => (await api("GET", `/api/session/${id}/inbox`)).data
  const wait = (id) => api("POST", `/api/experimental/session/${id}/wait`)
  const session = async (agent = "build", model = { providerID: "rescue", id: "owner", variant: "actual" }) => (await api("POST", "/api/session", { agent, model, location: { directory: project } })).data.id
  const command = async (args, id = owner, name = "iolaus_flow") => {
    const encoded = Buffer.from(JSON.stringify({ name, args })).toString("base64")
    await api("POST", `/api/session/${id}/prompt`, { text: `QA_COMMAND:${encoded}` }); await wait(id)
    const messages = await context(id)
    const tool = messages.flatMap((message) => message.type === "assistant" ? message.content : []).findLast((part) => part.type === "tool" && part.name === name)
    assert.ok(tool, JSON.stringify(messages).slice(-2000))
    if (tool.state.status !== "completed") return { error: tool.state.error?.message ?? JSON.stringify(tool.state) }
    const output = tool.state.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    try { return JSON.parse(output) } catch { return { error: output } }
  }
  const views = async (id = owner) => (await api("POST", `/api/rpc/iolaus-dag/snapshot?${new URLSearchParams({ "location[directory]": project })}`, { input: { sessionID: id } })).output.runs
  const view = async (runID, id = owner) => (await views(id)).find((run) => run.runID === runID)
  const completed = (runID, status = "completed", id = owner) => until(async () => {
    const value = await view(runID, id)
    if (value && ["completed", "failed", "cancelled"].includes(value.status) && value.status !== status) {
      const detail = await command({ action: "snapshot", run_id: runID }, id)
      const histories = await Promise.all(value.nodes.filter((node) => node.sessionID?.startsWith("ses_")).map(async (node) => ({ node: node.id, context: await context(node.sessionID) })))
      artifact("unexpected-terminal", { detail, histories })
      throw new Error(`Expected ${status}, got ${value.status}: ${JSON.stringify(detail.run?.nodes.map((node) => ({ error: node.error, recovery: node.recovery?.blocked })))}`)
    }
    return value?.status === status && value
  }, `${runID} ${status}`)
  const node = (marker, extra = {}) => ({ id: "work", agent: "quick", model: "openai/A", maxAttempts: 1, prompt: `QA_CASE:${marker}`, dependsOn: [], ...extra })
  const create = async (marker, extra = {}, id = owner) => {
    const result = await command({ action: "create", definition: { schemaVersion: 1, name: marker, nodes: [node(marker, extra)] } }, id)
    assert.ok(result.runID, JSON.stringify(result)); return result
  }
  const snapshot = async (runID, id = owner) => { const value = await command({ action: "snapshot", run_id: runID }, id); assert.ok(value.run, JSON.stringify(value)); return value }
  const queue = (id, text) => api("POST", `/api/session/${id}/synthetic`, { text, delivery: "queue", resume: false })
  const childRequests = (marker) => requests.filter((entry) => entry.marker === marker)
  await session()
  const plugins = await until(async () => { const value = await api("GET", `/api/plugin?${new URLSearchParams({ "location[directory]": project })}`); return value.data.length && value }, "plugin setup")
  artifact("plugins", plugins)
  if (mode === "stock-on") {
    assert.match(JSON.stringify(plugins), /unsupported by this host/)
    assert.equal(requests.length, 0)
    passed("stock opt-in explicitly unsupported before provider traffic; not feature PASS")
  } else {
    owner = await session()
    const baseline = await create("baseline")
    await completed(baseline.runID)
    passed(`${mode} default flow baseline`)
    if (mode === "stock-off") {
      const disabled = await create("order", { fallbackModels: ["openai/B", "openai/C"], maxAttempts: 5 })
      await completed(disabled.runID, "failed")
      const value = await snapshot(disabled.runID)
      assert.deepEqual(childRequests("order").map((entry) => entry.model), ["A", "B", "C", "C", "C"])
      assert.equal(value.run.nodes[0].recovery, undefined)
      artifact("default-off-fallback", value); passed("stock default-off preserves fallback budget without owner rescue")
    }
    if (mode === "patched") {
      const audit = readFileSync(join(evidence, "plugin-inbox.ndjson"), "utf8")
      assert.match(audit, /"inbox":\["list"\]/)
      passed("actual plugin session.inbox.list exists; no external HTTP bridge")
      const judge = await create("judge-success", { kind: "judge", agent: "momus" })
      await completed(judge.runID)
      const judgeCompleted = await snapshot(judge.runID)
      assert.deepEqual(judgeCompleted.run.nodes[0].result.payload, { text: "VERDICT: PASS" })
      assert.match(judgeCompleted.run.nodes[0].execution.sessionID, /^judge:/)
      assert.equal(judgeCompleted.run.nodes[0].recovery.blocked, undefined)
      const judgeTask = node("judge-success", { kind: "judge", agent: "momus", prompt: "QA_CASE:judge-success AMENDED_JUDGE_TASK" })
      const judgeAmend = await command({ action: "amend", run_id: judge.runID, definition: { schemaVersion: 1, name: "amended judge", nodes: [judgeTask] } })
      assert.equal(judgeAmend.error, undefined, JSON.stringify(judgeAmend))
      await completed(judge.runID)
      const judgeRetry = await command({ action: "retry", run_id: judge.runID, node_id: "work" })
      assert.equal(judgeRetry.error, undefined, JSON.stringify(judgeRetry))
      await completed(judge.runID)
      const judgeRetried = await snapshot(judge.runID)
      assert.equal(judgeRetried.run.nodes[0].attempt, 2)
      assert.equal(judgeRetried.run.nodes[0].definition.prompt, judgeTask.prompt)
      assert.equal(judgeRetried.run.nodes[0].recovery.blocked, undefined)
      assert.equal(judgeRetried.run.nodes[0].recovery.handoff, undefined)
      assert.equal(judgeRetried.run.nodes[0].recovery.rescue, undefined)
      assert.equal(judgeRetried.events.filter((event) => event.type === "node.rescued" || event.type === "node.rescue-skipped").length, 0)
      assert.deepEqual(childRequests("judge-success").map((entry) => `${entry.path}:${entry.model}`), ["/primary/responses:A", "/primary/responses:A", "/primary/responses:A"])
      artifact("judge-success", { completed: judgeCompleted, retried: judgeRetried })
      passed("sessionless judge completes, amends and retries without blocked recovery or owner rescue")
      const ordered = await create("order", { fallbackModels: ["openai/B", "openai/C"], maxAttempts: 5 })
      await completed(ordered.runID)
      const order = await snapshot(ordered.runID), work = order.run.nodes[0]
      assert.deepEqual(childRequests("order").map((entry) => `${entry.path}:${entry.model}`), ["/primary/responses:A", "/primary/responses:B", "/primary/responses:C", "/primary/responses:C", "/primary/responses:C", "/rescue/responses:owner"])
      assert.equal(work.attempt, 6); assert.equal(work.result.provenance.model, "rescue/owner#actual")
      assert.equal(childRequests("order").at(-1).body.qa_variant, "actual-owner")
      assert.equal(order.events.filter((event) => event.type === "node.rescued").length, 1)
      artifact("ordered", order)
      passed("A B C C C then exactly one actual owner variant across two providers, not lane default")

      await command({ action: "retry", run_id: ordered.runID, node_id: "work" }); await completed(ordered.runID, "failed")
      const retriedOrder = await snapshot(ordered.runID)
      assert.deepEqual(childRequests("order").slice(6).map((entry) => entry.model), ["A", "B", "C"])
      assert.equal(retriedOrder.run.nodes[0].recovery.rescue.decisionID, work.recovery.rescue.decisionID)
      assert.equal(retriedOrder.events.filter((event) => event.type === "node.rescued").length, 1)
      artifact("retry-planned-chain", retriedOrder); passed("retry after settled rescue restores the planned A B C chain without another owner extra")
      const amendedTask = node("order", { prompt: "QA_CASE:order AMENDED_TASK_REQUIREMENT", model: "openai/B", fallbackModels: ["openai/C"] })
      await command({ action: "amend", run_id: ordered.runID, definition: { schemaVersion: 1, name: "amended order", nodes: [amendedTask] } })
      await completed(ordered.runID, "failed")
      await command({ action: "retry", run_id: ordered.runID, node_id: "work" }); await completed(ordered.runID, "failed")
      const amendedOrder = await snapshot(ordered.runID), amendedHistory = await context(amendedOrder.run.nodes[0].execution.sessionID)
      assert.deepEqual(childRequests("order").slice(9).map((entry) => entry.model), ["B", "C", "B", "C"])
      assert.equal(amendedOrder.run.nodes[0].definition.prompt, amendedTask.prompt)
      assert.match(amendedHistory.find((entry) => entry.type === "user").text, /"currentTask":"QA_CASE:order AMENDED_TASK_REQUIREMENT"/)
      assert.equal(amendedOrder.run.nodes[0].recovery.rescue.decisionID, work.recovery.rescue.decisionID)
      assert.equal(amendedOrder.events.filter((event) => event.type === "node.rescued").length, 1)
      artifact("retry-amended-task", { value: amendedOrder, history: amendedHistory }); passed("amend then retry preserves the amended task and B C chain with spent rescue budget")

      const progress = await create("progress")
      await until(() => holds.has("progress:0"), "native edit")
      const original = (await view(progress.runID)).nodes[0].sessionID
      const originalInfo = await info(original)
      assert.equal(readFileSync(join(project, "draft.txt"), "utf8"), "ONE_NATIVE_EDIT\n")
      for (const [index, text] of ["QA_SUPPLEMENT_ONE retain draft", "QA_SUPPLEMENT_TWO retain both requirements"].entries()) {
        const receipt = await command({ action: "steer", run_id: progress.runID, node_id: "work", request_id: `progress-${index}`, text })
        assert.equal(receipt.state, "admitted", JSON.stringify(receipt)); release(`progress:${index}`)
        await until(() => holds.has(`progress:${index + 1}`), `steer ${index + 1} delivered`)
      }
      release("progress:2"); await completed(progress.runID)
      const noWake = requests.length
      const notices = await until(async () => { const items = (await inbox(owner)).filter((item) => item.payload?.metadata?.iolaus_dag_run === progress.runID); return items.length === 2 && items }, "rescue and terminal notices")
      assert.ok(notices.some((item) => item.payload.text.includes("reserved its one owner-model rescue")))
      assert.ok(notices.some((item) => item.payload.text.includes("completed")))
      await sleep(250); assert.equal(requests.length, noWake)
      artifact("non-waking-notices", { notices, providerRequestCount: noWake })
      passed("rescue and terminal notices queue without auto-waking owner")
      const continued = await snapshot(progress.runID), finalInfo = await info(continued.run.nodes[0].execution.sessionID)
      assert.equal(finalInfo.agent, originalInfo.agent); assert.deepEqual(finalInfo.permissions ?? [], originalInfo.permissions ?? []); assert.deepEqual(finalInfo.location, originalInfo.location)
      assert.notEqual(finalInfo.id, original)
      assert.equal(readFileSync(join(project, "draft.txt"), "utf8"), "ONE_NATIVE_EDIT\n")
      assert.equal(continued.steering.filter((request) => request.state === "delivered").length, 2)
      const oldHistory = await context(original), newHistory = await context(finalInfo.id)
      assert.equal(oldHistory.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool" && part.name === "write" && part.state.status === "completed").length, 1)
      assert.ok(oldHistory.flatMap((message) => message.content ?? []).some((part) => part.type === "reasoning" && part.text.includes("QA_FOREIGN_REASONING")))
      const rescueRequest = childRequests("progress").find((entry) => entry.path === "/rescue/responses")
      assert.match(JSON.stringify(rescueRequest.body.input), /QA_SUPPLEMENT_ONE/); assert.match(JSON.stringify(rescueRequest.body.input), /QA_SUPPLEMENT_TWO/)
      assert.doesNotMatch(JSON.stringify(rescueRequest.body), /QA_FOREIGN_REASONING|QA_PRIVATE_PROVIDER_STATE/)
      assert.ok(!rescueRequest.body.input.some((item) => ["function_call", "function_call_output", "reasoning"].includes(item.type)))
      assert.ok(!newHistory.some((message) => message.type === "synthetic"))
      artifact("progress", { continued, originalInfo, finalInfo, oldHistory, newHistory })
      passed("one real native edit and two confirmed steers survive fresh-model handoff without raw tools or foreign reasoning")

      const failed = await create("rescue-failure")
      await completed(failed.runID, "failed")
      let failureSnapshot = await snapshot(failed.runID)
      const decision = failureSnapshot.run.nodes[0].recovery.rescue.decisionID
      assert.deepEqual(childRequests("rescue-failure").map((entry) => entry.model), ["A", "owner"])
      await command({ action: "retry", run_id: failed.runID }); await completed(failed.runID, "failed")
      await api("POST", "/api/location/reload")
      await command({ action: "retry", run_id: failed.runID }); await completed(failed.runID, "failed")
      await command({ action: "amend", run_id: failed.runID, definition: { schemaVersion: 1, name: "removed", nodes: [node("baseline", { id: "other" })] } })
      await completed(failed.runID)
      await command({ action: "amend", run_id: failed.runID, definition: { schemaVersion: 1, name: "readded", nodes: [node("rescue-failure")] } })
      await completed(failed.runID, "failed")
      failureSnapshot = await snapshot(failed.runID)
      assert.equal(failureSnapshot.run.nodes[0].recovery.rescue.decisionID, decision)
      assert.equal(failureSnapshot.events.filter((event) => event.type === "node.rescued").length, 1)
      assert.deepEqual(childRequests("rescue-failure").map((entry) => entry.model), ["A", "owner", "A", "A", "A"])
      artifact("spent-budget", failureSnapshot)
      passed("failed rescue never recurses; retry reload amend removal and re-add preserve spent budget")

      for (const marker of ["hidden-failure", "hidden-reload", "hidden-fallback", "hidden-attempt"]) {
        const extra = marker === "hidden-fallback" ? { fallbackModels: ["openai/B", "openai/C"], maxAttempts: 3 } : marker === "hidden-attempt" ? { maxAttempts: 3 } : {}
        const created = await create(marker, extra)
        await until(() => holds.has(`${marker}:failure`), marker)
        const child = (await view(created.runID)).nodes[0].sessionID
        const queued = await queue(child, `PRESERVE_${marker}`)
        if (marker === "hidden-reload") {
          const laneBefore = await api("GET", `/api/agent/quick?${new URLSearchParams({ "location[directory]": project })}`)
          await api("POST", "/api/location/reload")
          await view(created.runID)
          const laneAfter = await api("GET", `/api/agent/quick?${new URLSearchParams({ "location[directory]": project })}`)
          artifact("reload-lane", { laneBefore, laneAfter })
          assert.deepEqual(laneAfter.data.permissions, laneBefore.data.permissions)
        }
        release(`${marker}:failure`); await completed(created.runID, "failed")
        const value = await snapshot(created.runID)
        assert.equal(value.run.nodes[0].attempt, 1); assert.equal(value.run.nodes[0].recovery.rescue, undefined)
        assert.ok(value.events.some((event) => event.type === "node.rescue-skipped" && event.payload.reason === "pending_host_input"))
        assert.ok((await inbox(child)).some((item) => item.id === queued.data.id))
        assert.deepEqual(childRequests(marker).map((entry) => entry.model), ["A"])
        assert.equal(value.events.filter((event) => event.type === "node.fallback").length, 0)
        assert.match((await command({ action: "retry", run_id: created.runID, node_id: "work" })).error, /unresolved/)
        assert.match((await command({ action: "resume", run_id: created.runID })).error, /unresolved/)
        assert.match((await command({ action: "amend", run_id: created.runID, definition: { schemaVersion: 1, name: marker, nodes: [node(marker, extra)] } })).error, /unresolved/)
        assert.ok((await inbox(child)).some((item) => item.id === queued.data.id))
        artifact(marker, { value, inbox: await inbox(child) }); passed(`${marker} refuses rescue preserving queued requirement`)
        if (marker === "hidden-fallback") {
          const path = join(env.IOLAUS_HOME, "iolaus.json"), enabled = readFileSync(path, "utf8")
          writeFileSync(path, JSON.stringify({ ...JSON.parse(enabled), rescue: { ownerModel: false } }))
          await api("POST", "/api/location/reload"); await view(created.runID)
          assert.match((await command({ action: "retry", run_id: created.runID, node_id: "work" })).error, /unresolved/)
          assert.match((await command({ action: "resume", run_id: created.runID })).error, /unresolved/)
          assert.match((await command({ action: "amend", run_id: created.runID, definition: { schemaVersion: 1, name: marker, nodes: [node(marker, extra)] } })).error, /unresolved/)
          assert.deepEqual(childRequests(marker).map((entry) => entry.model), ["A"])
          assert.ok((await inbox(child)).some((item) => item.id === queued.data.id))
          artifact("blocked-after-config-change", { value: await snapshot(created.runID), inbox: await inbox(child) })
          writeFileSync(path, enabled)
          await api("POST", "/api/location/reload"); await view(created.runID)
          passed("persisted unsafe history remains non-replayable after disabling rescue and reloading")
        }
      }
      for (const marker of ["unknown", "opaque", "opaque-fallback", "opaque-attempt"]) {
        const extra = marker === "opaque-fallback" ? { fallbackModels: ["openai/B", "openai/C"], maxAttempts: 3 } : marker === "opaque-attempt" ? { maxAttempts: 3 } : {}
        const created = await create(marker, extra); release(`${marker}:failure`)
        await completed(created.runID, "failed")
        const value = await snapshot(created.runID)
        assert.equal(value.run.nodes[0].recovery.rescue, undefined); assert.equal(childRequests(marker).filter((item) => item.path === "/rescue/responses").length, 0)
        assert.equal(value.run.nodes[0].attempt, 1)
        assert.equal(value.events.filter((event) => event.type === "node.fallback").length, 0)
        if (marker.startsWith("opaque")) {
          assert.equal(value.run.nodes[0].recovery.blocked, "opaque_tool_history")
          const history = await context(value.run.nodes[0].execution.sessionID)
          assert.equal(history.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool" && part.name === "shell" && part.state.status === "completed").length, 1)
        }
        if (marker === "unknown") assert.equal((await context(value.run.nodes[0].execution.sessionID)).at(-1).error.type, "unknown")
        artifact(marker, value); passed(`${marker} history/error refused`)
      }
      const denied = await create("denied"); await completed(denied.runID)
      const deniedSnapshot = await snapshot(denied.runID)
      const deniedContext = await context(deniedSnapshot.run.nodes[0].execution.sessionID)
      assert.ok(!existsSync(join(project, "blocked.txt")))
      assert.ok(deniedContext.flatMap((message) => message.content ?? []).some((part) => part.type === "tool" && part.name === "write" && part.state.status === "error" && /denied|permission/i.test(JSON.stringify(part.state))))
      artifact("denied-tool", { deniedSnapshot, deniedContext }); passed("actual denied native edit proves inherited restrictions on rescue child")

      const switchOwner = (model) => api("POST", `/api/session/${owner}/model`, { model })
      for (const variant of [undefined, "default"]) {
        released.delete("dedupe:failure")
        const created = await create("dedupe")
        await until(() => holds.has("dedupe:failure"), "dedupe failure")
        await switchOwner({ providerID: "openai", id: "A", ...(variant ? { variant } : {}) })
        release("dedupe:failure"); await completed(created.runID, "failed")
        const value = await snapshot(created.runID)
        assert.ok(value.events.some((event) => event.type === "node.rescue-skipped" && event.payload.reason === "owner_model_already_failed"))
        assert.equal(value.run.nodes[0].attempt, 1)
        await switchOwner({ providerID: "rescue", id: "owner", variant: "actual" })
        passed(`canonical failed owner deduplication (${variant ?? "omitted"} variant)`)
      }
      for (const [marker, action, resource] of [["auth-flow", "iolaus_flow", "*"], ["auth-delegate", "subagent", "quick"]]) {
        const created = await create(marker)
        await until(() => holds.has(`${marker}:failure`), marker)
        await api("PATCH", `/api/session/${owner}`, { permissions: [{ action, resource, effect: "deny" }] })
        release(`${marker}:failure`); await completed(created.runID, "failed")
        await api("PATCH", `/api/session/${owner}`, { permissions: [] })
        const value = await snapshot(created.runID)
        assert.equal(value.run.nodes[0].recovery.rescue, undefined)
        assert.match(value.run.nodes[0].recovery.blocked, /permission/)
        artifact(marker, value); passed(`${marker} rechecked at recovery`)
      }
      const planning = await create("planning-owner")
      await until(() => holds.has("planning-owner:failure"), "planning owner")
      await api("POST", `/api/session/${owner}/agent`, { agent: "prometheus" })
      release("planning-owner:failure"); await completed(planning.runID, "failed")
      await api("POST", `/api/session/${owner}/agent`, { agent: "build" })
      const planningSnapshot = await snapshot(planning.runID)
      assert.equal(planningSnapshot.run.nodes[0].recovery.rescue, undefined)
      assert.match(planningSnapshot.run.nodes[0].recovery.blocked, /planning|planner|hyperplan/i)
      artifact("planning-owner", planningSnapshot); passed("planning owner refused at recovery")
      for (const extra of [{ agent: "atlas", fallbackModels: ["openai/B", "openai/C"], maxAttempts: 5 }, { agent: "prometheus", fallbackModels: ["openai/B", "openai/C"], maxAttempts: 5 }, { kind: "judge", agent: "momus", fallbackModels: ["openai/B", "openai/C"], maxAttempts: 5 }]) {
        const marker = extra.kind ?? extra.agent
        const created = await create(marker, extra)
        await completed(created.runID, "failed")
        const value = await snapshot(created.runID)
        assert.equal(value.run.nodes[0].recovery.rescue, undefined)
        assert.equal(childRequests(marker).filter((item) => item.path === "/rescue/responses").length, 0)
        assert.deepEqual(childRequests(marker).map((entry) => entry.model), ["A", "B", "C", "C", "C"])
        assert.equal(value.run.nodes[0].recovery.blocked, undefined)
        assert.equal(value.run.nodes[0].recovery.handoff, undefined)
        if (extra.kind === "judge") {
          assert.deepEqual(childRequests(marker).map((entry) => entry.model), ["A", "B", "C", "C", "C"])
          assert.equal(value.run.nodes[0].attempt, 5)
          assert.equal(value.run.nodes[0].recovery.blocked, undefined)
          assert.equal(value.run.nodes[0].recovery.handoff, undefined)
          assert.equal(value.events.filter((event) => event.type === "node.fallback").length, 2)
          assert.equal(value.events.filter((event) => event.type === "node.rescued" || event.type === "node.rescue-skipped").length, 0)
        }
        artifact(marker, value); passed(`${marker} execution excluded`)
        const retry = await command({ action: "retry", run_id: created.runID, node_id: "work" })
        assert.equal(retry.error, undefined, JSON.stringify(retry)); await completed(created.runID, "failed")
        assert.deepEqual(childRequests(marker).slice(5).map((entry) => entry.model), ["A", "B", "C"])
        passed(`${marker} excluded failure keeps explicit retry and planned chain`)
      }
      const initialPlanner = await session("prometheus")
      for (const [lane, sessionID] of [["atlas", owner], ["prometheus", owner], ["quick", initialPlanner]]) {
        const marker = `excluded-success-${lane}`
        const task = node(marker, { agent: lane, fallbackModels: ["openai/B", "openai/C"], maxAttempts: 5 })
        const created = await create(marker, task, sessionID)
        await completed(created.runID, "completed", sessionID)
        const initial = await snapshot(created.runID, sessionID)
        assert.equal(initial.run.nodes[0].recovery.blocked, undefined)
        assert.equal(initial.run.nodes[0].recovery.handoff, undefined)
        assert.equal(initial.run.nodes[0].recovery.rescue, undefined)
        const retry = await command({ action: "retry", run_id: created.runID, node_id: "work" }, sessionID)
        assert.equal(retry.error, undefined, JSON.stringify(retry)); await completed(created.runID, "completed", sessionID)
        const amend = await command({ action: "amend", run_id: created.runID, definition: { schemaVersion: 1, name: marker, nodes: [{ ...task, prompt: `QA_CASE:${marker} AMENDED_EXCLUDED_TASK` }] } }, sessionID)
        assert.equal(amend.error, undefined, JSON.stringify(amend)); await completed(created.runID, "completed", sessionID)
        const final = await snapshot(created.runID, sessionID)
        assert.equal(final.run.nodes[0].recovery.blocked, undefined)
        assert.equal(final.run.nodes[0].recovery.handoff, undefined)
        assert.equal(final.run.nodes[0].recovery.rescue, undefined)
        assert.equal(final.events.filter((event) => event.type === "node.rescued" || event.type === "node.rescue-skipped").length, 0)
        assert.deepEqual(childRequests(marker).map((entry) => `${entry.path}:${entry.model}`), Array.from({ length: 3 }, () => ["/primary/responses:A", "/primary/responses:B", "/primary/responses:C"]).flat())
        artifact(marker, { initial, final }); passed(`${lane} initial exclusion preserves successful fallback, retry and amend without handoff`)
      }
      const planningFailure = await create("initial-planning-failure", { fallbackModels: ["openai/B", "openai/C"], maxAttempts: 5 }, initialPlanner)
      await completed(planningFailure.runID, "failed", initialPlanner)
      const planningFailureSnapshot = await snapshot(planningFailure.runID, initialPlanner)
      assert.deepEqual(childRequests("initial-planning-failure").map((entry) => entry.model), ["A", "B", "C", "C", "C"])
      assert.equal(planningFailureSnapshot.run.nodes[0].recovery.blocked, undefined)
      assert.equal(planningFailureSnapshot.run.nodes[0].recovery.handoff, undefined)
      assert.equal(planningFailureSnapshot.run.nodes[0].recovery.rescue, undefined)
      artifact("initial-planning-failure", planningFailureSnapshot); passed("initial planning authority keeps ordinary failure budget, unlike later role drift")
      mkdirSync(join(project, ".iolaus/plans/rescue-qa/tickets"), { recursive: true })
      writeFileSync(join(project, ".iolaus/plans/rescue-qa/spec.md"), "# Rescue QA\nProblem: verify exclusions. Solution: fail a mock authorized ticket.\n")
      writeFileSync(join(project, ".iolaus/plans/rescue-qa/tickets/01-work.md"), "# 01: Authorized Exclusion\n\n**Blocked by:** None\n\n- [ ] QA_CASE:authorized result exists\n")
      const atlasOwner = await session("atlas")
      await api("POST", `/api/session/${atlasOwner}/prompt`, { text: "/start-work rescue-qa" }); await wait(atlasOwner)
      const authorized = await until(async () => (await views(atlasOwner)).find((run) => run.status === "failed"), "authorized plan failure")
      const authorizedSnapshot = await snapshot(authorized.runID, atlasOwner)
      assert.ok(authorizedSnapshot.run.authorizedPlan)
      assert.ok(authorizedSnapshot.run.nodes.every((node) => !node.recovery?.rescue))
      artifact("authorized-plan", authorizedSnapshot); passed("authorized Atlas plan failure never launches owner rescue")
      const laneConfigPath = join(env.IOLAUS_HOME, "iolaus.json"), laneConfigText = readFileSync(laneConfigPath, "utf8")
      const laneConfig = JSON.parse(laneConfigText)
      laneConfig.models.agents.atlas = ["openai/A", "openai/B", "openai/C"]
      laneConfig.models.agents.momus = ["openai/A", "openai/B", "openai/C"]
      writeFileSync(laneConfigPath, JSON.stringify(laneConfig)); await api("POST", "/api/location/reload")
      for (const outcome of ["success", "failure"]) {
        const slug = `rescue-exclusion-${outcome}`, planPath = join(project, ".iolaus/plans", slug)
        mkdirSync(join(planPath, "tickets"), { recursive: true })
        writeFileSync(join(planPath, "spec.md"), `# Exclusion QA\nProblem: verify ordinary authorized execution. Solution: exercise excluded ${outcome} model chains.\n`)
        writeFileSync(join(planPath, "tickets/01-work.md"), "# 01: Excluded Chain\n\n**Blocked by:** None\n\n- [ ] Mock result exists\n")
        const sessionID = await session("atlas")
        await api("POST", `/api/session/${sessionID}/prompt`, { text: `/start-work ${slug}` }); await wait(sessionID)
        const plan = await until(async () => (await views(sessionID)).find((value) => value.name === `start-work: ${slug}` && value.status === (outcome === "success" ? "paused" : "failed")), `${slug} model chains`)
        const value = await snapshot(plan.runID, sessionID)
        assert.ok(value.run.authorizedPlan)
        for (const stage of ["ticket", "standards", "spec"]) assert.deepEqual(childRequests(`authorized-excluded-${outcome}-${stage}`).map((entry) => `${entry.path}:${entry.model}`), ["/primary/responses:A", "/primary/responses:B", "/primary/responses:C"])
        for (const record of value.run.nodes) {
          assert.equal(record.recovery?.blocked, undefined)
          assert.equal(record.recovery?.handoff, undefined)
          assert.equal(record.recovery?.rescue, undefined)
        }
        assert.equal(value.run.nodes.find((record) => record.definition.id === "review-standards").definition.kind, undefined)
        assert.equal(value.events.filter((event) => event.type === "node.rescued" || event.type === "node.rescue-skipped").length, 0)
        if (outcome === "success") {
          const approval = await command({ action: "approve", run_id: plan.runID, node_id: "accept" }, sessionID)
          assert.equal(approval.error, undefined, JSON.stringify(approval)); await completed(plan.runID, "completed", sessionID)
        }
        artifact(slug, value); passed(`authorized ${outcome} keeps Atlas and session-backed ordinary reviewers on their configured chains`)
      }
      writeFileSync(laneConfigPath, laneConfigText); await api("POST", "/api/location/reload")
      await command({ agent: "quick", description: "observed failure", prompt: "QA_CASE:observed", background: true }, owner, "subagent")
      const observed = await until(async () => (await views()).find((run) => run.name === "Subagent calls" && run.nodes.some((node) => node.status === "failed")), "observed failure")
      const observedSnapshot = await snapshot(observed.runID)
      assert.ok(observedSnapshot.run.nodes.every((node) => !node.recovery?.rescue))
      artifact("observed", observedSnapshot); passed("native observed failure never launches owner rescue")
      const pending = await create("pending-tool")
      const pendingChild = await until(async () => (await view(pending.runID)).nodes[0].sessionID, "pending child")
      const permissions = await until(async () => { const value = (await api("GET", `/api/session/${pendingChild}/permission`)).data; return value.length && value }, "pending native edit permission")
      await api("POST", `/api/session/${pendingChild}/interrupt`, { resume: false }); await wait(pendingChild)
      await completed(pending.runID, "failed")
      const pendingSnapshot = await snapshot(pending.runID)
      assert.equal(pendingSnapshot.run.nodes[0].recovery.rescue, undefined); assert.ok(!existsSync(join(project, "pending.txt")))
      artifact("pending-tool", { permissions, pendingSnapshot, context: await context(pendingChild) }); passed("actual pending native edit is interrupted without rescue or effect")

      const cancelled = await create("cancel")
      await until(() => holds.has("cancel:rescue"), "running rescue")
      await command({ action: "cancel", run_id: cancelled.runID }); release("cancel:rescue")
      await completed(cancelled.runID, "cancelled")
      const cancelSnapshot = await snapshot(cancelled.runID)
      assert.equal(cancelSnapshot.run.nodes[0].result, undefined)
      assert.equal(cancelSnapshot.run.nodes[0].recovery.rescue.state, "settled")
      assert.match((await command({ action: "retry", run_id: cancelled.runID, node_id: "work" })).error, /unresolved/)
      artifact("cancel", cancelSnapshot); passed("cancel spends rescue and fences late provider response")
      for (const marker of ["cancel-fallback", "cancel-attempt"]) {
        const extra = marker === "cancel-fallback" ? { fallbackModels: ["openai/B"], maxAttempts: 2 } : { maxAttempts: 2 }
        const created = await create(marker, extra)
        await until(() => holds.has(`${marker}:active`), `${marker} completed native work`)
        const active = await snapshot(created.runID), record = active.run.nodes[0]
        const child = record.execution.sessionID, handoff = record.recovery.handoff
        assert.equal(record.attempt, 2)
        assert.equal(record.recovery.rescue, undefined)
        assert.equal(handoff.checkpoints.length, 1)
        assert.notEqual(handoff.checkpoints[0].source.sessionID, child)
        assert.equal(readFileSync(join(project, `${marker}.txt`), "utf8"), "B_NATIVE_WORK\n")
        const history = await context(child)
        assert.equal(history.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool" && part.name === "write" && part.state.status === "completed").length, 1)
        const queued = await queue(child, `PRESERVE_${marker}_B_REQUIREMENT`)
        const count = childRequests(marker).length
        assert.deepEqual(childRequests(marker).map((entry) => `${entry.path}:${entry.model}`), ["/primary/responses:A", ...Array(2).fill(`/primary/responses:${marker === "cancel-fallback" ? "B" : "A"}`)])
        assert.equal((await command({ action: "cancel", run_id: created.runID })).error, undefined)
        release(`${marker}:active`)
        await completed(created.runID, "cancelled"); await wait(child)
        const refuseReplay = async () => {
          assert.match((await command({ action: "retry", run_id: created.runID, node_id: "work" })).error, /unresolved/)
          assert.match((await command({ action: "resume", run_id: created.runID })).error, /unresolved/)
          assert.match((await command({ action: "amend", run_id: created.runID, definition: { schemaVersion: 1, name: marker, nodes: [node(marker, extra)] } })).error, /unresolved/)
          assert.equal(childRequests(marker).length, count)
          assert.ok((await inbox(child)).some((item) => item.id === queued.data.id && item.payload.text === `PRESERVE_${marker}_B_REQUIREMENT`))
          const value = await snapshot(created.runID)
          assert.equal(value.run.status, "cancelled")
          assert.equal(value.run.nodes[0].result, undefined)
          assert.equal(value.run.nodes[0].recovery.blocked, "cancelled_continuation")
          assert.equal(value.run.nodes[0].recovery.rescue, undefined)
          assert.deepEqual(value.run.nodes[0].recovery.handoff, handoff)
          assert.equal(value.events.filter((event) => event.type === "node.completed" || event.type === "node.rescued").length, 0)
          return value
        }
        const cancelled = await refuseReplay()
        await api("POST", "/api/location/reload"); await view(created.runID)
        const reloaded = await refuseReplay()
        const path = join(env.IOLAUS_HOME, "iolaus.json"), enabled = readFileSync(path, "utf8")
        writeFileSync(path, JSON.stringify({ ...JSON.parse(enabled), rescue: { ownerModel: false } }))
        await api("POST", "/api/location/reload"); await view(created.runID)
        const disabled = await refuseReplay()
        writeFileSync(path, enabled)
        await api("POST", "/api/location/reload"); await view(created.runID)
        assert.equal(readFileSync(join(project, `${marker}.txt`), "utf8"), "B_NATIVE_WORK\n")
        artifact(marker, { active, cancelled, reloaded, disabled, history, inbox: await inbox(child), childRequests: count })
        passed(`${marker} cancellation preserves B work and queued input, blocks stale A replay across reload and rescue disable with zero extra child requests`)
      }
      const excludedCancel = await create("cancel-excluded", {}, initialPlanner)
      await until(() => holds.has("cancel-excluded:active"), "initially excluded active cancellation")
      const excludedActive = await snapshot(excludedCancel.runID, initialPlanner)
      assert.equal(excludedActive.run.nodes[0].recovery.initialRoleAllowed, false)
      assert.equal((await command({ action: "cancel", run_id: excludedCancel.runID }, initialPlanner)).error, undefined)
      release("cancel-excluded:active")
      await completed(excludedCancel.runID, "cancelled", initialPlanner)
      const excludedCancelled = await snapshot(excludedCancel.runID, initialPlanner)
      assert.equal(excludedCancelled.run.nodes[0].recovery.blocked, undefined)
      assert.equal(excludedCancelled.run.nodes[0].recovery.handoff, undefined)
      assert.equal((await command({ action: "retry", run_id: excludedCancel.runID, node_id: "work" }, initialPlanner)).error, undefined)
      await completed(excludedCancel.runID, "completed", initialPlanner)
      assert.equal((await command({ action: "amend", run_id: excludedCancel.runID, definition: { schemaVersion: 1, name: "cancel-excluded", nodes: [node("cancel-excluded", { prompt: "QA_CASE:cancel-excluded AMENDED_TASK" })] } }, initialPlanner)).error, undefined)
      await completed(excludedCancel.runID, "completed", initialPlanner)
      const excludedRetried = await snapshot(excludedCancel.runID, initialPlanner)
      assert.equal(excludedRetried.run.nodes[0].recovery.blocked, undefined)
      assert.equal(excludedRetried.run.nodes[0].recovery.rescue, undefined)
      assert.deepEqual(childRequests("cancel-excluded").map((entry) => `${entry.path}:${entry.model}`), Array(3).fill("/primary/responses:A"))
      artifact("cancel-excluded", { active: excludedActive, cancelled: excludedCancelled, retried: excludedRetried })
      passed("initial planning exclusion still cancels, retries and amends normally without unsafe-history poisoning")
      const reloaded = await create("reload-running")
      await until(() => holds.has("reload-running:rescue"), "reload rescue")
      const runningID = (await view(reloaded.runID)).nodes[0].sessionID
      await api("POST", "/api/location/reload"); await view(reloaded.runID)
      release("reload-running:rescue"); await completed(reloaded.runID)
      const reloadSnapshot = await snapshot(reloaded.runID)
      assert.equal(reloadSnapshot.run.nodes[0].execution.sessionID, runningID)
      assert.equal(childRequests("reload-running").filter((entry) => entry.path === "/rescue/responses").length, 1)
      artifact("reload-running", reloadSnapshot); passed("reload reattaches admitted rescue without prompt replay")

      const bundlePath = join(plugin, "dist/index.js"), pauses = join(sandbox, "pauses")
      mkdirSync(pauses)
      let bundle = readFileSync(bundlePath, "utf8")
      const runnerEffect = bundle.match(/const admit = \(ref\) => (\w+)\.gen/)?.[1]
      const controllerEffect = bundle.match(/const final = yield\* (\w+)\.exit/)?.[1]
      assert.ok(runnerEffect && controllerEffect)
      const pause = (effect, key, id) => `yield* ${effect}.promise(() => __rescuePause(${JSON.stringify(key)}, ${id}));`
      instrumentation = [
        { label: "capture", match: `      const handoff = yield* ${runnerEffect}.try({ try: () => checkpoint(input, messages)`, replacement: `      if (input.ref.nodeID === 'capture') ${pause(runnerEffect, "capture", "input.ref.sessionID")}\n      const handoff = yield* ${runnerEffect}.try({ try: () => checkpoint(input, messages)` },
        { label: "admission", match: "    const handoff = pendingHandoffs.get(ref.sessionID);", replacement: `    const handoff = pendingHandoffs.get(ref.sessionID);\n    if (handoff && ['admission-source', 'admission-child'].includes(ref.nodeID)) yield* ${runnerEffect}.promise(() => __rescuePause(ref.nodeID, ref.sessionID));` },
        { label: "refinalization", match: `      const final = yield* ${controllerEffect}.exit`, replacement: `      if (nodeID === 'refinalization') ${pause(controllerEffect, "refinalization", "live.execution.sessionID")}\n      const final = yield* ${controllerEffect}.exit` },
        { label: "reservation", match: '        event(updated, "node.rescued", nodeID,', replacement: '        event(updated, "node.rescued", nodeID,' },
        { label: "oldref", match: "      pendingPrompts.set(String(session.id), prompt);", replacement: `      if (input.handoff && input.node.id === 'oldref') ${pause(runnerEffect, "oldref", "String(session.id)")}\n      pendingPrompts.set(String(session.id), prompt);` },
      ]
      const reservation = instrumentation.find((entry) => entry.label === "reservation")
      reservation.match = bundle.split("\n").find((line) => line.includes('event(updated, "node.rescued", nodeID,'))
      reservation.replacement = `${reservation.match}\n        if (['pinned', 'reserved-reload'].includes(nodeID)) yield* ${controllerEffect}.promise(() => __rescuePause(nodeID, live.execution.sessionID));`
      for (const injection of instrumentation) {
        assert.equal(bundle.split(injection.match).length, 2, `unique injection seam ${injection.label}`)
        bundle = bundle.replace(injection.match, injection.replacement)
      }
      bundle = `import { existsSync as __rescueExists, writeFileSync as __rescueWrite } from 'node:fs';\nasync function __rescuePause(key, sessionID) { const path = ${JSON.stringify(pauses)} + '/' + key; if (__rescueExists(path + '.release')) return; __rescueWrite(path + '.hit', sessionID); while (!__rescueExists(path + '.release')) await new Promise(done => setTimeout(done, 20)); }\n` + bundle
      artifact("fault-injection", { scope: "sandbox plugin bundle only after unmodified scenarios; no host patch changes or substitute inbox", originalHash: hash(bundlePath), injections: instrumentation })
      writeFileSync(bundlePath, bundle)
      await api("POST", "/api/location/reload")
      const hit = async (key) => { await until(() => existsSync(join(pauses, `${key}.hit`)), key); return readFileSync(join(pauses, `${key}.hit`), "utf8") }
      const unpause = (key) => writeFileSync(join(pauses, `${key}.release`), "release")
      for (const marker of ["capture", "admission-source", "admission-child", "refinalization"]) {
        const created = await create(marker, { id: marker })
        const pausedID = await hit(marker)
        const database = join(env.IOLAUS_HOME, "iolaus.db")
        const recovery = JSON.parse(execFileSync("sqlite3", [database, `SELECT value_json FROM dag_node_recovery WHERE run_id='${created.runID}' AND node_id='${marker}'`], { encoding: "utf8" }))
        const target = marker === "admission-source" ? recovery.handoff.checkpoints[0].source.sessionID : pausedID
        const queued = await queue(target, `PRESERVE_${marker}`)
        unpause(marker); await completed(created.runID, "failed")
        const value = await snapshot(created.runID)
        assert.equal(value.run.nodes[0].result, undefined)
        assert.ok((await inbox(target)).some((item) => item.id === queued.data.id))
        assert.match(JSON.stringify(value), /pending_host_input/)
        if (marker.startsWith("admission")) assert.equal((await context(pausedID)).filter((item) => item.type === "user").length, 0)
        artifact(marker, { value, inbox: await inbox(target) }); passed(`${marker} hidden queue refuses continuation/publication without consumption`)
      }
      for (const marker of ["pinned", "reserved-reload"]) {
        const created = await create(marker, { id: marker })
        await hit(marker)
        const reserved = JSON.parse(execFileSync("sqlite3", [join(env.IOLAUS_HOME, "iolaus.db"), `SELECT value_json FROM dag_node_recovery WHERE run_id='${created.runID}' AND node_id='${marker}'`], { encoding: "utf8" }))
        assert.equal(reserved.rescue.state, "reserved"); assert.equal(reserved.rescue.pinnedModel, "rescue/owner#actual")
        await switchOwner({ providerID: "openai", id: "B" })
        if (marker === "reserved-reload") {
          await api("POST", "/api/location/reload")
          await context(owner)
          await until(async () => (await api("GET", `/api/agent?${new URLSearchParams({ "location[directory]": project })}`)).data.some((agent) => agent.id === "quick"), "quick registration after reload")
          unpause(marker)
        } else unpause(marker)
        await completed(created.runID)
        const value = await snapshot(created.runID)
        assert.equal(value.run.nodes[0].result.provenance.model, "rescue/owner#actual")
        assert.equal(value.events.filter((event) => event.type === "node.rescued").length, 1)
        assert.equal(childRequests(marker).filter((entry) => entry.path === "/rescue/responses").length, 1)
        await switchOwner({ providerID: "rescue", id: "owner", variant: "actual" })
        artifact(marker, { reserved, value }); passed(`${marker} keeps pinned model after owner selection changes`)
      }
      const late = await create("oldref", { id: "oldref" })
      const lateID = await hit("oldref")
      await command({ action: "cancel", run_id: late.runID }); unpause("oldref")
      await completed(late.runID, "cancelled"); await sleep(100)
      assert.equal((await context(lateID)).length, 0)
      const lateSnapshot = await snapshot(late.runID)
      assert.equal(lateSnapshot.run.nodes[0].result, undefined)
      assert.equal(childRequests("oldref").filter((entry) => entry.path === "/rescue/responses").length, 0)
      artifact("late-ref", lateSnapshot); passed("cancel fences late-created rescue reference before prompt admission")
    }
  }
  const processTable = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
  const pids = [server.pid]
  for (const parent of pids) for (const [pid, ppid] of processTable) if (ppid === parent) pids.push(pid)
  databasePaths = execFileSync("lsof", ["-Fn", "-p", pids.join(",")], { encoding: "utf8" }).split("\n").filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line)).map((line) => line.slice(1))
  assert.ok(databasePaths.some((path) => path === join(env.XDG_DATA_HOME, mode === "patched" ? "opencode/opencode-local.db" : "opencode/opencode.db")))
  if (mode !== "stock-on") assert.ok(databasePaths.includes(join(env.IOLAUS_HOME, "iolaus.db")))
  assert.ok(databasePaths.every((path) => path.startsWith(`${sandbox}/`)))
  assert.deepEqual(errors, []); passed("private host opened only sandbox databases", { databasePaths })
} catch (error) { failure = String(error.stack ?? error) }
finally {
  const cleanup = async (name, action) => { try { await action() } catch (error) { cleanupErrors.push(`${name}: ${error.stack ?? error}`) } }
  for (const key of holds.keys()) release(key)
  await cleanup("server", async () => {
    if (!server?.pid) return
    const signal = (name) => { try { process.kill(-server.pid, name) } catch (error) { if (error.code !== "ESRCH") throw error } }
    signal("SIGTERM"); const watchdog = setTimeout(() => signal("SIGKILL"), 4000)
    try { await exited } finally { clearTimeout(watchdog); signal("SIGKILL") }
    await until(() => { try { process.kill(-server.pid, 0); return false } catch (error) { if (error.code === "ESRCH") return true; throw error } }, "process cleanup", 5000)
    processGone = true
  })
  await cleanup("mock", async () => { for (const socket of sockets) socket.destroy(); mock.closeAllConnections(); if (mock.listening) await new Promise((done) => mock.close(done)); await until(() => sockets.size === 0, "socket cleanup", 5000) })
  await cleanup("logs", () => { const path = join(sandbox ?? "", "data/opencode/log"); if (existsSync(path)) cpSync(path, join(evidence, "host-logs"), { recursive: true }); writeFileSync(join(evidence, "server.log"), log.replace(/server password \S+/g, "server password <REDACTED>")) })
  await cleanup("sandbox", () => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }) })
}
const after = hostState()
try { assert.deepEqual(after, before) } catch (error) { cleanupErrors.push(String(error.stack ?? error)) }
const cleanup = { sandboxRemoved: !sandbox || !existsSync(sandbox), processGone, mockClosed: !mock.listening, sockets: sockets.size }
const verdict = failure || cleanupErrors.length ? "FAIL" : mode === "stock-on" ? "UNSUPPORTED" : "PASS"
const receipt = { verdict, mode, failure, checks, errors, cleanupErrors, cleanup, isolation: { env, before, after, databasePaths }, instrumentation,
  limits: ["API-driven native sessions, not a TUI cursor/draft interaction test.", "Mock providers prove protocol and scheduling behavior, not remote-provider availability.", "Unknown-error case injects a child-only native context-hook defect; exact provider.unknown is separately unit-tested. No provider retry policy is suppressed.", "Pending native tool is interrupted at a real permission wait; failed-terminal incomplete tool history is separately unit-tested.", "Stock opt-in UNSUPPORTED is not a feature pass. Inbox reads are point-in-time, not atomic transfer or exactly-once execution."] }
artifact("receipt", receipt)
console.log(JSON.stringify({ verdict, checks: checks.length, failure, cleanup, cleanupErrors }, null, 2))
process.exitCode = verdict === "FAIL" ? 1 : mode === "stock-on" ? 2 : 0
