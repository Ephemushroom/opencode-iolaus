import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "./qa-api-upgrade/fixture.mjs"
import { createApi, createHostRunner, hostState } from "./qa-api-upgrade/host.mjs"
import { createWorkflowTeamModel } from "./qa-workflow-team-model.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
assert.ok(process.argv[2], "Usage: node qa-workflow-team.mjs NEW_EVIDENCE_DIR")
const evidence = resolve(process.argv[2])
assert.ok(evidence.startsWith(join(repo, ".omo/evidence") + "/"))
mkdirSync(evidence)
const trace = (entry) => appendFileSync(join(evidence, "trace.ndjson"), JSON.stringify(entry) + "\n")
const before = hostState()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "omo-workflow-team-")))
const binary = process.env.QA_OPENCODE_BIN ?? execFileSync("which", ["opencode2"], { encoding: "utf8" }).trim()
const runner = createHostRunner(binary, evidence)
const results = []
let model
let fixture
let version
try {
  model = await createWorkflowTeamModel(evidence)
  fixture = createFixture({ sandbox, mode: "enabled", repo, mockUrl: model.url })
  const config = JSON.parse(readFileSync(fixture.configPath, "utf8"))
  config.permissions = [{ action: "*", resource: "*", effect: "allow" }]
  writeFileSync(fixture.configPath, JSON.stringify(config))
  const versionRun = await runner.run("version", ["--version"], fixture)
   version = versionRun.output.match(/^(?:opencode2? v)?(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/m)?.[1]
  assert.equal(versionRun.code, 0)
   assert.equal(version, "2.0.3")
   let host = await runner.serve("workflow-team", fixture)
   let api = createApi(host, join(evidence, "api.ndjson"))
  assert.equal((await api("GET", "/api/session", undefined, false)).status, 401)
  const parent = await api("POST", "/api/session", { location: { directory: fixture.project },
    title: "Native workflow Team QA", agent: "build", model: { providerID: "openai", id: "gpt-fake" } })
  assert.equal(parent.status, 200)
  const base = `/api/session/${parent.body.data.id}`
  let sequence = 0
  async function tool(name, input, expectedStatus = "completed") {
    const id = `call_qa_${++sequence}`
    const start = model.requests.length
    model.arm({ name, input, id })
    assert.equal((await api("POST", `${base}/prompt`, { text: `QA_STEP_${sequence}`, delivery: "steer" })).status, 200)
    assert.equal((await api("POST", `${base}/wait`)).status, 204)
    const messages = await api("GET", `${base}/message?limit=100&order=asc`)
    assert.equal(messages.status, 200)
    const calls = messages.body.data.flatMap((message) => message.type === "assistant" ? message.content : [])
      .filter((part) => part.type === "tool" && part.name === name)
    const call = calls.at(-1)
    trace({ event: "host-tool", id, name, input, call })
    assert.ok(call, `${name} must execute in the actual host`)
    assert.equal(call.state.status, expectedStatus, JSON.stringify(call))
    const output = model.requests.slice(start).flatMap((request) => request.input ?? [])
      .find((item) => item.type === "function_call_output" && item.call_id === id)
    assert.ok(output, `${name} result must return to the model`)
    trace({ event: "model-tool-output", id, name, output })
    if (expectedStatus !== "completed") return output
    const raw = typeof output.output === "string" ? output.output
      : output.output.map((part) => part.text).join("")
    try { return JSON.parse(raw) } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return raw
    }
  }
  const started = await tool("workflow", { action: "start", key: "native-host-qa", nodes: [
    { id: "one", prompt: "QA_WORKFLOW_NODE", agent: "explore", model: "openai/gpt-explore", dependsOn: [] },
  ] })
  const visible = model.requests.find((request) => request.model === "gpt-fake" && request.tools.length)
  for (const name of ["workflow", "team_create", "team_send_message", "team_status", "team_delete", "task", "background_output", "background_cancel"])
    assert.ok(visible.tools.includes(name), `Missing registered tool ${name}`)
  results.push({ name: "native plugin tools visible in actual model request", verdict: "PASS" })
  const completed = await tool("workflow", { action: "wait", id: started.id })
  assert.equal(completed.status, "completed")
  assert.equal(completed.nodes[0].state.output, "QA_WORKFLOW_NODE_DONE")
  results.push({ name: "workflow start and wait execute a real model-backed node", verdict: "PASS" })
  const team = await tool("team_create", { name: "qa-native-team", members: [
    { name: "worker", kind: "category", category: "quick", prompt: "QA_TEAM_INITIAL" },
  ] })
  const memberID = team.runtimeState.members.find((member) => member.name === "worker").sessionId
  assert.equal((await api("POST", `/api/session/${memberID}/wait`)).status, 204)
  await tool("team_send_message", { teamRunId: team.teamRunId, to: "worker", body: "QA_TEAM_MESSAGE" })
  assert.equal((await api("POST", `/api/session/${memberID}/wait`)).status, 204)
  const memberMessages = (await api("GET", `/api/session/${memberID}/message?limit=100&order=asc`)).body.data
  assert.ok(memberMessages.some((message) => message.type === "assistant" && message.content.some((part) => part.type === "text" && part.text === "QA_TEAM_MESSAGE_DONE")))
  assert.equal((await tool("team_delete", { teamRunId: team.teamRunId, force: true })).deleted, true)
  results.push({ name: "Team create message status and delete via native tools", verdict: "PASS" })
  const childrenBefore = model.requests.filter((request) => request.model === "gpt-explore").length
  await tool("workflow", { action: "start", key: "invalid-empty", nodes: [] }, "error")
  assert.equal(model.requests.filter((request) => request.model === "gpt-explore").length, childrenBefore)
  results.push({ name: "invalid workflow rejected without child model dispatch", verdict: "PASS" })
  const node = (id, prompt, dependsOn = []) => ({ id, prompt, dependsOn, agent: "explore", model: "openai/gpt-explore" })
  for (const nodes of [[node("a", "bad", ["missing"])], [node("a", "bad", ["b"]), node("b", "bad", ["a"])], [{ ...node("a", "bad"), agent: "unknown" }], [{ ...node("a", "bad"), model: "invalid" }]]) {
    await tool("workflow", { action: "start", key: `invalid-${sequence}`, nodes }, "error")
  }
  assert.equal(model.requests.filter((request) => request.model === "gpt-explore").length, childrenBefore)
  model.hold("QA_FRONTIER_B")
  model.watch("QA_FRONTIER_C")
  const graph = { action: "start", key: "frontier", nodes: [node("a", "QA_FRONTIER_A"), node("b", "QA_FRONTIER_B"), node("c", "QA_FRONTIER_C", ["a"])] }
  const frontier = await tool("workflow", graph)
  await model.entered("QA_FRONTIER_B")
  await model.entered("QA_FRONTIER_C")
  assert.equal((await tool("workflow", graph)).id, frontier.id)
  assert.equal((await tool("workflow", { action: "snapshot", id: frontier.id })).status, "running")
  model.release("QA_FRONTIER_B")
  assert.equal((await tool("workflow", { action: "wait", id: frontier.id })).status, "completed")
  results.push({ name: "frontier advances without a wave barrier and same-key start is idempotent", verdict: "PASS" })
  model.failOnce("QA_FAIL_ONCE")
  const retryable = await tool("workflow", { action: "start", key: "retry", nodes: [node("kept", "QA_KEEP_SUCCESS"), node("failed", "QA_FAIL_ONCE")] })
  const failed = await tool("workflow", { action: "wait", id: retryable.id })
  assert.equal(failed.status, "failed")
  const retryInput = { action: "retry", id: retryable.id, expected_generation: 1, retry_key: "retry-once" }
  assert.equal((await tool("workflow", retryInput)).generation, 2)
  assert.equal((await tool("workflow", retryInput)).generation, 2)
  await tool("workflow", { ...retryInput, retry_key: "stale" }, "error")
  const recovered = await tool("workflow", { action: "wait", id: retryable.id })
  assert.equal(recovered.status, "completed")
  assert.deepEqual(recovered.nodes[0], failed.nodes[0])
  assert.equal(model.requests.filter((request) => request.model === "gpt-explore" && JSON.stringify(request.input).includes("QA_KEEP_SUCCESS")).length, 1)
  results.push({ name: "explicit retry preserves successful nodes and enforces idempotent keys and generation checks", verdict: "PASS" })
  const held = Array.from({ length: 6 }, (_, index) => `QA_WORKFLOW_HELD_${index}`)
  for (const marker of held) model.hold(marker)
  const cancellable = await tool("workflow", { action: "start", key: "cancel", nodes: held.map((marker, index) => node(`held-${index}`, marker)) })
  await Promise.all(held.slice(0, 5).map((marker) => model.entered(marker)))
  await tool("workflow", { action: "cancel", id: cancellable.id })
  assert.equal((await tool("workflow", { action: "wait", id: cancellable.id })).status, "cancelled")
  assert.ok(!model.requests.some((request) => request.model === "gpt-explore" && JSON.stringify(request.input).includes(held[5])))
  results.push({ name: "workflow cancellation drains five held executions without starting its queued node", verdict: "PASS" })
  model.hold("QA_SCOPE_HELD")
  const unfinished = await tool("workflow", { action: "start", key: "active-restart", nodes: [node("scope", "QA_SCOPE_HELD")] })
  await model.entered("QA_SCOPE_HELD")
  const countBeforeRestart = model.requests.filter((request) => request.model === "gpt-explore").length
  await host.stop()
  host = await runner.serve("workflow-team-restarted", fixture)
  api = createApi(host, join(evidence, "restart-api.ndjson"))
  assert.deepEqual(await tool("workflow", { action: "snapshot", id: retryable.id }), recovered)
  const stopped = await tool("workflow", { action: "snapshot", id: unfinished.id })
  assert.ok(["failed", "cancelled"].includes(stopped.status), "active work must not survive host shutdown as running")
  assert.equal(model.requests.filter((request) => request.model === "gpt-explore").length, countBeforeRestart)
  for (const marker of held) model.release(marker)
  const retried = await tool("workflow", { action: "retry", id: cancellable.id, expected_generation: 1, retry_key: "after-restart" })
  assert.equal(retried.generation, 2)
  assert.equal((await tool("workflow", { action: "wait", id: cancellable.id })).status, "completed")
  results.push({ name: "host restart retains terminal history and requires explicit retry before new work", verdict: "PASS" })
  model.release("QA_SCOPE_HELD")
  await tool("workflow", { action: "retry", id: unfinished.id, expected_generation: 1, retry_key: "retry-interrupted" })
  assert.equal((await tool("workflow", { action: "wait", id: unfinished.id })).status, "completed")
  results.push({ name: "active host shutdown settles owned work and a reopened runtime can explicitly retry it", verdict: "PASS" })
} catch (error) {
  results.push({ name: "native workflow and Team lifecycle", verdict: "FAIL", error: String(error) })
  trace({ event: "failure", error: String(error) })
} finally {
  const cleanup = await Promise.allSettled([runner.cleanup(), model?.close()])
  rmSync(sandbox, { recursive: true, force: true })
  const after = hostState()
  try {
    assert.deepEqual(after, before)
    assert.ok(cleanup.every((result) => result.status === "fulfilled"))
    assert.ok(runner.processes.every((process) => process.closed))
    assert.equal(model?.closed, true)
    assert.deepEqual(model?.errors ?? [], [])
    results.push({ name: "real host unchanged and owned resources cleaned", verdict: "PASS" })
  } catch (error) { results.push({ name: "isolation and cleanup", verdict: "FAIL", error: String(error) }) }
  const verdict = results.some((result) => result.verdict === "FAIL") ? "FAIL" : "PASS"
  const receipt = { verdict, version, results, before, after, processes: runner.processes,
    sandboxRemoved: true, mockClosed: model?.closed, cleanup, invocation: process.argv.slice(1),
    isolation: fixture && Object.fromEntries(Object.entries(fixture.env).filter(([key]) =>
      ["HOME", "USERPROFILE", "PWD", "OPENCODE_TEST_HOME"].includes(key) || key.startsWith("XDG_"))),
    omitted: "No inherited credentials, raw real-host configs or authorization headers recorded." }
  trace({ event: "receipt", verdict })
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
  console.log(JSON.stringify({ evidence, verdict, results }, null, 2))
  process.exitCode = verdict === "PASS" ? 0 : 1
}
