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
    const record = { scenario: active.name, model: body.model, reasoning: body.reasoning ?? null, service_tier: body.service_tier ?? null, tools, input, instructions: body.instructions }
    requests.push(record)
    appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(record) + "\n")
    assert.ok(requests.length < 60, "Unexpected model loop")
     let call
     const messageText = (body.input ?? []).filter((item) => item?.type === "message").map((item) => JSON.stringify(item)).join("\n")
     const childNode = active.dag ? (messageText.match(/IOLAUS_DAG_NODE(?:_([A-Z]+))?/) ?? undefined) : undefined
     let text = "IOLAUS_QA_DONE"
     if (childNode) {
       call = undefined
       if (childNode[1] === "REVIEW") text = "IOLAUS_ROUTE_VERDICT_PASS"
       else if (childNode[1] === "QUICK" || childNode[1] === "ORACLE") text = `IOLAUS_LANE_RESULT_${childNode[1]}`
       else if (childNode[1]) text = `IOLAUS_FANIN_RESULT_${childNode[1]}`
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
         : runID && priorDagResult?.status === "paused"
           ? { name: "iolaus_dag", args: { action: "approve", run_id: runID, node_id: "gate", note: "QA approved" } }
         : runID
           ? { name: "iolaus_dag", args: { action: "wait", run_id: runID } }
           : active.lanes
             ? { name: "iolaus_dag", args: { action: "create", definition: { schemaVersion: 1, name: "QA lanes", maxParallel: 2, nodes: [
                 { id: "quick", agent: "iolaus-quick", prompt: "IOLAUS_DAG_NODE_QUICK", dependsOn: [] },
                 { id: "oracle", agent: "iolaus-oracle", prompt: "IOLAUS_DAG_NODE_ORACLE", dependsOn: [] } ] } } }
           : active.route
             ? { name: "iolaus_dag", args: { action: "create", definition: { schemaVersion: 1, name: "QA routing", maxParallel: 2, nodes: [
                 { id: "gate", kind: "gate", prompt: "IOLAUS_GATE_APPROVE_QA", dependsOn: [] },
                 { id: "review", agent: "iolaus-sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_REVIEW", dependsOn: ["gate"], inputs: [{ node: "gate" }] },
                 { id: "ship", agent: "iolaus-sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_SHIP", dependsOn: ["review"], when: { node: "review", field: "text", includes: "VERDICT_PASS" } },
                 { id: "fix", agent: "iolaus-hephaestus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_FIX", dependsOn: ["review"], when: { node: "review", field: "text", includes: "VERDICT_FAIL" } },
                 { id: "report", agent: "iolaus-sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_REPORT", dependsOn: ["ship", "fix"], inputs: [{ node: "*" }] } ] } } }
           : active.fanin
             ? { name: "iolaus_dag", args: { action: "create", definition: { schemaVersion: 1, name: "QA fan-in", maxParallel: 2, nodes: [
                 { id: "a", agent: "iolaus-sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_A", dependsOn: [] },
                 { id: "b", agent: "iolaus-hephaestus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_B", dependsOn: [] },
                 { id: "merge", agent: "iolaus-sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_MERGE", dependsOn: ["a", "b"], inputs: [{ node: "*" }] } ] } } }
             : { name: "iolaus_dag", args: { action: "create", definition: { schemaVersion: 1, name: "QA DAG", maxParallel: 1, nodes: [{ id: "node", agent: "iolaus-sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE", dependsOn: [] }] } } }
     } else if (active.astGrep && tools.includes("execute")) {
       const done = (body.input ?? []).some((item) => item?.type === "function_call_output")
       call = done ? undefined : { name: "execute", args: { code: active.astGrep } }
     } else if (active.nativeRead && tools.includes("read") && !input.includes("IOLAUS_QA_NATIVE_READ_RESULT")) call = { name: "read", args: { path: "fixture.txt" } }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    for (const event of events(text, call)) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) { errors.push(String(error)); res.writeHead(500).end("mock error") }
})
const AST_GREP_FIXTURE = "console.log(add(1, 2))\nconsole.log(\"hello\")\nconst x = 1\n"
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
     { name: "fanin", enabled: true, agent: "build", dag: true, fanin: true },
     { name: "route", enabled: true, agent: "build", dag: true, route: true },
     { name: "lanes", enabled: true, agent: "build", dag: true, lanes: true, models: { agents: { oracle: "openai/gpt-5.6-sol#xhigh" }, categories: { quick: "openai/gpt-6-luna-fast#low" } } },
     { name: "astgrep-explore", enabled: true, agent: "iolaus-explore", agentPermissions: true,
       astGrep: 'const r = await tools.ast_grep.search({ pattern: "console.log($A)", language: "typescript", paths: ["src"] }); return { ok: r.ok, count: r.matches.length, lines: r.matches.map((m) => m.path + ":" + m.range.start.line), first: r.matches[0].metavariables.single.A }' },
     { name: "astgrep-rewrite", enabled: true, agent: "build",
       astGrep: 'const r = await tools.ast_grep.rewrite({ pattern: "console.log($A)", rewrite: "logger.info($A)", language: "typescript", paths: ["src"], apply: true }); return { ok: r.ok, applied: r.applied, planned: r.counts ? r.counts.plannedMatches : null, code: r.error ? r.error.code : null }' },
     { name: "astgrep-deny", enabled: true, agent: "iolaus-prometheus", agentPermissions: true,
       astGrep: 'const r = await tools.ast_grep.rewrite({ pattern: "console.log($A)", rewrite: "logger.info($A)", language: "typescript", paths: ["src"], apply: true }); return { ok: r.ok, applied: r.applied === true, code: r.error ? r.error.code : null }' },
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
    const settings = { plugins: [{ package: join(root,"dist"), options: { enabled: scenario.enabled, ...(scenario.models ? { models: scenario.models } : {}) } }],
      model: "openai/gpt-5.5", default_agent: "build", ...(scenario.agentPermissions ? {} : { permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
      provider: { openai: { options: { apiKey: "fake-key", baseURL: mockURL }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } } }
    writeFileSync(join(config,"opencode/opencode.json"), JSON.stringify(settings))
    writeFileSync(join(project,"fixture.txt"), "IOLAUS_QA_NATIVE_READ_RESULT\n")
    if (scenario.astGrep) { mkdirSync(join(project, "src")); writeFileSync(join(project, "src", "a.ts"), AST_GREP_FIXTURE) }
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
       assert.equal(traces.some((t) => t.event === "iolaus.agent.rendered"), scenario.agent.startsWith("iolaus-") || Boolean(scenario.dag))
       assert.equal(traces.some((t) => t.event === "iolaus.mode.rendered"), scenario.name === "mode")
       if (scenario.dag) {
         assert.ok(traces.some((t) => t.event === "iolaus.dag.run.started"), "DAG run did not start")
         assert.ok(traces.some((t) => t.event === "iolaus.dag.node.completed"), "DAG node did not complete")
       }
      const captured = requests.filter((r) => r.scenario === scenario.name)
      assert.ok(captured.length)
       assert.ok(captured.every((r) => !r.tools.some((t) => ["task","workflow","hashline_edit","background_output","todowrite"].includes(t) || t?.startsWith("team_"))))
       if (scenario.dag) assert.ok(captured.some((r) => r.tools.includes("iolaus_dag")), "DAG tool was not exposed")
       if (scenario.fanin) {
         const messageText = (r) => JSON.parse(r.input).filter((item) => item?.type === "message").flatMap((item) => item.content ?? []).map((part) => part?.text ?? "").join("\n")
         const merge = captured.map(messageText).find((text) => text.includes("IOLAUS_DAG_NODE_MERGE"))
         assert.ok(merge, "Fan-in merge child was not prompted")
         const inputs = JSON.parse(merge.match(/<iolaus-dag-inputs>(.*?)<\/iolaus-dag-inputs>/s)[1])
         assert.deepEqual(inputs.map((i) => i.node), ["a", "b"], "Fan-in did not expand to every dependency")
         assert.ok(inputs[0].value.text.includes("IOLAUS_FANIN_RESULT_A") && inputs[1].value.text.includes("IOLAUS_FANIN_RESULT_B"), "Fan-in payloads missing")
         assert.deepEqual(inputs.map((i) => i.provenance.agent), ["iolaus-sisyphus", "iolaus-hephaestus"], "Fan-in provenance agent missing")
         assert.ok(inputs.every((i) => typeof i.provenance.sessionID === "string" && i.provenance.sessionID.startsWith("ses_")), "Fan-in provenance sessionID missing")
         assert.equal(traces.filter((t) => t.event === "iolaus.dag.node.completed").length, 3, "Expected three completed fan-in nodes")
       }
       if (scenario.astGrep) {
         assert.ok(traces.some((t) => t.event === "iolaus.ast_grep.registered" && t.binary), "ast_grep tools were not registered")
         const withTools = captured.filter((r) => r.tools.includes("execute"))
         assert.ok(withTools.length, "execute was not offered to the agent")
         const catalog = withTools[0].instructions.slice(withTools[0].instructions.indexOf("# Code Mode"))
         assert.ok(catalog.includes("tools.ast_grep.search("), "ast_grep.search missing from the Code Mode catalog")
         const outputs = captured.flatMap((r) => JSON.parse(r.input).filter((item) => item?.type === "function_call_output").map((item) => typeof item.output === "string" ? item.output : JSON.stringify(item.output)))
         assert.ok(outputs.length, "execute returned no output to the model")
         const out = outputs.at(-1)
         const calls = traces.filter((t) => t.event === "iolaus.ast_grep.call")
         const source = readFileSync(join(fixture.project, "src", "a.ts"), "utf8")
         if (scenario.name === "astgrep-explore") {
           assert.match(catalog, /- ast_grep \(2 tools\)/, "read-only explore must see only search and scan")
           assert.ok(!catalog.includes("tools.ast_grep.rewrite("), "read-only explore must not see ast_grep.rewrite")
           assert.match(out, /"count": 2/, `structured search result missing: ${out}`)
           assert.ok(out.includes("src/a.ts:1") && out.includes("src/a.ts:2"), `match locations missing: ${out}`)
           assert.match(out, /"first": "add\(1, 2\)"/, `metavariable capture missing: ${out}`)
           assert.ok(calls.some((t) => t.tool === "search" && t.ok && t.agent === "iolaus-explore" && t.matches === 2), "search call trace missing")
           assert.equal(source, AST_GREP_FIXTURE)
         }
         if (scenario.name === "astgrep-rewrite") {
           assert.match(out, /"applied": true/, `rewrite was not applied: ${out}`)
           assert.equal(source, "logger.info(add(1, 2))\nlogger.info(\"hello\")\nconst x = 1\n")
           assert.ok(calls.some((t) => t.tool === "rewrite" && t.ok && t.applied), "rewrite call trace missing")
         }
         if (scenario.name === "astgrep-deny") {
           assert.match(catalog, /- ast_grep \(3 tools/, "prometheus may edit plans, so rewrite stays visible")
           assert.ok(catalog.includes("tools.ast_grep.rewrite("), "pinned rewrite signature missing for a writer")
           assert.match(out, /"code": "PERMISSION_DENIED"/, `planner write outside plans was not denied: ${out}`)
           assert.equal(source, AST_GREP_FIXTURE, "denied rewrite modified the file")
           assert.ok(calls.some((t) => t.tool === "rewrite" && !t.ok && t.code === "PERMISSION_DENIED"), "deny call trace missing")
         }
       }
       if (scenario.lanes) {
         const pinned = Object.fromEntries(traces.filter((t) => t.event === "iolaus.agent.model").map((t) => [t.agent, `${t.model}${t.variant ? `#${t.variant}` : ""}|${t.source}`]))
         assert.equal(pinned["iolaus-oracle"], "openai/gpt-5.6-sol#xhigh|config", "oracle lane did not follow models config")
         assert.equal(pinned["iolaus-quick"], "openai/gpt-6-luna-fast#low|config", "quick lane did not follow models config")
         assert.equal(pinned["iolaus-sisyphus"], "anthropic/claude-opus-5-5#max|requirement", "sisyphus lane did not follow the requirement table")
         assert.equal(pinned["iolaus-deep-high"], "openai/gpt-6-astra#xhigh|requirement", "deep-high lane missing")
         assert.ok(!traces.some((t) => t.event === "iolaus.category.hidden" || t.event === "iolaus.agent.hidden"), "No lane should be hidden when every chain names a model")
         const messageText = (r) => JSON.parse(r.input).filter((item) => item?.type === "message").flatMap((item) => item.content ?? []).map((part) => part?.text ?? "").join("\n")
         const quick = captured.find((r) => messageText(r).includes("IOLAUS_DAG_NODE_QUICK"))
         const oracle = captured.find((r) => messageText(r).includes("IOLAUS_DAG_NODE_ORACLE"))
         assert.ok(quick && oracle, "lane children were not prompted")
         assert.equal(quick.model, "gpt-6-luna", `quick child hit ${quick.model}`)
         assert.equal(quick.reasoning?.effort, "low", `quick child effort ${JSON.stringify(quick.reasoning)}`)
         assert.equal(oracle.model, "gpt-5.6-sol", `oracle child hit ${oracle.model}`)
         assert.equal(oracle.reasoning?.effort, "xhigh", `oracle child effort ${JSON.stringify(oracle.reasoning)}`)
         assert.ok(traces.some((t) => t.event === "iolaus.agent.rendered" && t.agent === "quick" && t.kind === "category"), "quick lane did not render the category prompt")
         const finalWait = captured.map((r) => r.input).find((input) => input.includes("IOLAUS_LANE_RESULT_QUICK") && input.includes("openai/gpt-6-luna-fast#low"))
         assert.ok(finalWait, "DAG result did not record the lane model in provenance")
         assert.equal(traces.filter((t) => t.event === "iolaus.dag.node.completed").length, 2)
       }
       if (scenario.route) {
         const messageText = (r) => JSON.parse(r.input).filter((item) => item?.type === "message").flatMap((item) => item.content ?? []).map((part) => part?.text ?? "").join("\n")
         const texts = captured.map(messageText)
         for (const name of ["iolaus.dag.node.waiting", "iolaus.dag.run.paused", "iolaus.dag.node.approved", "iolaus.dag.node.skipped", "iolaus.dag.run.completed"]) {
           assert.ok(traces.some((t) => t.event === name), `Missing trace ${name}`)
         }
         assert.ok(traces.some((t) => t.event === "iolaus.dag.node.skipped" && t.nodeID === "fix"), "fix branch was not skipped")
         assert.ok(!texts.some((text) => text.includes("IOLAUS_DAG_NODE_FIX")), "Skipped fix branch was prompted")
         assert.ok(texts.some((text) => text.includes("IOLAUS_DAG_NODE_SHIP")), "ship branch was not prompted")
         const review = texts.find((text) => text.includes("IOLAUS_DAG_NODE_REVIEW"))
         assert.ok(review, "review child was not prompted")
         const gateInput = JSON.parse(review.match(/<iolaus-dag-inputs>(.*?)<\/iolaus-dag-inputs>/s)[1])[0]
         assert.deepEqual(gateInput.value, { decision: "approved", note: "QA approved" }, "Gate approval payload missing from review input")
         assert.equal(gateInput.provenance.agent, "human", "Gate provenance should be human")
         const report = texts.find((text) => text.includes("IOLAUS_DAG_NODE_REPORT"))
         assert.ok(report, "report child was not prompted")
         const inputs = JSON.parse(report.match(/<iolaus-dag-inputs>(.*?)<\/iolaus-dag-inputs>/s)[1])
         assert.deepEqual(inputs.map((i) => [i.node, i.provenance.status]), [["ship", "completed"], ["fix", "skipped"]], "Report inputs did not reflect routing")
         assert.equal(inputs[1].value, null, "Skipped branch should bind null")
       }
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
