/**
 * Live QA for vendor-lane prompt rendering.
 *
 * Runs real sessions in an isolated HOME against a local mock model, one per
 * model identity, and asserts on the system prompt the host actually handed to
 * the provider. That is the only place where prompt routing, the flow section
 * and the removal of the dead todo tools can be observed together.
 *
 * Positive: every lane renders, the model is named, and the flow rule is present.
 * Negative: no rendered prompt names a tool this harness does not register.
 * Isolation: sandbox HOME/XDG only; the user's host state is hashed before and after.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const evidence = resolve(process.argv[2] ?? join(root, `.iolaus/evidence/${new Date().toISOString().replace(/[:.]/g, "-")}-prompt-lanes`))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence")}/`), "evidence dir must stay under .iolaus/evidence")
mkdirSync(evidence, { recursive: false })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-prompt-qa-")))
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const results = [], requests = [], processes = [], errors = []
let scenarioRequests = 0

const digest = (value) => createHash("sha256").update(value).digest("hex")
function hostState() {
  const home = homedir()
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config")
  const files = [join(config, "opencode/opencode.json"), join(config, "opencode/opencode.jsonc"), join(home, ".iolaus/iolaus.json"), join(home, ".local/share/opencode/auth.json")]
  return Object.fromEntries(files.map((p) => [p, existsSync(p) ? digest(readFileSync(p)) : "absent"]))
}
const before = hostState()

async function check(name, fn) {
  try { await fn(); results.push({ name, verdict: "PASS" }) }
  catch (error) { results.push({ name, verdict: "FAIL", error: String(error) }) }
  writeFileSync(join(evidence, "assertions.json"), JSON.stringify(results, null, 2))
  console.error(`${results.at(-1).verdict} ${name}`)
}

function events(text) {
  const id = `resp_${requests.length}`, item = `item_${requests.length}`
  return [
    { type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: item } },
    { type: "response.output_text.delta", item_id: item, output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: item } },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]
}

/** Anthropic Messages API stream: the same text, in the wire format /v1/messages expects. */
function messageEvents(text) {
  return [
    { event: "message_start", data: { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]
}

const server = http.createServer(async (req, res) => {
  try {
    const path = (req.url ?? "").split("?")[0]
    if (req.method !== "POST" || (path !== "/v1/responses" && path !== "/v1/messages")) return res.writeHead(404).end()
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const anthropicWire = path === "/v1/messages"
    // Messages API carries the system prompt in `system` (string or text blocks);
    // Responses API carries it in `instructions`.
    const systemText = Array.isArray(body.system)
      ? body.system.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
      : body.system ?? body.instructions ?? ""
    const record = {
      scenario: process.env.IOLAUS_QA_SCENARIO,
      wire: anthropicWire ? "messages" : "responses",
      model: body.model,
      instructions: systemText,
      tools: (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name),
    }
    requests.push(record)
    appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify({ scenario: record.scenario, wire: record.wire, model: record.model, chars: record.instructions.length, tools: record.tools }) + "\n")
    scenarioRequests += 1
    assert.ok(scenarioRequests < 8, "unexpected model loop")
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    if (anthropicWire) {
      for (const { event, data } of messageEvents("IOLAUS_PROMPT_QA_DONE")) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
    } else {
      for (const event of events("IOLAUS_PROMPT_QA_DONE")) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end("data: [DONE]\n\n")
    }
  } catch (error) { errors.push(String(error)); res.writeHead(500).end("mock error") }
})

async function run(name, args, fixture) {
  const child = spawn(binary, args, { cwd: fixture.project, env: fixture.env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  processes.push({ name, pid: child.pid })
  let output = ""
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; appendFileSync(join(evidence, `${name}.log`), data) })
  const deadline = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 90000)
  try {
    const [code] = await once(child, "close")
    return { code, output }
  } finally { clearTimeout(deadline) }
}

/** Models, each with the lane config that makes the host route it to an Iolaus agent. */
const SCENARIOS = [
  { name: "opus-5-5", agent: "sisyphus", model: "anthropic/claude-opus-5-5", expectName: "claude-opus-5-5" },
  { name: "opus-4-8", agent: "sisyphus", model: "anthropic/claude-opus-4-8", expectName: "Opus 4.8" },
  // Same model id behind an OpenAI-compatible gateway: the name must still decide
  // the vendor, class and version. This is the reseller case, not a protocol test.
  { name: "opus-4-8-gateway", agent: "sisyphus", model: "openai/claude-opus-4-8", expectName: "Opus 4.8" },
  { name: "gpt-6-astra", agent: "sisyphus", model: "openai/gpt-6-astra", expectName: "Astra" },
  { name: "gpt-5-5", agent: "sisyphus", model: "openai/gpt-5.5", expectName: "GPT-5.5" },
  { name: "hephaestus-astra", agent: "hephaestus", model: "openai/gpt-6-astra", expectName: "Astra" },
  // Claude's large models are Hephaestus carriers too; they must get the Claude
  // body, not the generic GPT one.
  { name: "hephaestus-opus", agent: "hephaestus", model: "anthropic/claude-opus-5-5", expectName: "Claude Opus 5.5" },
  // Prometheus renders one model-independent prompt. It is run on two different
  // models so the harness proves that, instead of implying a binding.
  { name: "prometheus-astra", agent: "prometheus", model: "openai/gpt-6-astra", expectName: "Prometheus" },
  { name: "prometheus-opus", agent: "prometheus", model: "anthropic/claude-opus-5-5", expectName: "Prometheus" },
  // OMO-style keywords. `ulw` must enter ultrawork and the run must be a flow;
  // `mass-ulw` must make the agent author the graph itself.
  { name: "ulw-opus", agent: "sisyphus", model: "anthropic/claude-opus-5-5", expectName: "claude-opus-5-5", task: "ulw Fix the failing build.", keyword: "ultrawork" },
  { name: "mass-ulw-astra", agent: "sisyphus", model: "openai/gpt-6-astra", expectName: "Astra", task: "mass-ulw Migrate every service.", keyword: "mass-ulw" },
]

const DEAD_TOOL = /todowrite|task_create|TaskCreate|TaskUpdate|task_update|TODO CONTINUATION|TASK CONTINUATION|background_output|background_cancel|load_skills|run_in_background|call_omo_agent|subagent_type|delegate_task|team_(?:create|task|send|shutdown|delete|approve|list)|update_plan|oh-my-opencode/i

let after
try {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const mockURL = `http://127.0.0.1:${server.address().port}/v1`

  for (const scenario of SCENARIOS) {
    process.env.IOLAUS_QA_SCENARIO = scenario.name
    const home = join(sandbox, scenario.name, "home")
    const project = join(home, "project")
    mkdirSync(project, { recursive: true })
    const config = join(sandbox, scenario.name, "config")
    mkdirSync(join(config, "opencode"), { recursive: true })
    const iolausHome = join(home, ".iolaus")
    mkdirSync(iolausHome, { recursive: true })
    // Anthropic models go over the native Messages API so the transport those
    // models actually use is exercised; the rest use the OpenAI Responses wire.
    const vendor = scenario.model.split("/")[0]
    const served = scenario.model.split("/")[1]
    const wire = scenario.model
    const providerConfig = vendor === "anthropic"
      ? { anthropic: { options: { apiKey: "fake-key", baseURL: mockURL }, models: { [served]: { tool_call: true, limit: { context: 200000, output: 8192 } } } } }
      : { openai: { options: { apiKey: "fake-key", baseURL: mockURL }, models: { [served]: { tool_call: true, limit: { context: 200000, output: 8192 } } } } }
    const models = { agents: { [scenario.agent]: wire }, categories: { quick: wire } }
    writeFileSync(join(iolausHome, "iolaus.json"), JSON.stringify({ enabled: true, mcps: [], models }))
    writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
      plugins: [{ package: join(root, "dist") }],
      model: wire,
      default_agent: "build",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      provider: providerConfig,
    }))
    const env = {
      PATH: process.env.PATH, TMPDIR: sandbox, HOME: home, USERPROFILE: home, PWD: project,
      XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
      OPENCODE_TEST_HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      IOLAUS_HOME: iolausHome, OPENAI_API_KEY: "fake-key", ANTHROPIC_API_KEY: "fake-key",
    }
    writeFileSync(join(evidence, `${scenario.name}-isolation.json`), JSON.stringify({ project, env: Object.fromEntries(Object.entries(env).filter(([k]) => k !== "PATH" && !k.endsWith("_API_KEY"))) }, null, 2))

    scenarioRequests = 0
    const startIndex = requests.length
    await check(`${scenario.name}: real session renders a prompt`, async () => {
      const result = await run(scenario.name, ["run", "--standalone", "--auto", "--print-logs", "--agent", scenario.agent, "--model", wire, scenario.task ?? "Return IOLAUS_PROMPT_QA_DONE."], { project, env })
      assert.equal(result.code, 0, result.output.slice(-2000))
      assert.ok(requests.length > startIndex, "the mock received no request, so no prompt was rendered")
    })

    await check(`${scenario.name}: names the model it runs on`, () => {
      const instructions = requests.slice(startIndex).map((r) => r.instructions).join("\n")
      assert.ok(instructions.includes(scenario.expectName), `prompt does not name ${scenario.expectName}`)
    })

    await check(`${scenario.name}: carries no tool this harness does not register`, () => {
      const instructions = requests.slice(startIndex).map((r) => r.instructions).join("\n")
      const hit = instructions.match(DEAD_TOOL)
      assert.equal(hit?.[0], undefined, `dead tool reference: ${hit?.[0]}`)
    })

    if (scenario.agent === "sisyphus") {
      await check(`${scenario.name}: carries the flow rule`, () => {
        const instructions = requests.slice(startIndex).map((r) => r.instructions).join("\n")
        assert.ok(instructions.includes("iolaus_flow"), "no iolaus_flow rule in the rendered prompt")
        // The section is an orchestration capability, not a todo replacement: assert
        // what it promises and that it does not turn itself into a ledger.
        assert.ok(instructions.includes("Fresh context per node"), "flow section lacks its context rationale")
        assert.ok(!/stays tracked/i.test(instructions), "flow section is framed as progress tracking")
        assert.ok(!/multi-part work is tracked/i.test(instructions), "flow section is framed as progress tracking")
      })
    }
    if (scenario.keyword) {
      await check(`${scenario.name}: keyword "${scenario.keyword}" injects the flow mandate`, () => {
        const instructions = requests.slice(startIndex).map((r) => r.instructions).join("\n")
        assert.ok(instructions.includes("iolaus_flow"), "keyword mode rendered without iolaus_flow")
        const marker = scenario.keyword === "mass-ulw" ? 'mode="mass-ulw"' : 'template="ultrawork"'
        assert.ok(instructions.includes(marker), `keyword mode rendered without ${marker}`)
        if (scenario.keyword === "mass-ulw") {
          assert.ok(instructions.includes("one run per phase"), "mass-ulw does not require a run per phase")
          assert.ok(instructions.includes("dependency graph"), "mass-ulw does not ask for a graph")
        } else {
          assert.ok(instructions.includes("Your first tool call is iolaus_flow"), "ultrawork does not mandate a flow first")
        }
      })
    }
    if (scenario.agent === "hephaestus") {
      await check(`${scenario.name}: worker contract, not orchestration`, () => {
        const instructions = requests.slice(startIndex).map((r) => r.instructions).join("\n")
        assert.ok(instructions.includes("Do not create a flow of your own"), "hephaestus got no worker contract")
      })
    }
    if (scenario.agent === "prometheus") {
      await check(`${scenario.name}: planner doctrine is real content`, () => {
        // The host calls a title generator before the agent's first turn, so pick
        // the request that actually carries the planner prompt.
        const planner = requests.slice(startIndex).map((r) => r.instructions).filter((text) => text.includes("You are Prometheus"))
        assert.ok(planner.length > 0, "no request carried the Prometheus prompt")
        const text = planner.join("\n")
        assert.ok(text.includes("Blocked by"), "prometheus prompt has no ticket dependency contract")
        assert.ok(!text.includes("ulw-plan"), "prometheus still points at a skill this plugin does not ship")
      })
    }
  }
  await check("prometheus: the planner prompt is identical on every model", () => {
    // renderAgent drops the model for Prometheus, so the part Iolaus renders must
    // match byte for byte. The host appends its own fragments after the Iolaus
    // contract (sandbox paths, "# Your Model", "<env>"); those are compared out.
    const iolausPart = (text) => {
      // The home contract names the sandbox path, which differs per scenario by
      // construction; everything the renderer derives from the model is kept.
      const start = text.indexOf("<iolaus-home>")
      const end = text.indexOf("</iolaus-home>")
      const withoutHome = start !== -1 && end !== -1 ? text.slice(0, start) + text.slice(end + "</iolaus-home>".length) : text
      const model = withoutHome.indexOf("# Your Model")
      return model === -1 ? withoutHome : withoutHome.slice(0, model)
    }
    const rendered = ["prometheus-astra", "prometheus-opus"].map((name) =>
      requests.filter((r) => r.scenario === name).map((r) => r.instructions).filter((text) => text.includes("You are Prometheus")).map(iolausPart))
    assert.ok(rendered[0].length > 0 && rendered[1].length > 0, "one of the two models rendered no planner prompt")
    assert.equal(rendered[0][0], rendered[1][0], "the Prometheus prompt differs by model")
  })
  after = hostState()
  await check("host state untouched", () => assert.deepEqual(after, before))
  await check("mock protocol", () => assert.deepEqual(errors, []))
} finally {
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ binary, results, before, after, processes, sandboxRemoved: !existsSync(sandbox), mockClosed: !server.listening, requestCount: requests.length, omitted: "No user credentials or inherited environment dumps. Local mock only." }, null, 2))
  await new Promise((done) => server.close(done))
  for (const record of processes) { try { process.kill(-record.pid, "SIGKILL") } catch {} }
  rmSync(sandbox, { recursive: true, force: true })
  // Keep the rendered prompts for review; they contain no credentials.
  writeFileSync(join(evidence, "prompts.json"), JSON.stringify(requests.map((r) => ({ scenario: r.scenario, model: r.model, length: r.instructions.length, tools: r.tools })), null, 2))
  writeFileSync(join(evidence, "full-prompts.txt"), requests.map((r) => `===== ${r.scenario} (${r.model}) =====\n${r.instructions}\n`).join("\n"))
}
const failed = results.filter((r) => r.verdict === "FAIL")
console.log(JSON.stringify({ evidence, passed: results.length - failed.length, failed: failed.length }, null, 2))
process.exit(failed.length ? 1 : 0)
