import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createApi } from "./host.mjs"
import { GOAL_PAYLOAD, TODO_PAYLOAD, TRANSPORT_PAYLOAD } from "./model.mjs"

const gatedTools = ["create_goal", "update_goal", "get_goal", "monitor_start", "monitor_stop", "monitor_list",
  "monitor_output", "team_create", "team_delete", "team_status", "team_list", "team_shutdown_request",
  "team_approve_shutdown", "team_reject_shutdown", "team_send_message", "team_task_create", "team_task_list",
  "team_task_get", "team_task_update"]

function systemText(request) {
  return [request.instructions ?? "", ...(request.input ?? [])
    .filter((item) => item.role === "system" || item.role === "developer").map((item) => JSON.stringify(item.content))].join("\n")
}

export async function runScenarios(options) {
  const { runner, fixture, model, evidence, check } = options
  const { mode } = fixture
  const host = await runner.serve(`${mode}-server`, fixture)
  const api = createApi(host, join(evidence, `${mode}-api.ndjson`))
  const observed = (name) => model.requests.filter((request) => request.scenario === `${mode}-${name}` && request.tools.length > 0)
  async function create(agent) {
    const result = await api("POST", "/api/session", {
      title: "API upgrade QA", location: { directory: fixture.project }, model: { providerID: "openai", id: "gpt-fake" },
      ...(agent ? { agent } : {}),
    })
    assert.equal(result.status, 200, "session.create must succeed")
    return result.body.data
  }
  async function drive(name, command, text) {
    const session = await create(name === "goal" || name === "ulw" ? "sisyphus" : undefined)
    model.select(`${mode}-${name}`, fixture.readPath)
    const base = `/api/session/${session.id}`
    const result = await api("POST", `${base}/${command ? "command" : "prompt"}`, {
      ...(command ? { command } : {}), text, delivery: "steer",
    })
    assert.equal(result.status, command ? 204 : 200, `${command ?? "prompt"} must be accepted by the real host`)
    assert.equal((await api("POST", `${base}/wait`)).status, 204)
    const messages = await api("GET", `${base}/message?limit=100&order=asc`)
    assert.equal(messages.status, 200)
    return { session, messages: messages.body.data, current: (await api("GET", base)).body.data }
  }
  try {
    await check(`${mode}: rejects unauthenticated API`, async () => {
      assert.equal((await api("GET", "/api/session", undefined, false)).status, 401)
    })
    await check(`${mode}: native command transport control`, async () => {
      const run = await drive("control", "qa-transport", TRANSPORT_PAYLOAD)
      assert.ok(run.messages.some((message) => message.type === "user" && message.text === TRANSPORT_PAYLOAD))
      assert.ok(observed("control").some((request) => JSON.stringify(request.input).includes(TRANSPORT_PAYLOAD)))
    })
    await check(`${mode}: OMO command registry`, async () => {
      const result = await api("GET", `/api/command?directory=${encodeURIComponent(fixture.project)}`)
      assert.equal(result.status, 200)
      const names = result.body.data.map((entry) => entry.name)
      assert.ok(names.includes("goal"), "registered OMO goal command must be listed")
      assert.ok(names.includes("ulw-execute"), "registered OMO ulw-execute command must be listed")
    })
    await check(`${mode}: rejects missing and malformed commands`, async () => {
      const session = await create()
      const endpoint = `/api/session/${session.id}/command`
      const missing = await api("POST", endpoint, { command: "qa-command-does-not-exist", text: "QA_REJECTED" })
      assert.equal(missing.status, 404)
      assert.equal((await api("POST", endpoint, { command: 42, text: "QA_REJECTED" })).status, 400)
      const messages = await api("GET", `/api/session/${session.id}/message`)
      assert.ok(messages.body.data.every((message) => message.type !== "user"))
    })
    await check(`${mode}: goal literal dollar payload and agent preservation`, async () => {
      const run = await drive("goal", "goal", GOAL_PAYLOAD)
      const users = run.messages.filter((message) => message.type === "user")
      assert.equal(users.length, 1, "one command must dispatch exactly one user message")
      assert.ok(users[0].text.includes(GOAL_PAYLOAD), "literal dollar tokens must survive command expansion")
      assert.ok(observed("goal").some((request) => JSON.stringify(request.input).includes(GOAL_PAYLOAD)))
      assert.equal(run.session.agent, "sisyphus", "fixture must pin a known initial agent")
      assert.equal(run.current.agent, "sisyphus", "goal must preserve the active agent")
      assert.equal(run.current.model.id, "gpt-fake", "goal must preserve the active model")
      assert.ok(run.messages.some((message) => message.type === "assistant" && message.agent === "sisyphus"))
    })
    await check(`${mode}: ulw-execute routes atlas`, async () => {
      const payload = "QA_ULW_ARGUMENT_19425"
      const run = await drive("ulw", "ulw-execute", payload)
      assert.equal(run.session.agent, "sisyphus", "fixture must distinguish routing from default")
      assert.equal(run.current.agent, "atlas")
      assert.equal(run.current.model.id, "gpt-atlas", "atlas model must replace the initial session model")
      assert.ok(observed("ulw").some((request) => request.model === "gpt-atlas"))
      assert.ok(run.messages.some((message) => message.type === "agent-switched" && message.agent === "atlas"))
      assert.ok(run.messages.some((message) => message.type === "assistant" && message.agent === "atlas"))
      assert.ok(observed("ulw").some((request) => JSON.stringify(request.input).includes(payload)))
    })
    await check(`${mode}: real read and todo tool cycle`, async () => {
      const run = await drive("native", undefined, "QA_NATIVE_TOOL_CYCLE_19425")
      const requests = observed("native")
      assert.ok(requests.length >= 4, "three native tool results must return to the model")
      const outputs = requests.flatMap((request) => request.input ?? []).filter((item) => item.type === "function_call_output")
      assert.ok(outputs.some((output) => JSON.stringify(output).includes("QA_NATIVE_READ_PAYLOAD")), "native read content must reach model")
      const calls = run.messages.flatMap((message) => message.type === "assistant" ? message.content : [])
        .filter((part) => part.type === "tool")
      assert.equal(calls.filter((call) => call.name === "todowrite" && call.state.status === "completed").length, 2,
        "both todo writes must execute successfully through the host")
      assert.ok(outputs.some((output) => /\d+#[ZPMQVRWSNKTXJBYH]{2}/.test(JSON.stringify(output))), "read content must carry hashline tags")
    })
    await check(`${mode}: todo context appears then clears`, async () => {
      const requests = observed("native")
      assert.ok(requests.length >= 4)
      assert.ok(!systemText(requests[0]).includes("<todo-state>"))
      assert.ok(requests.some((request) => systemText(request).includes("<todo-state>") && systemText(request).includes(TODO_PAYLOAD)))
      assert.ok(!systemText(requests.at(-1)).includes("<todo-state>"))
    })
    for (const [name, childModel, childAgent] of [["direct", "gpt-explore", "explore"], ["category", "gpt-quick", "quick"]]) {
      await check(`${mode}: real ${name} delegation`, async () => {
        const run = await drive(name, undefined, "QA_DELEGATION_PARENT")
        const requests = observed(name)
        assert.ok(requests.some((request) => request.model === childModel), "configured child model must execute")
        const outputs = requests.flatMap((request) => request.input ?? []).filter((item) => item.type === "function_call_output")
        assert.ok(outputs.some((output) => JSON.stringify(output).includes(`QA_CHILD_${childModel}_DONE`)), "child answer must return to parent")
        const calls = run.messages.flatMap((message) => message.type === "assistant" ? message.content : [])
          .filter((part) => part.type === "tool" && part.name === "task")
        assert.equal(calls.length, 1)
        assert.equal(calls[0].state.status, "completed")
        const trace = readFileSync(fixture.env.OMO_SPIKE_TRACE, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
        assert.ok(trace.some((entry) => entry.event === "omo.task.start" && entry.agent === childAgent && entry.model === `openai/${childModel}`))
        assert.ok(trace.some((entry) => entry.event === "omo.task.finished" && entry.ok === true))
      })
    }
    await check(`${mode}: feature-gated tools visible to model`, async () => {
      const requests = model.requests.filter((request) => request.scenario.startsWith(`${mode}-`) && request.tools.length > 0)
      assert.ok(requests.length > 0)
      for (const request of requests.filter((request) => request.model === "gpt-fake" || request.model === "gpt-atlas")) {
        assert.ok(request.tools.includes("background_output"), "OMO base tools must reach the model")
        for (const tool of gatedTools) assert.equal(request.tools.includes(tool), fixture.enabled, `${tool} visibility`)
      }
    })
  } finally {
    await host.stop()
    const trace = existsSync(fixture.env.OMO_SPIKE_TRACE) ? readFileSync(fixture.env.OMO_SPIKE_TRACE, "utf8") : ""
    writeFileSync(join(evidence, `${mode}.ndjson`), trace)
    await check(`${mode}: production hook trace`, async () => {
      const events = trace.trim().split("\n").filter(Boolean).map(JSON.parse)
      for (const event of ["omo.registration.complete", "omo.hashline.tag-applied", "omo.todo.write", "omo.context.composed"])
        assert.ok(events.some((entry) => entry.event === event), `${event} must fire`)
      const registration = events.find((entry) => entry.event === "omo.registration.complete")
      assert.ok(registration.subagents.includes("explore"))
      assert.ok(registration.categories.includes("quick"))
      assert.ok(events.some((entry) => entry.event === "omo.context.sisyphus" && entry.agent === "sisyphus" && entry.rebaked === true))
      assert.ok(events.some((entry) => entry.event === "omo.context.sisyphus" && entry.agent === "atlas" && entry.rebaked === false))
    })
  }
}
