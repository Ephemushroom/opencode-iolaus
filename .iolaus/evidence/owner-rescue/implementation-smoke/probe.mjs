import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const evidence = dirname(fileURLToPath(import.meta.url))
const source = "/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode/owner-rescue-opencode-2.0.27"
const launcher = join(root, ".iolaus/evidence/owner-rescue/upstream-inbox/patched-opencode.sh")
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const state = () => Object.fromEntries([join(homedir(), ".iolaus/iolaus.json"), join(homedir(), ".config/opencode/opencode.json"), join(homedir(), ".config/opencode/cli.json"), "/opt/homebrew/bin/opencode"].map((path) => [path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null]))
const before = state(), requests = [], sockets = new Set(), cleanupErrors = []
let server, sandbox, exited, log = "", failure, release, receipt = {}
const mock = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") return response.writeHead(404).end()
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    assert.ok(requests.length < 50)
    const input = body.input ?? []
    const lastUser = input.findLastIndex((item) => item.role === "user" && !JSON.stringify(item).includes("Iolaus Flow notice"))
    const command = JSON.stringify(input[lastUser] ?? "").match(/QA_COMMAND:([A-Za-z0-9+/=]+)/)?.[1]
    if (body.tools?.length && body.model === "gpt-5.4") {
      if (JSON.stringify(input).includes("QA_PENDING_CHILD")) await new Promise((done) => { release = done })
      return response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "QA auth outage", type: "invalid_api_key", code: "invalid_api_key" } }))
    }
    const id = `qa_${requests.length}`
    const events = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: body.model } }]
    if (command && !input.slice(lastUser).some((item) => item.type === "function_call_output")) {
      const args = Buffer.from(command, "base64").toString()
      events.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id, call_id: id, name: "iolaus_flow", arguments: "" } }, { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: args }, { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id, call_id: id, name: "iolaus_flow", arguments: args, status: "completed" } })
    } else {
      const text = body.tools?.length && !command ? "QA_RESCUED_RESULT" : "QA_OWNER_AVAILABLE"
      events.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id } }, { type: "response.output_text.delta", item_id: id, output_index: 0, delta: text }, { type: "response.output_item.done", output_index: 0, item: { type: "message", id } })
    }
    events.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) { failure = String(error.stack ?? error); response.writeHead(500).end() }
})
mock.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
async function until(read, label) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(40) }
  throw new Error(`Timeout ${label}: ${log.slice(-2000)}`)
}
try {
  sandbox = realpathSync(mkdtempSync("/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode/rescue-smoke-"))
  const home = join(sandbox, "home"), project = join(sandbox, "project"), config = join(sandbox, "config"), plugin = join(sandbox, "plugin")
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"), IOLAUS_HOME: join(home, ".iolaus"), OPENCODE_TEST_HOME: home, QA_SANDBOX: sandbox, QA_OPENCODE_SOURCE: source, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", IOLAUS_TRACE: join(evidence, "trace.ndjson") }
  writeFileSync(join(sandbox, ".inbox-qa-sandbox"), "isolated rescue smoke\n")
  for (const path of [home, project, join(config, "opencode"), env.IOLAUS_HOME, plugin]) mkdirSync(path, { recursive: true })
  cpSync(join(root, "dist"), join(plugin, "dist"), { recursive: true })
  symlinkSync(join(source, "packages/core/node_modules"), join(plugin, "node_modules"), "dir")
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "iolaus-rescue-smoke", type: "module", main: "./index.js" }))
  writeFileSync(join(plugin, "index.js"), 'export { default } from "./dist/index.js"\n')
  writeFileSync(join(env.IOLAUS_HOME, "iolaus.json"), JSON.stringify({ agents: [], categories: ["quick"], modes: [], astGrep: false, gh: false, mcps: [], verify: false, rescue: { ownerModel: true }, models: { categories: { quick: "openai/gpt-5.4" } } }))
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({ plugins: [{ package: plugin }], model: "openai/gpt-5.5", default_agent: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }], provider: { openai: { options: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { "gpt-5.4": { tool_call: true, limit: { context: 200000, output: 8192 } }, "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } } }))
  server = spawn(launcher, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  exited = new Promise((done) => server.once("close", done))
  server.stdout.on("data", (data) => { log += data }); server.stderr.on("data", (data) => { log += data })
  await once(server, "spawn")
  const base = await until(() => { assert.equal(server.exitCode, null); return log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] }, "server")
  const password = await until(() => log.match(/server password (\S+)/)?.[1], "auth")
  const api = async (method, path, body) => {
    const result = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await result.text(); assert.ok(result.ok, `${result.status} ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  receipt.plugins = await api("GET", `/api/plugin?${new URLSearchParams({ "location[directory]": project })}`)
  const owner = (await api("POST", "/api/session", { agent: "build", model: { providerID: "openai", id: "gpt-5.5" }, location: { directory: project } })).data.id
  const command = async (input) => {
    await api("POST", `/api/session/${owner}/prompt`, { text: `QA_COMMAND:${Buffer.from(JSON.stringify(input)).toString("base64")}` })
    await api("POST", `/api/experimental/session/${owner}/wait`)
    const messages = (await api("GET", `/api/session/${owner}/context`)).data
    const tool = messages.flatMap((message) => message.type === "assistant" ? message.content : []).findLast((part) => part.type === "tool" && part.name === "iolaus_flow")
    assert.equal(tool?.state.status, "completed")
    const output = JSON.parse(tool.state.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"))
    assert.ok(!output.error, output.error)
    return output
  }
  const create = (prompt) => command({ action: "create", definition: { schemaVersion: 1, name: prompt, nodes: [{ id: "work", agent: "quick", prompt, dependsOn: [] }] } })
  const view = async () => (await api("POST", `/api/rpc/iolaus-dag/snapshot?${new URLSearchParams({ "location[directory]": project })}`, { input: { sessionID: owner } })).output
  const good = await create("QA_RESCUE_CHILD")
  await until(async () => (await view()).runs.find((run) => run.runID === good.runID)?.status === "completed", "rescue completion")
  const stable = requests.length
  await sleep(250); assert.equal(requests.length, stable, "notices must not wake owner")
  const success = await command({ action: "snapshot", run_id: good.runID })
  assert.equal(success.run.nodes[0].result.payload.text, "QA_RESCUED_RESULT")
  assert.equal(success.run.nodes[0].result.provenance.agent, "quick")
  assert.equal(success.run.nodes[0].result.provenance.model, "openai/gpt-5.5")
  assert.equal(success.run.nodes[0].recovery.rescue.state, "settled")
  assert.equal(success.events.filter((event) => event.type === "node.rescued").length, 1)
  const bad = await create("QA_PENDING_CHILD")
  await until(() => release, "held failure")
  const child = await until(async () => (await view()).runs.find((run) => run.runID === bad.runID)?.nodes[0]?.sessionID, "child session")
  await api("POST", `/api/session/${child}/synthetic`, { text: "DO_NOT_DROP", delivery: "queue", resume: false })
  release()
  await until(async () => (await view()).runs.find((run) => run.runID === bad.runID)?.status === "failed", "pending refusal")
  const negative = await command({ action: "snapshot", run_id: bad.runID })
  assert.equal(negative.run.nodes[0].attempt, 1)
  assert.ok(negative.events.some((event) => event.type === "node.rescue-skipped" && event.payload.reason === "pending_host_input"))
  assert.equal((await api("GET", `/api/session/${child}/inbox`)).data[0].payload.text, "DO_NOT_DROP")
  receipt = { verdict: "PASS", success, negative, owner, child, sandbox, env, serverPID: server.pid, before, source, limits: "Smoke only: actual plugin, native flow tool, provider auth rescue and pending-synthetic refusal. Full live matrix remains separate; no atomic or exactly-once claim." }
} catch (error) { failure = String(error.stack ?? error) }
finally {
  release?.()
  if (server?.pid) {
    const signal = (name) => { try { process.kill(-server.pid, name) } catch (error) { if (error.code !== "ESRCH") cleanupErrors.push(String(error)) } }
    signal("SIGTERM")
    const watchdog = setTimeout(() => signal("SIGKILL"), 3000)
    await exited; clearTimeout(watchdog); signal("SIGKILL")
  }
  for (const socket of sockets) socket.destroy()
  if (mock.listening) await new Promise((done) => mock.close(done))
  await until(() => sockets.size === 0, "mock socket cleanup")
  if (sandbox) {
    const logs = join(sandbox, "data/opencode/log")
    if (existsSync(logs)) cpSync(logs, join(evidence, "host-logs"), { recursive: true })
    rmSync(sandbox, { recursive: true, force: true })
  }
  const after = state()
  if (JSON.stringify(before) !== JSON.stringify(after)) cleanupErrors.push("Host state changed")
  if (server?.pid) {
    try { process.kill(-server.pid, 0); cleanupErrors.push("Server process group remains") }
    catch (error) { if (error.code !== "ESRCH") cleanupErrors.push(String(error)) }
  }
  receipt = { ...receipt, verdict: failure || cleanupErrors.length ? "FAIL" : "PASS", failure, cleanupErrors, cleanup: { sandboxRemoved: !existsSync(sandbox ?? ""), serverStopped: !server || server.exitCode !== null || server.signalCode !== null, mockStopped: !mock.listening, sockets: sockets.size }, before, after }
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2))
  writeFileSync(join(evidence, "requests.json"), JSON.stringify(requests, null, 2))
  writeFileSync(join(evidence, "server.log"), log.replace(/server password \S+/g, "server password <REDACTED>"))
}
console.log(JSON.stringify({ verdict: receipt.verdict, failure, cleanup: receipt.cleanup }, null, 2))
process.exitCode = receipt.verdict === "PASS" ? 0 : 1
