// Live QA: model fallback and owner-model rescue continue the failed child session (same session, switched model)
// on a stock OpenCode host, in an isolated HOME/XDG sandbox with a local mock provider.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const evidence = resolve(process.argv[2] ?? join(root, ".iolaus/evidence/owner-rescue/same-session-live"))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence")}/`))
mkdirSync(evidence, { recursive: false })
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const requests = [], checks = [], errors = [], cleanupErrors = [], holds = new Map(), released = new Set()
let sandbox, env, server, exited, serverError, version, failure, log = ""
const hostState = () => Object.fromEntries([".iolaus/iolaus.json", ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc", ".config/opencode/cli.json"]
  .map((file) => join(homedir(), file)).map((path) => [path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent"]))
const before = hostState()
const until = async (read, label, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(50) }
  throw new Error(`timeout: ${label}`)
}
const hold = async (key) => { if (released.has(key)) return; await new Promise((done) => { const list = holds.get(key) ?? []; list.push(done); holds.set(key, list) }) }
const release = (key) => { released.add(key); for (const done of holds.get(key) ?? []) done(); holds.delete(key) }
const passed = (name, detail = {}) => { checks.push({ name, verdict: "PASS", ...detail }); writeFileSync(join(evidence, "assertions.json"), JSON.stringify(checks, null, 2)) }

function events(id, model, text, call) {
  const result = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model } }]
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
const providerFailure = (response) => response.writeHead(401, { "content-type": "application/json" })
  .end(JSON.stringify({ error: { message: "qa: provider auth failure", type: "invalid_request_error", code: "invalid_api_key" } }))
const mock = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") return response.writeHead(404).end()
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()), input = body.input ?? []
    const all = JSON.stringify(input)
    const lastUser = input.findLastIndex((item) => item.type === "message" && item.role === "user" && !/Iolaus Flow notice/.test(JSON.stringify(item)))
    const command = JSON.stringify(input[lastUser] ?? "").match(/QA_COMMAND:([A-Za-z0-9+/=]+)/)?.[1]
    const first = JSON.stringify(input.find((item) => item.type === "message" && item.role === "user") ?? "")
    const marker = body.tools?.length && !command ? first.match(/QA_CHILD:([a-z-]+)/)?.[1] : undefined
    const outputs = input.filter((item) => item.type === "function_call_output")
    const record = { sequence: requests.length, model: body.model, marker, command: command !== undefined, toolOutputs: outputs.length,
      sawStep: all.includes("STEP_A"), sawContinuation: all.includes("<iolaus-continuation"), sawSupplement: all.includes("QA_SUPPLEMENT"), sawTask: all.includes("QA_CHILD:") }
    requests.push(record); appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify({ ...record, input }) + "\n")
    assert.ok(requests.length < 120, "unexpected provider loop")
    const reply = (text, call) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const event of events(`qa_${record.sequence}`, body.model, text, call)) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end("data: [DONE]\n\n")
    }
    if (!body.tools?.length) return reply("QA_TITLE")
    if (command) {
      const fresh = input.slice(lastUser).filter((item) => item.type === "function_call_output")
      return fresh.length ? reply("QA_OWNER_OK") : reply("", JSON.parse(Buffer.from(command, "base64").toString()))
    }
    if (marker === "rescue") {
      if (body.model === "gpt-a") return outputs.length ? providerFailure(response) : reply("", { name: "shell", args: { command: "echo STEP_A >> progress.txt && cat progress.txt", description: "qa step" } })
      if (body.model === "gpt-b") return providerFailure(response)
      return reply(`RESCUED_DONE step=${record.sawStep}`)
    }
    if (marker === "steer") {
      if (body.model === "gpt-a") { if (!record.sawSupplement) await hold("steer:a"); return providerFailure(response) }
      return reply(`STEER_DONE supplement=${record.sawSupplement}`)
    }
    return reply("QA_UNKNOWN")
  } catch (error) { errors.push(String(error.stack ?? error)); response.writeHead(500).end() }
})

try {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-rescue-qa-")))
  const home = join(sandbox, "home"), project = join(sandbox, "project"), config = join(sandbox, "config"), iolaus = join(home, ".iolaus"), plugin = join(sandbox, "plugin")
  env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, IOLAUS_HOME: iolaus, IOLAUS_TRACE: join(evidence, "trace.ndjson"),
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
    OPENCODE_TEST_HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
  for (const path of [home, project, join(config, "opencode"), iolaus, plugin]) mkdirSync(path, { recursive: true })
  cpSync(join(root, "dist"), join(plugin, "dist"), { recursive: true })
  symlinkSync(join(root, "node_modules"), join(plugin, "node_modules"), "dir")
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "opencode-iolaus", type: "module", main: "./dist/index.js" }))
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  writeFileSync(join(iolaus, "iolaus.json"), JSON.stringify({ mcps: [], gh: false, astGrep: false, verify: false, rescue: { ownerModel: true },
    models: { agents: { sisyphus: "openai/gpt-owner" }, categories: { "deep-low": ["openai/gpt-a", "openai/gpt-b"] } } }))
  const model = (id) => [id, { tool_call: true, limit: { context: 200000, output: 8192 } }]
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({ plugins: [{ package: join(plugin, "dist") }], model: "openai/gpt-owner", default_agent: "build",
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    provider: { openai: { options: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: Object.fromEntries(["gpt-a", "gpt-b", "gpt-owner"].map(model)) } } }))
  version = execFileSync(binary, ["--version"], { env, cwd: project, encoding: "utf8" }).trim()
  passed("host version", { version, binary })
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  exited = new Promise((done) => { server.once("exit", done); server.once("error", (error) => { serverError = error; done() }) })
  server.stdout.on("data", (data) => { log += data }); server.stderr.on("data", (data) => { log += data })
  const base = await until(() => { if (serverError) throw serverError; return log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] }, "server")
  const password = await until(() => log.match(/server password (\S+)/)?.[1], "password")
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(60000), headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text(); assert.ok(response.ok, `${method} ${path} ${response.status}: ${text}`); return text ? JSON.parse(text) : undefined
  }
  const wait = (id) => api("POST", `/api/experimental/session/${id}/wait`)
  const context = async (id) => (await api("GET", `/api/session/${id}/context`)).data
  const info = async (id) => (await api("GET", `/api/session/${id}`)).data
  const owner = (await api("POST", "/api/session", { agent: "sisyphus", model: { providerID: "openai", id: "gpt-owner" }, location: { directory: project } })).data.id
  const command = async (args) => {
    const encoded = Buffer.from(JSON.stringify({ name: "iolaus_flow", args })).toString("base64")
    const mark = requests.length
    await api("POST", `/api/session/${owner}/prompt`, { text: `QA_COMMAND:${encoded}` }); await wait(owner)
    const raw = readFileSync(join(evidence, "requests.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).slice(mark)
    const output = raw.filter((item) => item.command && item.toolOutputs).at(-1)?.input.filter((entry) => entry.type === "function_call_output").at(-1)?.output
    assert.ok(output, `no tool receipt for ${args.action}`)
    try { return JSON.parse(output) } catch { return { error: output } }
  }
  const view = async (runID) => (await api("POST", `/api/rpc/iolaus-dag/snapshot?location[directory]=${encodeURIComponent(project)}`, { input: { sessionID: owner } })).output.runs.find((run) => run.runID === runID)
  const settled = (runID) => until(async () => { const run = await view(runID); return ["completed", "failed", "cancelled"].includes(run?.status) && run }, `run ${runID} settled`, 60000)
  const node = (marker) => ({ id: "work", title: marker, agent: "deep-low", prompt: `QA_CHILD:${marker} finish the task`, dependsOn: [] })
  const snapshot = async (runID) => command({ action: "snapshot", run_id: runID })
  const childMessages = (messages) => messages.filter((item) => item.type === "user" || item.type === "synthetic" || item.type === "model-switched").map((item) => item.type)

  // 1. Fallback then owner rescue, all in one child session, after a real tool effect.
  const rescue = await command({ action: "create", definition: { schemaVersion: 1, name: "rescue", nodes: [node("rescue")] } })
  assert.ok(rescue.runID, JSON.stringify(rescue))
  const rescued = await settled(rescue.runID)
  const work = rescued.nodes.find((item) => item.id === "work")
  assert.equal(rescued.status, "completed", JSON.stringify(rescued))
  assert.match(work.result ?? "", /RESCUED_DONE step=true/)
  const rescueSnapshot = await snapshot(rescue.runID)
  writeFileSync(join(evidence, "rescue-snapshot.json"), JSON.stringify(rescueSnapshot, null, 2))
  const types = rescueSnapshot.events.map((item) => item.type)
  assert.equal(types.filter((type) => type === "node.fallback").length, 1)
  assert.equal(types.filter((type) => type === "node.rescued").length, 1)
  const record = rescueSnapshot.run.nodes.find((item) => item.definition.id === "work")
  assert.equal(record.result.provenance.rescue.model, "openai/gpt-owner")
  assert.equal(record.result.provenance.rescue.from, "openai/gpt-b")
  const childSessions = [...new Set(requests.filter((item) => item.marker === "rescue").map((item) => item.model))]
  assert.deepEqual(childSessions, ["gpt-a", "gpt-b", "gpt-owner"])
  const session = await info(work.sessionID)
  const messages = await context(work.sessionID)
  writeFileSync(join(evidence, "rescue-session.json"), JSON.stringify({ session, messages }, null, 2))
  assert.equal(session.agent, "deep-low")
  assert.deepEqual([session.model.providerID, session.model.id], ["openai", "gpt-owner"])
  assert.equal(readFileSync(join(project, "progress.txt"), "utf8").trim(), "STEP_A")
  const ownerTurn = requests.find((item) => item.marker === "rescue" && item.model === "gpt-owner")
  assert.ok(ownerTurn.sawTask && ownerTurn.sawStep && ownerTurn.sawContinuation, JSON.stringify(ownerTurn))
  assert.equal(record.execution.sessionID, work.sessionID)
  passed("fallback and owner rescue continue one child session after a real tool effect", {
    sessionID: work.sessionID, events: types, models: childSessions, sessionModel: session.model, agent: session.agent,
    progress: "STEP_A (once, not replayed)", historyInputs: childMessages(messages), provenance: record.result.provenance })

  // 2. A delivered supplement survives a provider failure: the fallback continues the steered session.
  const steered = await command({ action: "create", definition: { schemaVersion: 1, name: "steer", nodes: [node("steer")] } })
  await until(() => holds.has("steer:a"), "steer child first turn")
  const nodeView = await until(async () => { const run = await view(steered.runID); const item = run?.nodes.find((value) => value.id === "work"); return item?.sessionID && item.status === "running" && item }, "steer node running")
  await sleep(200)
  const receipt = await command({ action: "steer", run_id: steered.runID, node_id: "work", request_id: "qa-supplement", text: "QA_SUPPLEMENT also mention fontsource" })
  assert.ok(receipt.state === "admitted" || receipt.state === "delivered", JSON.stringify(receipt))
  release("steer:a")
  const steerRun = await settled(steered.runID)
  const steerSnapshot = await snapshot(steered.runID)
  writeFileSync(join(evidence, "steer-snapshot.json"), JSON.stringify(steerSnapshot, null, 2))
  assert.equal(steerRun.status, "completed", JSON.stringify(steerSnapshot.events.map((item) => [item.type, item.payload])))
  const steerWork = steerRun.nodes.find((item) => item.id === "work")
  assert.match(steerWork.result ?? "", /STEER_DONE supplement=true/)
  assert.equal(steerWork.sessionID, nodeView.sessionID)
  const steerMessages = await context(nodeView.sessionID)
  assert.equal(steerMessages.filter((item) => item.type === "synthetic" && item.text?.includes("QA_SUPPLEMENT")).length, 1)
  assert.deepEqual(steerSnapshot.steering.map((item) => item.state), ["delivered"])
  passed("a steered node falls back in the same session with its supplement delivered once", {
    sessionID: nodeView.sessionID, events: steerSnapshot.events.map((item) => item.type), historyInputs: childMessages(steerMessages), steering: steerSnapshot.steering.map((item) => item.state) })
  assert.deepEqual(errors, [])
} catch (error) { failure = String(error.stack ?? error) }
finally {
  for (const key of [...holds.keys()]) release(key)
  try {
    if (server?.pid && server.exitCode === null) {
      try { process.kill(-server.pid, "SIGTERM") } catch {}
      await Promise.race([exited, sleep(5000)])
      try { process.kill(-server.pid, "SIGKILL") } catch {}
    }
  } catch (error) { cleanupErrors.push(String(error)) }
  mock.closeAllConnections(); mock.close()
  writeFileSync(join(evidence, "server.log"), log.replace(/server password \S+/g, "server password <REDACTED>"))
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
}
const after = hostState()
const cleanup = { sandboxRemoved: !sandbox || !existsSync(sandbox), hostUnchanged: JSON.stringify(after) === JSON.stringify(before) }
if (cleanupErrors.length || Object.values(cleanup).some((value) => !value)) failure = [failure, ...cleanupErrors, "cleanup failed"].filter(Boolean).join("\n")
const receipt = { verdict: failure ? "FAIL" : "PASS", failure, version, checks, errors, cleanup, command: `node script/qa-owner-rescue.mjs ${evidence}`,
  limitations: ["Mock OpenAI-compatible provider; one provider family, so cross-provider history conversion is covered only by same-session-probe/run3.", "API sessions only, no TUI."] }
writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ verdict: receipt.verdict, failure, checks: checks.map((item) => item.name), cleanup }, null, 2))
process.exitCode = failure ? 1 : 0
