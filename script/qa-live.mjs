import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync, symlinkSync } from "node:fs"
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
    // generate.text (judge nodes) sends no instructions; keep the field a string so assertions can call .includes on it.
    const record = { scenario: active.name, model: body.model, reasoning: body.reasoning ?? null, service_tier: body.service_tier ?? null, tools, input, instructions: body.instructions ?? "" }
    requests.push(record)
    appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(record) + "\n")
    assert.ok(requests.length < 120, "Unexpected model loop")
     let call
     const messageText = (body.input ?? []).filter((item) => item?.type === "message").map((item) => JSON.stringify(item)).join("\n")
     const childNode = active.dag ? (messageText.match(/IOLAUS_DAG_NODE(?:_([A-Z]+))?/) ?? undefined) : undefined
     let text = "IOLAUS_QA_DONE"
     if (active.template === "ultrawork" && messageText.includes("You are the reviewer node")) {
       // Scripted loop: round 0 and round 1 fail, round 2 passes.
       call = undefined
       text = messageText.includes("Round 2:") ? "All scenarios verified.\nVERDICT: PASS" : "Scenario 3 lacks evidence.\nVERDICT: FAIL"
     } else if (active.template === "ultrawork" && (messageText.includes("Achieve this goal end to end") || messageText.includes("the reviewer rejected the work"))) {
       call = undefined; text = messageText.includes("Round 2:") ? "IOLAUS_ULTRAWORK_FIX2" : messageText.includes("Round 1:") ? "IOLAUS_ULTRAWORK_FIX1" : "IOLAUS_ULTRAWORK_WORK"
     } else if (active.template && messageText.includes("You are the reviewer node")) {
       // Scripted reviewer: first review fails, the re-review passes.
       call = undefined
       text = messageText.includes("This is the revised plan") ? "Looks right.\nVERDICT: PASS" : "Step 2 has no verification.\nVERDICT: FAIL"
     } else if (active.template && (messageText.includes("Write the work plan") || messageText.includes("The reviewer rejected the plan"))) {
       call = undefined; text = messageText.includes("rejected") ? "IOLAUS_PLAN_V2" : "IOLAUS_PLAN_V1"
     } else if (active.template && messageText.includes("Execute the approved plan")) {
       call = undefined; text = "IOLAUS_EXECUTED"
     } else if (childNode) {
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
           if (priorDagResult?.run && priorDagResult?.events) priorDagResult = priorDagResult.run
           runID = priorDagResult?.runID
         } catch {}
       }
       // wait() blocks until a terminal state, so a run that pauses at a gate after work is observed through snapshot.
       if (active.template && runID && priorDagResult?.status === "running") await new Promise((done) => setTimeout(done, 1500))
       const waitingGate = priorDagResult?.nodes?.find?.((n) => n.status === "waiting_approval")?.definition?.id ?? "gate"
       call = priorDagResult?.status === "completed" || priorDagResult?.status === "failed" || priorDagResult?.error
         ? undefined
         : runID && priorDagResult?.status === "paused"
           ? { name: "iolaus_dag", args: { action: "approve", run_id: runID, node_id: waitingGate, note: "QA approved" } }
         : runID
           ? { name: "iolaus_dag", args: { action: active.template && priorDagResult?.status === "running" ? "snapshot" : "wait", run_id: runID } }
           : active.template === "ultrawork"
             ? { name: "iolaus_dag", args: { action: "create", template: { template: "ultrawork", task: "IOLAUS_ULTRAWORK_TASK", iterations: 3, executor: "sisyphus" } } }
           : active.template === "unavailable"
             ? { name: "iolaus_dag", args: { action: "create", template: { template: "plan-review", task: "IOLAUS_TEMPLATE_TASK", reviewer: "iolaus-no-such-lane" } } }
           : active.template
             ? { name: "iolaus_dag", args: { action: "create", template: { template: "plan-review", task: "IOLAUS_TEMPLATE_TASK", executor: "sisyphus" } } }
           : active.lanes
             ? { name: "iolaus_dag", args: { action: "create", definition: { schemaVersion: 1, name: "QA lanes", maxParallel: 2, nodes: [
                 { id: "quick", agent: "quick", prompt: "IOLAUS_DAG_NODE_QUICK", dependsOn: [] },
                 { id: "oracle", agent: "oracle", prompt: "IOLAUS_DAG_NODE_ORACLE", dependsOn: [] } ] } } }
           : active.route
             ? { name: "iolaus_dag", args: { action: "create", definition: { schemaVersion: 1, name: "QA routing", maxParallel: 2, nodes: [
                 { id: "gate", kind: "gate", prompt: "IOLAUS_GATE_APPROVE_QA", dependsOn: [] },
                 { id: "review", agent: "sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_REVIEW", dependsOn: ["gate"], inputs: [{ node: "gate" }] },
                 { id: "ship", agent: "sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_SHIP", dependsOn: ["review"], when: { node: "review", field: "text", includes: "VERDICT_PASS" } },
                 { id: "fix", agent: "hephaestus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_FIX", dependsOn: ["review"], when: { node: "review", field: "text", includes: "VERDICT_FAIL" } },
                 { id: "report", agent: "sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_REPORT", dependsOn: ["ship", "fix"], inputs: [{ node: "*" }] } ] } } }
           : active.fanin
             ? { name: "iolaus_dag", args: { action: "create", definition: { schemaVersion: 1, name: "QA fan-in", maxParallel: 2, nodes: [
                 { id: "a", agent: "sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_A", dependsOn: [] },
                 { id: "b", agent: "hephaestus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_B", dependsOn: [] },
                 { id: "merge", agent: "sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE_MERGE", dependsOn: ["a", "b"], inputs: [{ node: "*" }] } ] } } }
             : { name: "iolaus_dag", args: { action: "create", definition: { schemaVersion: 1, name: "QA DAG", maxParallel: 1, nodes: [{ id: "node", agent: "sisyphus", model: "openai/gpt-5.5", prompt: "IOLAUS_DAG_NODE", dependsOn: [] }] } } }
     } else if ((active.astGrep || active.code) && tools.includes("execute")) {
       const outputs = (body.input ?? []).filter((item) => item?.type === "function_call_output")
       // Remote MCP servers connect asynchronously after startup; retry until their tools are in the catalog.
       const pending = active.mcps && outputs.length && outputs.length < 8 && String(outputs.at(-1).output).includes("Unknown tool")
       if (pending) await new Promise((done) => setTimeout(done, 2000))
       call = outputs.length && !pending ? undefined : { name: "execute", args: { code: active.astGrep ?? active.code } }
     } else if (active.verify && (tools.includes("patch") || tools.includes("edit"))) {
       // GPT model IDs get apply_patch (`patch`) instead of edit/write; drive whichever the host offers.
       const done = (body.input ?? []).some((item) => item?.type === "function_call_output")
       const replacement = "const x: number = \"one\" // changed as requested by the user"
       call = done ? undefined : tools.includes("patch")
         ? { name: "patch", args: { patchText: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const x = 1\n+${replacement}\n*** End Patch` } }
         : { name: "edit", args: { filePath: "src/a.ts", oldString: "const x = 1", newString: replacement } }
     } else if (active.nativeRead && tools.includes("read") && !input.includes("IOLAUS_QA_NATIVE_READ_RESULT")) call = { name: "read", args: { path: "fixture.txt" } }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    for (const event of events(text, call)) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) { errors.push(String(error)); res.writeHead(500).end("mock error") }
})
const TSC_BIN = join(root, "node_modules", ".bin", "tsc")
const IOLAUS_AGENT_IDS = new Set(["sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior", "oracle", "librarian", "explore", "metis", "momus", "multimodal-looker"])
let GH_TOKEN
try { GH_TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined } catch {}
const AST_GREP_FIXTURE = "console.log(add(1, 2))\nconsole.log(\"hello\")\nconst x = 1\n"
let after
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const mockURL = `http://127.0.0.1:${server.address().port}/v1`
  const only = process.env.IOLAUS_QA_ONLY ? new Set(process.env.IOLAUS_QA_ONLY.split(",")) : undefined
  for (const scenario of [
    { name: "native", enabled: true, agent: "build", nativeRead: true },
    { name: "agent", enabled: true, agent: "sisyphus", nativeRead: true },
    { name: "disabled", enabled: false, agent: "build", nativeRead: true },
     { name: "mode", enabled: true, agent: "build", mode: "ultrawork" },
     { name: "dag", enabled: true, agent: "build", dag: true },
     { name: "fanin", enabled: true, agent: "build", dag: true, fanin: true },
     { name: "route", enabled: true, agent: "build", dag: true, route: true },
     // plan-review template through the real tool: Prometheus plans, Momus fails once, Prometheus revises, Momus passes, gate, Sisyphus executes.
     { name: "template", enabled: true, agent: "build", dag: true, template: true, models: { agents: { prometheus: "openai/gpt-5.5", momus: "openai/gpt-5.5", sisyphus: "openai/gpt-5.5" } } },
     { name: "template-unavailable", enabled: true, agent: "build", dag: true, template: "unavailable", models: { agents: { prometheus: "openai/gpt-5.5", sisyphus: "openai/gpt-5.5" } } },
     // /ultrawork is a DAG mode: the command text tells the primary to create the ultrawork template; the loop runs three rounds.
     { name: "ultrawork-dag", enabled: true, agent: "build", dag: true, mode: "ultrawork", template: "ultrawork", models: { agents: { momus: "openai/gpt-5.5", sisyphus: "openai/gpt-5.5" } } },
     { name: "lanes", enabled: true, agent: "build", dag: true, lanes: true, models: { agents: { oracle: "openai/gpt-5.6-sol#xhigh" }, categories: { quick: "openai/gpt-6-luna-fast#low" } } },
     { name: "astgrep-explore", enabled: true, agent: "explore", agentPermissions: true,
       astGrep: 'const r = await tools.ast_grep.search({ pattern: "console.log($A)", language: "typescript", paths: ["src"] }); return { ok: r.ok, count: r.matches.length, lines: r.matches.map((m) => m.path + ":" + m.range.start.line), first: r.matches[0].metavariables.single.A }' },
     { name: "astgrep-rewrite", enabled: true, agent: "build",
       astGrep: 'const r = await tools.ast_grep.rewrite({ pattern: "console.log($A)", rewrite: "logger.info($A)", language: "typescript", paths: ["src"], apply: true }); return { ok: r.ok, applied: r.applied, planned: r.counts ? r.counts.plannedMatches : null, code: r.error ? r.error.code : null }' },
     { name: "astgrep-deny", enabled: true, agent: "prometheus", agentPermissions: true,
       astGrep: 'const r = await tools.ast_grep.rewrite({ pattern: "console.log($A)", rewrite: "logger.info($A)", language: "typescript", paths: ["src"], apply: true }); return { ok: r.ok, applied: r.applied === true, code: r.error ? r.error.code : null }' },
     // Live network: both built-in remote MCP servers answer real read-only queries.
     { name: "mcps-librarian", enabled: true, agent: "librarian", agentPermissions: true, mcps: ["context7", "grep_app"],
       code: 'const found = search({ query: "context7 grep_app", limit: 20 }).items.map((i) => i.path).filter((p) => p.includes("context7") || p.includes("grep_app")).sort(); const lib = await tools.context7["resolve-library-id"]({ libraryName: "react", query: "useEffect cleanup" }); const code = await tools.grep_app.searchGitHub({ query: "useEffect(() => {", language: ["TypeScript", "TSX"] }); const text = JSON.stringify(code); return { found, lib: JSON.stringify(lib).slice(0, 300), grepHit: text.includes("useEffect(() => {"), code: text.slice(0, 300) }' },
     { name: "mcps-off", enabled: true, agent: "librarian", agentPermissions: true, code: 'return Object.keys(tools)' },
     // gh namespace (live network via the user's gh login): librarian may call it; explore may not; gh: false removes it.
     { name: "gh-librarian", enabled: true, agent: "librarian", agentPermissions: true, gh: true,
       code: 'const repo = await tools.gh.repo({ repo: "cli/cli" }); const c = await tools.gh.clone({ repo: "cli/cli", depth: 2 }); const log = await tools.gh.log({ clone: c.path, count: 1 }); return { name: repo.data && repo.data.name, cloned: c.ok, path: c.path, sha: log.commits && log.commits[0] && log.commits[0].sha, tools: Object.keys(tools.gh).sort() }' },
     { name: "gh-explore", enabled: true, agent: "explore", agentPermissions: true, gh: true, code: 'let denied = null; try { const r = await tools.gh.repo({ repo: "cli/cli" }); denied = { ok: r.ok, name: r.data && r.data.name } } catch (e) { denied = { thrown: String(e).slice(0, 200) } }; return { has: Object.keys(tools).includes("gh"), call: denied }' },
     { name: "gh-off", enabled: true, agent: "librarian", agentPermissions: true, gh: false, ghOption: false, code: 'return { has: Object.keys(tools).includes("gh") }' },
     // Post-edit verification: the edit introduces a type error and a request-explaining comment; tsc runs on the fixture project.
     { name: "verify-edit", enabled: true, agent: "sisyphus", verify: "tsc" },
     { name: "verify-off", enabled: true, agent: "sisyphus", verify: "off", verifyOption: false },
  ]) {
    if (only && !only.has(scenario.name)) continue
    active = scenario
    const home = join(sandbox, scenario.name, "home"), project = join(home, "project")
    mkdirSync(project, { recursive: true })
    const config = join(sandbox, scenario.name, "config")
    mkdirSync(join(config, "opencode"), { recursive: true })
    const trace = join(evidence, `${scenario.name}-trace.ndjson`)
    const env = { PATH: process.env.PATH, TMPDIR: sandbox, HOME: home, USERPROFILE: home, PWD: project,
      XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(home,"data"), XDG_CACHE_HOME: join(home,"cache"), XDG_STATE_HOME: join(home,"state"),
      OPENCODE_TEST_HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", IOLAUS_TRACE: trace, OPENAI_API_KEY: "fake-key",
      // gh scenarios only: the sandbox HOME has no gh login, so pass the user's token through the environment (never written to disk).
      ...(scenario.gh && GH_TOKEN ? { GH_TOKEN } : {}) }
    const settings = { plugins: [{ package: join(root,"dist"), options: { enabled: scenario.enabled, mcps: scenario.mcps ?? [], ...(scenario.ghOption === undefined ? {} : { gh: scenario.ghOption }), ...(scenario.verifyOption === undefined ? {} : { verify: scenario.verifyOption }), ...(scenario.models ? { models: scenario.models } : {}) } }],
      model: "openai/gpt-5.5", default_agent: "build", ...(scenario.agentPermissions ? {} : { permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
      provider: { openai: { options: { apiKey: "fake-key", baseURL: mockURL }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } } }
    writeFileSync(join(config,"opencode/opencode.json"), JSON.stringify(settings))
    writeFileSync(join(project,"fixture.txt"), "IOLAUS_QA_NATIVE_READ_RESULT\n")
    if (scenario.astGrep) { mkdirSync(join(project, "src")); writeFileSync(join(project, "src", "a.ts"), AST_GREP_FIXTURE) }
    if (scenario.verify) {
      mkdirSync(join(project, "src")); writeFileSync(join(project, "src", "a.ts"), "const x = 1\nexport default x\n")
      writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["src"] }))
      mkdirSync(join(project, "node_modules", ".bin"), { recursive: true })
      symlinkSync(TSC_BIN, join(project, "node_modules", ".bin", "tsc"))
    }
    const fixture = { project, env }
    writeFileSync(join(evidence, `${scenario.name}-isolation.json`), JSON.stringify({ project, env: Object.fromEntries(Object.entries(env).filter(([k]) => k !== "PATH" && k !== "OPENAI_API_KEY" && k !== "GH_TOKEN")), ghTokenPassed: Boolean(env.GH_TOKEN) },null,2))
    if (scenario.name === "native") {
       await check("host version", async () => { const r = await run("version", ["--version"], fixture); assert.equal(r.code,0); assert.match(r.output,/2\.0\.16/) })
      await check("run help", async () => { const r = await run("help", ["run","--help"], fixture); assert.equal(r.code,0) })
    }
    await check(`${scenario.name}: live session`, async () => {
      const args = ["run", "--standalone", "--auto", "--print-logs", "--agent", scenario.agent, "--model", "openai/gpt-5.5"]
       args.push(scenario.template === "ultrawork" ? `/ultrawork IOLAUS_ULTRAWORK_TASK`
         : scenario.mode ? `/${scenario.mode} Read fixture.txt and report the result.`
         : scenario.dag ? "Run an Iolaus DAG and report the completed node result."
         : scenario.nativeRead ? "Read fixture.txt and report the result." : "Return IOLAUS_QA_DONE.")
      const result = await run(scenario.name,args,fixture)
      assert.equal(result.code,0)
      const traces = existsSync(trace) ? readFileSync(trace,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
      assert.ok(traces.some((t) => t.event === "iolaus.loaded" && t.enabled === scenario.enabled), "Plugin did not load")
       assert.equal(traces.some((t) => t.event === "iolaus.agent.rendered"), IOLAUS_AGENT_IDS.has(scenario.agent) || (Boolean(scenario.dag) && scenario.template !== "unavailable"))
       if (scenario.enabled) {
         // Display names drop the namespace; ids keep it; the host's own Explore keeps ours distinguishable.
         const named = Object.fromEntries(traces.filter((t) => t.event === "iolaus.agent.model").map((t) => [t.agent, t.name]))
         assert.equal(named["sisyphus"], "Sisyphus", `sisyphus display name: ${named["sisyphus"]}`)
         assert.equal(named["deep-high"], "Deep High", `deep-high display name: ${named["deep-high"]}`)
         assert.equal(named["explore"], "Explore", `explore display name: ${named["explore"]}`)
         assert.ok(traces.some((t) => t.event === "iolaus.agent.replaced" && t.agent === "explore"), "Iolaus did not take over the host's explore agent")
         // agent-home: the user layer is provisioned under the sandbox HOME only, and every rendered prompt carries the home contract.
         const ready = traces.find((t) => t.event === "iolaus.home.ready")
         assert.ok(ready, "iolaus.home.ready trace missing")
         assert.equal(ready.user, join(home, ".iolaus"), `user layer escaped the sandbox: ${ready.user}`)
         assert.ok(ready.project.startsWith(project), `project layer outside the project: ${ready.project}`)
         assert.ok(existsSync(join(home, ".iolaus", "README.md")), "user layer README missing")
         assert.ok(!existsSync(join(home, ".iolaus", "agent")), "Iolaus must not provision an agent/ directory (skills and memory are the host's)")
         assert.ok(existsSync(join(project, ".iolaus", "plans")), "project plans dir missing")
         const rendered = requests.filter((r) => r.scenario === scenario.name && r.instructions.includes("<iolaus-native-contract>"))
         if (rendered.length) assert.ok(rendered.every((r) => r.instructions.includes(`<iolaus-home>Iolaus config: user layer ${join(home, ".iolaus")}`)), "rendered prompt lacks the home contract")
       }
       assert.equal(traces.some((t) => t.event === "iolaus.mode.rendered"), Boolean(scenario.mode))
       if (scenario.dag && scenario.template !== "unavailable") {
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
         assert.deepEqual(inputs.map((i) => i.provenance.agent), ["sisyphus", "hephaestus"], "Fan-in provenance agent missing")
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
           assert.ok(calls.some((t) => t.tool === "search" && t.ok && t.agent === "explore" && t.matches === 2), "search call trace missing")
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
       if (scenario.code) {
         const withTools = captured.filter((r) => r.tools.includes("execute"))
         assert.ok(withTools.length, "execute was not offered to the agent")
         const catalog = withTools.at(-1).instructions.slice(withTools.at(-1).instructions.indexOf("# Code Mode"))
         const outputs = captured.flatMap((r) => JSON.parse(r.input).filter((item) => item?.type === "function_call_output").map((item) => typeof item.output === "string" ? item.output : JSON.stringify(item.output)))
         assert.ok(outputs.length, "execute returned no output to the model")
         const out = outputs.at(-1)
         const registered = traces.find((t) => t.event === "iolaus.mcp.registered")
         if (scenario.name === "mcps-librarian") {
           assert.deepEqual(registered?.registered, ["context7", "grep_app"], "built-in MCP servers were not registered")
           // The system-prompt catalog is rendered once per session, before remote servers finish connecting,
           // so the runtime catalog (Code Mode `search`) is the authority for MCP namespaces.
           assert.match(out, /tools\.context7\[\\?"query-docs\\?"\]/, `context7 query-docs missing from runtime catalog: ${out}`)
           assert.match(out, /tools\.context7\[\\?"resolve-library-id\\?"\]/, `context7 resolve-library-id missing from runtime catalog: ${out}`)
           assert.match(out, /tools\.grep_app\.searchGitHub/, `grep_app.searchGitHub missing from runtime catalog: ${out}`)
           assert.match(out, /\/reactjs\/react\.dev|\/facebook\/react|\/websites\/react_dev/i, `context7 did not resolve react: ${out}`)
           assert.match(out, /"grepHit": true/, `grep_app returned no useEffect match: ${out}`)
           assert.ok(!out.includes("No results found"), `grep_app returned no results: ${out}`)
           assert.ok(!out.includes("PERMISSION_DENIED") && !out.includes("permission"), `MCP call was denied for librarian: ${out}`)
         }
         if (scenario.name === "gh-librarian") {
           assert.ok(traces.some((t) => t.event === "iolaus.gh.registered" && t.authenticated), "gh tools were not registered")
           assert.match(catalog, /- gh \(12 tools/, `gh namespace missing from librarian catalog: ${catalog.slice(0, 400)}`)
           assert.match(out, /"name": "cli"/, `gh.repo did not return cli/cli: ${out}`)
           assert.match(out, /"cloned": true/, `gh.clone failed: ${out}`)
           assert.match(out, /"sha": "[0-9a-f]{40}"/, `gh.log returned no commit: ${out}`)
           const clonePath = out.match(/"path": "([^"]+)"/)?.[1]
           assert.ok(clonePath && clonePath.includes("/iolaus-gh-"), `clone path not under the gh temp root: ${clonePath}`)
           assert.ok(existsSync(join(clonePath, "README.md")), "clone directory missing on disk")
           rmSync(join(clonePath, ".."), { recursive: true, force: true })
           assert.ok(traces.filter((t) => t.event === "iolaus.gh.call" && t.ok).map((t) => t.tool).includes("clone"), "gh.call trace missing")
         }
         if (scenario.name === "gh-explore") {
           assert.ok(!catalog.includes("- gh ("), "read-only explore must not see the gh namespace")
           assert.ok(!out.includes('"name": "cli"'), `explore executed a gh call despite deny: ${out}`)
           assert.ok(!traces.some((t) => t.event === "iolaus.gh.call" && t.agent === "explore" && t.ok), "gh tool ran for explore")
         }
         if (scenario.name === "gh-off") {
           assert.ok(traces.some((t) => t.event === "iolaus.gh.unavailable" && t.enabled === false), "gh: false did not disable registration")
           assert.match(out, /"has": false/, `gh: false still exposed tools: ${out}`)
         }
         if (scenario.name === "mcps-off") {
           assert.equal(registered, undefined, "mcps: [] must not register servers")
           assert.ok(!catalog.includes("context7") && !catalog.includes("grep_app"), "disabled MCP namespaces leaked into the catalog")
           assert.ok(!out.includes("context7") && !out.includes("grep_app"), `disabled MCP namespaces leaked into tools: ${out}`)
         }
       }
       if (scenario.lanes) {
         const pinned = Object.fromEntries(traces.filter((t) => t.event === "iolaus.agent.model").map((t) => [t.agent, `${t.model}${t.variant ? `#${t.variant}` : ""}|${t.source}`]))
         assert.equal(pinned["oracle"], "openai/gpt-5.6-sol#xhigh|config", "oracle lane did not follow models config")
         assert.equal(pinned["quick"], "openai/gpt-6-luna-fast#low|config", "quick lane did not follow models config")
         assert.equal(pinned["sisyphus"], "anthropic/claude-opus-5-5#max|requirement", "sisyphus lane did not follow the requirement table")
         assert.equal(pinned["deep-high"], "openai/gpt-6-astra#xhigh|requirement", "deep-high lane missing")
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
       if (scenario.template === true) {
         const messageText = (r) => JSON.parse(r.input).filter((item) => item?.type === "message").flatMap((item) => item.content ?? []).map((part) => part?.text ?? "").join("\n")
         const texts = captured.map(messageText)
         const order = traces.filter((t) => t.event === "iolaus.dag.node.completed").map((t) => t.nodeID)
         assert.deepEqual(order.slice(0, 4), ["plan", "review", "revise", "rereview"], `template nodes ran out of order: ${order}`)
         assert.ok(traces.some((t) => t.event === "iolaus.dag.node.waiting" && t.nodeID === "approve"), "gate did not wait after the passing re-review")
         assert.ok(traces.some((t) => t.event === "iolaus.dag.node.approved" && t.nodeID === "approve"), "gate was not approved")
         assert.ok(order.includes("execute"), "executor did not run after approval")
         assert.ok(traces.some((t) => t.event === "iolaus.dag.run.completed"), "template run did not complete")
         const revise = texts.find((text) => text.includes("The reviewer rejected the plan"))
         assert.ok(revise && revise.includes("IOLAUS_PLAN_V1") && revise.includes("Step 2 has no verification"), "revise prompt lacks plan and review inputs")
         const execute = texts.find((text) => text.includes("Execute the approved plan"))
         assert.ok(execute && execute.includes("IOLAUS_PLAN_V2"), "execute prompt lacks the revised plan")
         const outputs = captured.flatMap((r) => JSON.parse(r.input).filter((item) => item?.type === "function_call_output").map((item) => String(item.output)))
         const created = outputs.map((o) => { try { return JSON.parse(o) } catch { return null } }).find((o) => o?.runID && o?.definition)
         assert.ok(created, "create with template returned no run")
         assert.equal(created.definition.nodes.find((n) => n.id === "plan").agent, "prometheus")
         assert.equal(created.definition.nodes.find((n) => n.id === "plan").model, "openai/gpt-5.5", "plan node did not get the configured Prometheus model")
       }
       if (scenario.template === "ultrawork") {
         // `opencode run "/ultrawork ..."` resolves the command client-side, so the plugin command's execute (and its
         // dispatched trace) is not involved; the context hook is what makes the mode a DAG, and its trace carries `dag`.
         const commanding = captured.find((r) => r.instructions.includes('<iolaus-mode-dag template="ultrawork">'))
         assert.ok(commanding, "commanding session's system prompt lacks the mode DAG instruction")
         const children = captured.filter((r) => JSON.parse(r.input).some((item) => item?.type === "message" && JSON.stringify(item).includes("<iolaus-dag-child>")))
         assert.ok(children.length >= 3, `DAG worker children were not prompted with the child marker (${children.length})`)
         assert.ok(children.every((r) => !r.instructions.includes("<iolaus-mode-dag")), "a DAG worker child was told to create another run")
         assert.ok(children.every((r) => r.instructions.includes("ULTRAWORK")), "DAG worker children did not get the ultrawork prompt")
         const order = traces.filter((t) => t.event === "iolaus.dag.node.completed").map((t) => t.nodeID)
         assert.deepEqual(order, ["work", "review", "work1", "review1", "work2", "review2"], `loop rounds ran out of order: ${order}`)
         // Dynamic loop: the graph started as work/review/accept and grew one pair per FAIL; reviews are judge nodes (no child session).
         assert.deepEqual(traces.filter((t) => t.event === "iolaus.dag.loop.grown").map((t) => t.nodeID), ["review", "review1"], "loop did not grow once per FAIL")
         const childSessions = traces.filter((t) => t.event === "iolaus.agent.rendered" && t.agent === "momus")
         assert.equal(childSessions.length, 0, "judge reviews must not open a momus child session")
         assert.ok(traces.some((t) => t.event === "iolaus.dag.node.waiting" && t.nodeID === "accept"), "loop did not reach the accept gate after the passing round")
         assert.ok(traces.some((t) => t.event === "iolaus.dag.node.approved" && t.nodeID === "accept"), "accept gate was not approved")
         assert.ok(traces.some((t) => t.event === "iolaus.dag.run.completed"), "ultrawork run did not complete")
         const messageText = (r) => JSON.parse(r.input).filter((item) => item?.type === "message").flatMap((item) => item.content ?? []).map((part) => part?.text ?? "").join("\n")
         const texts = captured.map(messageText)
         const work = texts.find((t) => t.includes("Achieve this goal end to end"))
         assert.ok((work ?? "").includes("<iolaus-mode:ultrawork>"), "work child prompt lacks the ultrawork marker")
         assert.ok(traces.some((t) => t.event === "iolaus.mode.rendered" && t.dag === "ultrawork"), "commanding session did not render the DAG instruction")
         assert.ok(traces.filter((t) => t.event === "iolaus.mode.rendered" && t.dag === null).length >= 3, "ultrawork prompt was not rendered for the loop's worker children")
         const fix2 = texts.find((t) => t.includes("Round 2: the reviewer rejected"))
         assert.ok(fix2 && fix2.includes("IOLAUS_ULTRAWORK_FIX1") && fix2.includes("Scenario 3 lacks evidence"), "work2 prompt lacks the previous fix and review inputs")
       }
       if (scenario.template === "unavailable") {
         const outputs = captured.flatMap((r) => JSON.parse(r.input).filter((item) => item?.type === "function_call_output").map((item) => String(item.output)))
         assert.ok(outputs.length, "create returned nothing")
         assert.match(outputs[0], /model_unavailable.*review \(iolaus-no-such-lane\)/, `fail-closed error missing: ${outputs[0]}`)
         assert.ok(!traces.some((t) => t.event === "iolaus.dag.run.started"), "run was started despite an unroutable lane")
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
      if (scenario.verify) {
        const outputs = captured.flatMap((r) => JSON.parse(r.input).filter((item) => item?.type === "function_call_output").map((item) => typeof item.output === "string" ? item.output : JSON.stringify(item.output)))
        assert.ok(outputs.length, `mutation returned no output to the model (tools: ${captured.at(-1)?.tools})`)
        const out = outputs.at(-1)
        const source = readFileSync(join(fixture.project, "src", "a.ts"), "utf8")
        assert.ok(source.includes('const x: number = "one"'), "edit was not applied")
        assert.equal(traces.some((t) => t.event === "iolaus.verify.registered" && t.enabled), scenario.verify === "tsc")
        if (scenario.verify === "tsc") {
          const ran = traces.find((t) => t.event === "iolaus.verify.ran")
          assert.ok(ran, `verify hook did not run: ${JSON.stringify(traces.filter((t) => String(t.event).startsWith("iolaus.verify")))}`)
          assert.deepEqual(ran.paths, ["src/a.ts"])
          assert.ok(ran.checkers.some((c) => c.name === "tsc" && !c.ok && c.diagnostics === 1), `tsc did not report the changed file: ${JSON.stringify(ran.checkers)}`)
          assert.equal(ran.comments, 1)
          assert.ok(out.includes("[iolaus verify] 2 issues"), `verification report missing from tool result: ${out}`)
          assert.ok(out.includes("tsc: src/a.ts:1") && out.includes("TS2322"), `tsc diagnostic missing: ${out}`)
          assert.ok(out.includes("comment-check: src/a.ts:1"), `comment diagnostic missing: ${out}`)
        } else {
          assert.ok(!traces.some((t) => String(t.event).startsWith("iolaus.verify.ran")), "verify ran while disabled")
          assert.ok(!out.includes("[iolaus verify]"), `disabled verify still appended a report: ${out}`)
        }
      }
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
