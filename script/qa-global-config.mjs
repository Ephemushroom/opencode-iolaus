import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(new URL("..", import.meta.url).pathname)
const evidence = resolve(process.argv[2] ?? join(root, `.omo/evidence/global-config-${Date.now()}`))
assert.ok(evidence.startsWith(join(root, ".omo/evidence/")))
mkdirSync(evidence, { recursive: true })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-global-config-")))
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const hostPaths = [join(homedir(), ".config/opencode/opencode.json"), join(homedir(), ".iolaus/iolaus.json")]
async function digest(path) {
  if (!existsSync(path)) return "absent"
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
const before = await Promise.all(hostPaths.map(digest))
const results = [], processes = [], requests = [], errors = []
let active = ""
const mock = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ scenario: active, model: body.model, instructions: String(body.instructions ?? "").slice(-2500), variant: body.qa_variant ?? null })
    const id = `response_${requests.length}`
    const events = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: body.model } }]
    const call = active === "global-explore" && (body.tools ?? []).some((tool) => tool.name === "subagent") && !(body.input ?? []).some((item) => item.type === "function_call_output")
    if (call) {
      const args = JSON.stringify({ agent: "explore", description: "global model route", prompt: "Return GLOBAL_CONFIG_QA_OK" })
      events.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: `item_${id}`, call_id: id, name: "subagent", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: `item_${id}`, output_index: 0, delta: args },
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: `item_${id}`, call_id: id, name: "subagent", arguments: args, status: "completed" } })
    } else events.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: `item_${id}` } },
      { type: "response.output_text.delta", item_id: `item_${id}`, output_index: 0, delta: "GLOBAL_CONFIG_QA_OK" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: `item_${id}` } })
    events.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) { errors.push(String(error)); res.writeHead(500).end() }
})
async function check(name, fn) {
  try { await fn(); results.push({ name, verdict: "PASS" }) }
  catch (error) { results.push({ name, verdict: "FAIL", error: String(error) }) }
  writeFileSync(join(evidence, "assertions.json"), JSON.stringify(results, null, 2))
}
async function run(name, fixture) {
  active = name
  const child = spawn(binary, ["run", "--standalone", "--auto", "--print-logs", "--agent", "build", "Delegate to explore to say GLOBAL_CONFIG_QA_OK."], { cwd: fixture.project, env: fixture.env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  const record = { name, pid: child.pid, closed: false }; processes.push(record)
  let output = ""
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; appendFileSync(join(evidence, `${name}.log`), data) })
  const kill = () => { try { process.kill(-child.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error } }
  const deadline = setTimeout(kill, 70000)
  try {
    const [code, signal] = await once(child, "close")
    Object.assign(record, { code, signal, closed: true })
    return { code, output, trace: existsSync(fixture.trace) ? readFileSync(fixture.trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [] }
  } finally { clearTimeout(deadline); kill() }
}
function fixture(name, globalConfig) {
  const base = join(sandbox, name), home = join(base, "home"), user = join(base, "iolaus"), config = join(base, "config"), project = join(base, "project"), trace = join(evidence, `${name}-trace.ndjson`)
  for (const dir of [home, user, project, join(project, ".iolaus"), join(config, "opencode")]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(user, "iolaus.json"), globalConfig)
  writeFileSync(join(user, "models.json"), JSON.stringify({ agents: { explore: "openai/legacy-user" } }))
  writeFileSync(join(user, "verify.json"), JSON.stringify({ checkers: [{ argv: ["legacy-user"] }] }))
  writeFileSync(join(project, ".iolaus/models.json"), JSON.stringify({ agents: { explore: "openai/legacy-project" } }))
  writeFileSync(join(project, ".iolaus/verify.json"), JSON.stringify({ checkers: [{ argv: ["legacy-project"] }] }))
  const url = `http://127.0.0.1:${mock.address().port}/v1`
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
    plugins: [{ package: join(root, "dist"), options: { models: { agents: { explore: "openai/legacy-inline" } }, agents: [], verify: false, mcps: ["context7"] } }],
    model: "openai/gpt-5.5", default_agent: "build",
    providers: { "ds-bryan": { name: "QA DeepSeek", canonical: "openai", env: ["QA_MODEL_KEY"], settings: { baseURL: url }, models: { "deepseek-v4-flash": { limit: { context: 200000, output: 8192 }, variants: [{ id: "max", body: { qa_variant: "max" } }] } } } },
    provider: { openai: { options: { apiKey: "fake-key", baseURL: url }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } },
  }))
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: sandbox, IOLAUS_HOME: user, IOLAUS_TRACE: trace, QA_MODEL_KEY: "fake-key", OPENAI_API_KEY: "fake-key",
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(base, "data"), XDG_CACHE_HOME: join(base, "cache"), XDG_STATE_HOME: join(base, "state"), OPENCODE_TEST_HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
  writeFileSync(join(evidence, `${name}-isolation.json`), JSON.stringify({ project, home, user, config, data: env.XDG_DATA_HOME, trace }, null, 2))
  return { project, user, trace, env }
}
try {
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  const positive = fixture("global-explore", JSON.stringify({ agents: ["explore"], mcps: [], gh: false, verify: { checkers: [], commentPattern: null }, models: { agents: { explore: "ds-bryan/deepseek-v4-flash#max" } } }))
  await check("explore uses only global model and variant, project DAG remains local", async () => {
    const result = await run("global-explore", positive)
    assert.equal(result.code, 0, result.output.slice(-1000))
    assert.ok(requests.some((item) => item.scenario === "global-explore" && item.model === "deepseek-v4-flash" && item.variant === "max"), JSON.stringify(requests.map(({ instructions, ...item }) => item)))
    assert.ok(result.trace.some((item) => item.event === "iolaus.agent.model" && item.agent === "explore" && item.model === "ds-bryan/deepseek-v4-flash" && item.variant === "max" && item.source === "config"))
    assert.ok(result.trace.some((item) => item.event === "iolaus.models.loaded" && item.source === "iolaus.json"))
    assert.ok(existsSync(join(positive.project, ".iolaus/dag/state.db")))
    assert.ok(!existsSync(join(positive.user, "state.db")))
  })
  for (const [name, content] of [["invalid-json", "{invalid"], ["invalid-model", '{"enabled":false,"models":{"agents":{"explore":"bad"}}}'], ["invalid-verify", '{"verify":{"checkers":[{"argv":[]}]}}']]) {
    const item = fixture(name, content)
    await check(`${name} rejects plugin setup without fallback`, async () => {
      const before = requests.length
      const result = await run(name, item)
      assert.match(result.output, /failed to load plugin.*Invalid Iolaus global config/s)
      assert.ok(!result.trace.some((event) => event.event === "iolaus.loaded"))
      assert.ok(requests.length > before, "host fallback did not reach mock")
      assert.ok(requests.slice(before).every((request) => !request.instructions.includes("<iolaus-native-contract>")))
    })
  }
} finally {
  mock.closeAllConnections()
  if (mock.listening) await new Promise((done) => mock.close(done))
  rmSync(sandbox, { recursive: true, force: true })
  await check("host state isolation", async () => assert.deepEqual(await Promise.all(hostPaths.map(digest)), before))
  await check("process, mock and sandbox cleanup", () => { assert.ok(processes.every((item) => item.closed)); assert.ok(!mock.listening && !existsSync(sandbox)); assert.deepEqual(errors, []) })
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ results, processes, sandboxRemoved: !existsSync(sandbox), mockClosed: !mock.listening, requestCount: requests.length }, null, 2))
}
console.log(JSON.stringify({ evidence, results }, null, 2))
process.exitCode = results.some((item) => item.verdict === "FAIL") ? 1 : 0
