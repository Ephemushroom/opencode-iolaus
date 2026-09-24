import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import http from "node:http"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const evidence = resolve(process.argv[2] ?? join(root, `.omo/evidence/${new Date().toISOString().replace(/[:.]/g, "-")}-live`))
assert.ok(evidence.startsWith(join(root, ".omo/evidence/")))
mkdirSync(evidence, { recursive: false })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-qa-")))
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const results = [], processes = [], requests = [], errors = []
let active
const digest = (value) => createHash("sha256").update(value).digest("hex")
function hostState() {
  const home = homedir()
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config")
  const db = join(process.env.XDG_DATA_HOME ?? join(home, ".local/share"), "opencode/opencode.db")
  const sql = (query) => execFileSync("sqlite3", ["-readonly", db, query], { encoding: "utf8" }).trim()
  const tables = existsSync(db) ? sql("SELECT name FROM sqlite_master WHERE type='table'").split("\n") : []
  const files = [join(config, "opencode/opencode.json"), join(config, "opencode/opencode.jsonc"), join(home, ".local/share/opencode/auth.json"), join(home, ".omo/opencode2.json"), join(home, ".omo/omo.jsonc")]
  return { files: Object.fromEntries(files.map((p) => [p, existsSync(p) ? digest(readFileSync(p)) : "absent"])),
    sessions: Object.fromEntries(["session", "session_v2"].map((t) => [t, tables.includes(t) ? sql(`SELECT count(*) FROM ${t}`) : "absent"])) }
}
const before = hostState()
async function check(name, fn) {
  try { await fn(); results.push({ name, verdict: "PASS" }) }
  catch (error) { results.push({ name, verdict: "FAIL", error: String(error) }) }
  writeFileSync(join(evidence, "assertions.json"), JSON.stringify(results, null, 2))
}
function signal(pid, sig) {
  try { process.kill(-pid, sig) } catch (error) { if (error.code !== "ESRCH") throw error }
}
async function run(name, args, fixture) {
  const child = spawn(binary, args, { cwd: fixture.project, env: fixture.env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  const record = { name, args, pid: child.pid }; processes.push(record)
  let output = ""
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; appendFileSync(join(evidence, `${name}.log`), data) })
  const deadline = setTimeout(() => signal(child.pid, "SIGKILL"), 90000)
  try {
    const [code, sig] = await once(child, "close")
    Object.assign(record, { code, signal: sig, closed: true })
    return { code, output }
  } finally { clearTimeout(deadline); if (child.pid) signal(child.pid, "SIGKILL") }
}
function events(text, call) {
  const id = `resp_${requests.length}`, item = `item_${requests.length}`
  const result = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now()/1000), model: "gpt-5.5" } }]
  if (call) {
    const args = JSON.stringify(call.args)
    result.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: item, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: args, status: "completed" } })
  } else {
    result.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: item } },
      { type: "response.output_text.delta", item_id: item, output_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: item } })
  }
  result.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  return result
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const tools = (body.tools ?? []).map((t) => t.name ?? t.function?.name)
    const input = JSON.stringify(body.input)
    const record = { scenario: active.name, model: body.model, tools, input, instructions: body.instructions }
    requests.push(record)
    appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(record) + "\n")
    assert.ok(requests.length < 60, "Unexpected model loop")
     let call
     const isChildNodeRequest = active.dag && (body.input ?? []).some((item) => item?.type === "message" && JSON.stringify(item).includes("IOLAUS_DAG_NODE"))
     if (isChildNodeRequest) {
       call = undefined
     } else if (active.dag && tools.includes("iolaus_dag")) {
       const priorOutput = (body.input ?? []).filter((item) => item?.type === "function_call_output").at(-1)?.output
       let runID
       let priorDagResult
       if (typeof priorOutput === "string") {
         try {
           priorDagResult = JSON.parse(priorOutput)
           runID = priorDagResult?.runID
         } catch {}
       }
       call = priorDagResult?.status === "completed" || priorDagResult?.status === "failed"
         ? undefined
         : runID
           ? { name: "iolaus_dag", args: { action: "wait", run_id: runID } }
           : { name: "iolaus_dag", args: { action: "create", definition: { schemaVersion: 1, name: "QA DAG", maxParallel: 1, nodes: [{ id: "node", agent: "iolaus-sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE", dependsOn: [] }] } } }
     } else if (active.nativeRead && tools.includes("read") && !input.includes("IOLAUS_QA_NATIVE_READ_RESULT")) call = { name: "read", args: { path: "fixture.txt" } }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    for (const event of events("IOLAUS_QA_DONE", call)) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) { errors.push(String(error)); res.writeHead(500).end("mock error") }
})
let after
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const mockURL = `http://127.0.0.1:${server.address().port}/v1`
  for (const scenario of [
    { name: "native", enabled: true, agent: "build", nativeRead: true },
    { name: "agent", enabled: true, agent: "iolaus-sisyphus", nativeRead: true },
    { name: "disabled", enabled: false, agent: "build", nativeRead: true },
     { name: "mode", enabled: true, agent: "build", mode: "ultrawork" },
     { name: "dag", enabled: true, agent: "build", dag: true },
  ]) {
    active = scenario
    const home = join(sandbox, scenario.name, "home"), project = join(home, "project")
    mkdirSync(project, { recursive: true })
    const config = join(sandbox, scenario.name, "config")
    mkdirSync(join(config, "opencode"), { recursive: true })
    const trace = join(evidence, `${scenario.name}-trace.ndjson`)
    const env = { PATH: process.env.PATH, TMPDIR: sandbox, HOME: home, USERPROFILE: home, PWD: project,
      XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(home,"data"), XDG_CACHE_HOME: join(home,"cache"), XDG_STATE_HOME: join(home,"state"),
      OPENCODE_TEST_HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", IOLAUS_TRACE: trace, OPENAI_API_KEY: "fake-key" }
    const settings = { plugins: [{ package: join(root,"dist"), options: { enabled: scenario.enabled } }],
      model: "openai/gpt-5.5", default_agent: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }],
      provider: { openai: { options: { apiKey: "fake-key", baseURL: mockURL }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } } }
    writeFileSync(join(config,"opencode/opencode.json"), JSON.stringify(settings))
    writeFileSync(join(project,"fixture.txt"), "IOLAUS_QA_NATIVE_READ_RESULT\n")
    const fixture = { project, env }
    writeFileSync(join(evidence, `${scenario.name}-isolation.json`), JSON.stringify({ project, env: Object.fromEntries(Object.entries(env).filter(([k]) => k !== "PATH" && k !== "OPENAI_API_KEY")) },null,2))
    if (scenario.name === "native") {
       await check("host version", async () => { const r = await run("version", ["--version"], fixture); assert.equal(r.code,0); assert.match(r.output,/2\.0\.16/) })
      await check("run help", async () => { const r = await run("help", ["run","--help"], fixture); assert.equal(r.code,0) })
    }
    await check(`${scenario.name}: live session`, async () => {
      const args = ["run", "--standalone", "--auto", "--print-logs", "--agent", scenario.agent, "--model", "openai/gpt-5.5"]
       args.push(scenario.mode ? `/iolaus-${scenario.mode} Read fixture.txt and report the result.`
         : scenario.dag ? "Run an Iolaus DAG and report the completed node result."
         : scenario.nativeRead ? "Read fixture.txt and report the result." : "Return IOLAUS_QA_DONE.")
      const result = await run(scenario.name,args,fixture)
      assert.equal(result.code,0)
      const traces = existsSync(trace) ? readFileSync(trace,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
      assert.ok(traces.some((t) => t.event === "iolaus.loaded" && t.enabled === scenario.enabled), "Plugin did not load")
       assert.equal(traces.some((t) => t.event === "iolaus.agent.rendered"), scenario.name === "agent" || scenario.name === "dag")
       assert.equal(traces.some((t) => t.event === "iolaus.mode.rendered"), scenario.name === "mode")
       if (scenario.dag) {
         assert.ok(traces.some((t) => t.event === "iolaus.dag.run.started"), "DAG run did not start")
         assert.ok(traces.some((t) => t.event === "iolaus.dag.node.completed"), "DAG node did not complete")
       }
      const captured = requests.filter((r) => r.scenario === scenario.name)
      assert.ok(captured.length)
       assert.ok(captured.every((r) => !r.tools.some((t) => ["task","workflow","hashline_edit","background_output","todowrite"].includes(t) || t?.startsWith("team_"))))
       if (scenario.dag) assert.ok(captured.some((r) => r.tools.includes("iolaus_dag")), "DAG tool was not exposed")
      if (scenario.nativeRead) assert.ok(captured.some((r) => r.input.includes("IOLAUS_QA_NATIVE_READ_RESULT")), "Native read result missing")
    })
  }
} finally {
  for (const proc of processes) if (proc.pid) signal(proc.pid,"SIGKILL")
  server.closeAllConnections()
  if (server.listening) await new Promise((done) => server.close(done))
  rmSync(sandbox,{recursive:true,force:true})
  after = hostState()
  await check("host state isolation", () => assert.deepEqual(after,before))
  await check("cleanup", () => { assert.ok(processes.every((p) => p.closed)); assert.ok(!server.listening); assert.ok(!existsSync(sandbox)) })
  await check("mock protocol", () => assert.deepEqual(errors,[]))
  writeFileSync(join(evidence,"receipt.json"),JSON.stringify({binary,results,before,after,processes,sandboxRemoved:!existsSync(sandbox),mockClosed:!server.listening,requestCount:requests.length,omitted:"No user credentials or inherited environment dumps. Local mock only."},null,2))
}
console.log(JSON.stringify({evidence,results},null,2))
process.exitCode = results.some((r) => r.verdict === "FAIL") ? 1 : 0
