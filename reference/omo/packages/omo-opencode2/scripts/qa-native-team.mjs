import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "./qa-api-upgrade/fixture.mjs"
import { createApi, createHostRunner, hostState } from "./qa-api-upgrade/host.mjs"
import { createTeamModel } from "./qa-native-team-model.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
assert.ok(process.argv[2], "usage: node qa-native-team.mjs NEW_EVIDENCE_DIR")
const evidence = resolve(process.argv[2])
assert.ok(evidence.startsWith(join(repo, ".omo/evidence/")))
mkdirSync(evidence)
const before = hostState()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "omo-native-team-")))
const binary = process.env.QA_OPENCODE_BIN ?? execFileSync("which", ["opencode2"], { encoding: "utf8" }).trim()
const runner = createHostRunner(binary, evidence)
const results = []
let model
let fixture
try {
  model = await createTeamModel(evidence)
  fixture = createFixture({ sandbox, mode: "enabled", repo, mockUrl: model.url })
  const optionsPath = fixture.omoConfigPath
  const config = JSON.parse(readFileSync(optionsPath, "utf8"))
  config.btw = { enabled: true }
  config.monitor = { enabled: true, allowed_commands: ["bun"], batch_max_lines: 1 }
  writeFileSync(optionsPath, JSON.stringify(config))
  const version = await runner.run("version", ["--version"], fixture)
  assert.match(version.output, /2\.0\.3/)
  const host = await runner.serve("native-team", fixture)
  const api = createApi(host, join(evidence, "api.ndjson"))
  const create = async () => {
    const result = await api("POST", "/api/session", { title: "Native Team QA", location: { directory: fixture.project },
      agent: "sisyphus", model: { providerID: "openai", id: "gpt-fake" } })
    assert.equal(result.status, 200)
    return result.body.data.id
  }
  const lead = await create()
  async function call(sessionID, tool, input) {
    const operation = model.operation(tool, input)
    assert.equal((await api("POST", `/api/session/${sessionID}/prompt`, { text: operation.marker, delivery: "queue" })).status, 200)
    assert.equal((await api("POST", `/api/session/${sessionID}/wait`)).status, 204)
    assert.equal(typeof operation.output, "string", `${tool} must return through the real model tool loop`)
    return operation.output
  }
  model.watch("QA_TEAM_INITIAL_INPUT")
  const created = JSON.parse(await call(lead, "team_create", { name: "native-qa", members: [
    { name: "worker", kind: "category", category: "quick", prompt: "QA_TEAM_INITIAL_INPUT" },
  ] }))
  assert.equal(typeof created.teamRunId, "string")
  const teamRunId = created.teamRunId
  const member = created.runtimeState.members.find((entry) => entry.name === "worker")
  assert.ok(member?.sessionId)
  await model.entered("QA_TEAM_INITIAL_INPUT")
  assert.equal((await api("POST", `/api/session/${member.sessionId}/wait`)).status, 204)
  results.push({ name: "full Team creates a configured category member through real execution", verdict: "PASS" })
  model.watch("QA_TEAM_FOLLOWUP_INPUT")
  await call(lead, "team_send_message", { teamRunId, to: "worker", body: "QA_TEAM_FOLLOWUP_INPUT" })
  await model.entered("QA_TEAM_FOLLOWUP_INPUT")
  assert.equal((await api("POST", `/api/session/${member.sessionId}/wait`)).status, 204)
  const history = await api("GET", `/api/session/${member.sessionId}/message?limit=100&order=asc`)
  assert.ok(history.body.data.some((entry) => entry.type === "user" && entry.text.includes("QA_TEAM_INITIAL_INPUT")))
  assert.ok(history.body.data.some((entry) => entry.type === "user" && entry.text.includes("QA_TEAM_FOLLOWUP_INPUT")))
  results.push({ name: "member followup is a new admitted turn on the retained session", verdict: "PASS" })
  const task = JSON.parse(await call(lead, "team_task_create", { teamRunId, subject: "QA assignment", description: "QA tasklist payload" }))
  writeFileSync(join(evidence, "task-create.json"), JSON.stringify(task, null, 2))
  const listed = await call(lead, "team_task_list", { teamRunId })
  assert.match(listed, /QA assignment/)
  const status = JSON.parse(await call(lead, "team_status", { teamRunId }))
  writeFileSync(join(evidence, "team-status.json"), JSON.stringify(status, null, 2))
  results.push({ name: "preserved Team tasklist and status tools operate on durable Team core state", verdict: "PASS" })
  const outsider = await create()
  assert.match(await call(outsider, "team_delete", { teamRunId, force: true }), /not a participant|lead-only/i)
  results.push({ name: "foreign session cannot delete the team", verdict: "PASS" })
  await call(lead, "team_shutdown_request", { teamRunId, targetMemberName: "worker" })
  await call(lead, "team_reject_shutdown", { teamRunId, memberName: "worker", reason: "QA continue" })
  await call(lead, "team_send_message", { teamRunId, to: "worker", body: "QA_TEAM_AFTER_REJECTION" })
  await call(lead, "team_shutdown_request", { teamRunId, targetMemberName: "worker" })
  await call(lead, "team_approve_shutdown", { teamRunId, memberName: "worker" })
  assert.match(await call(lead, "team_send_message", { teamRunId, to: "worker", body: "QA_AFTER_APPROVAL_MUST_NOT_RUN" }), /closed|shutdown|inactive|no.*recipient/i)
  const deleted = JSON.parse(await call(lead, "team_delete", { teamRunId, force: true }))
  assert.equal(deleted.deleted, true)
  results.push({ name: "shutdown request rejection approval and forced deletion complete", verdict: "PASS" })
  assert.match(await call(lead, "btw_start", { question: "QA_BTW_SIDE_PAYLOAD" }), /QA_NATIVE_TEAM_TURN_DONE/)
  const sides = await call(lead, "btw_list", {})
  const sideID = sides.match(/ses_[A-Za-z0-9]+/)?.[0]
  assert.ok(sideID, "BTW list must return the public session ID")
  assert.match(await call(outsider, "btw_reply", { side_session_id: sideID, text: "QA_FOREIGN_SIDE_INPUT" }), /another session/)
  assert.match(await call(lead, "btw_reply", { side_session_id: sideID, text: "QA_BTW_REPLY_INPUT" }), /QA_NATIVE_TEAM_TURN_DONE/)
  const sideRequests = model.requests.filter((entry) => JSON.stringify(entry.input).includes("<omo-btw-side"))
  assert.ok(sideRequests.length > 0)
  for (const request of sideRequests) for (const tool of ["task", "workflow", "team_create", "monitor_start", "shell", "patch"]) {
    assert.ok(!request.tools.includes(tool), `BTW must not advertise ${tool}`)
  }
  results.push({ name: "BTW start reply caller ownership and read-only delegation guard work on the real host", verdict: "PASS" })
  const backgroundIDs = []
  for (const prompt of ["QA_BACKGROUND_ONE", "QA_BACKGROUND_TWO"]) {
    const output = await call(lead, "task", { category: "quick", prompt, run_in_background: true })
    const id = output.match(/task_[a-f0-9-]+/)?.[0]
    assert.ok(id)
    backgroundIDs.push(id)
  }
  for (const task_id of backgroundIDs) {
    assert.match(await call(lead, "background_output", { task_id }), /completed/)
  }
  const messages = (await api("GET", `/api/session/${lead}/message?limit=200&order=asc`)).body.data
  for (const taskID of backgroundIDs) {
    const delivered = messages.filter((entry) => entry.type === "synthetic" && entry.metadata?.omo_execution_run?.startsWith(taskID + "/"))
    assert.equal(delivered.length, 1, "each background completion must arrive once")
  }
  results.push({ name: "two background task completions deliver distinct durable root notifications", verdict: "PASS" })
  model.watch("QA_NESTED_RESULT_PAYLOAD")
  assert.match(await call(lead, "task", { category: "quick", prompt: "QA_PARENT_SPAWNS_BACKGROUND", description: "QA_NESTED_PARENT_SESSION" }), /QA_NESTED_PARENT_DONE/)
  await model.entered("QA_NESTED_RESULT_PAYLOAD")
  const parents = await api("GET", `/api/session?directory=${encodeURIComponent(fixture.project)}&search=QA_NESTED_PARENT_SESSION`)
  const nestedParent = parents.body.data.find((session) => session.title === "QA_NESTED_PARENT_SESSION")
  assert.ok(nestedParent)
  assert.equal((await api("POST", `/api/session/${nestedParent.id}/wait`)).status, 204)
  const nestedMessages = (await api("GET", `/api/session/${nestedParent.id}/message?limit=100&order=asc`)).body.data
  assert.equal(nestedMessages.filter((message) => message.type === "user" && message.metadata?.omo_execution_run).length, 1)
  results.push({ name: "background child completion resumes its managed parent through one admitted notification turn", verdict: "PASS" })
  assert.match(await call(lead, "monitor_start", { command: "not-allowed-qa-command" }), /denied/)
  const started = await call(lead, "monitor_start", { command: "bun -e 'console.log(424242); setInterval(() => {}, 1000)'", label: "QA watcher" })
  const monitor_id = started.match(/monitor_id: (\S+)/)?.[1]
  assert.ok(monitor_id)
  assert.match(await call(lead, "monitor_list", {}), /QA watcher/)
  assert.match(await call(lead, "monitor_output", { monitor_id }), /424242/)
  await call(lead, "monitor_stop", { monitor_id })
  results.push({ name: "monitor permission denial real watcher output and explicit stop work", verdict: "PASS" })
  const heldMembers = Array.from({ length: 5 }, (_, index) => `QA_HELD_MEMBER_${index}`)
  for (const marker of [...heldMembers, "QA_HELD_ORDINARY"]) model.hold(marker)
  const heldTeam = JSON.parse(await call(lead, "team_create", { name: "held-team", members: heldMembers.map((prompt, index) => ({
    name: `held-${index}`, kind: "category", category: "quick", prompt,
  })) }))
  const [queuedMarker] = await model.enteredCount(heldMembers, 4)
  const childRequests = () => model.requests.filter((entry) => entry.model === "gpt-quick")
  assert.ok(queuedMarker)
  assert.ok(!childRequests().some((entry) => JSON.stringify(entry.input).includes(queuedMarker)))
  const ordinary = await call(lead, "task", { category: "quick", prompt: "QA_HELD_ORDINARY", run_in_background: true })
  await model.entered("QA_HELD_ORDINARY")
  results.push({ name: "four active Team members leave the fifth model slot available to an ordinary task", verdict: "PASS" })
  assert.equal(JSON.parse(await call(lead, "team_delete", { teamRunId: heldTeam.teamRunId, force: true })).deleted, true)
  assert.ok(!childRequests().some((entry) => JSON.stringify(entry.input).includes(queuedMarker)))
  results.push({ name: "forced Team deletion drains held members and never starts its queued fifth member", verdict: "PASS" })
  model.release("QA_HELD_ORDINARY")
  const ordinaryID = ordinary.match(/task_[a-f0-9-]+/)?.[0]
  assert.ok(ordinaryID)
  assert.match(await call(lead, "background_output", { task_id: ordinaryID }), /completed/)
} catch (error) {
  results.push({ name: "native Team behavior", verdict: "FAIL", error: String(error) })
} finally {
  const cleanup = await Promise.allSettled([runner.cleanup(), model?.close()])
  if (fixture && existsSync(fixture.env.OMO_SPIKE_TRACE)) writeFileSync(join(evidence, "trace.ndjson"), readFileSync(fixture.env.OMO_SPIKE_TRACE))
  rmSync(sandbox, { recursive: true, force: true })
  const after = hostState()
  try {
    assert.deepEqual(after, before)
    assert.ok(cleanup.every((entry) => entry.status === "fulfilled"))
    assert.ok(runner.processes.every((entry) => entry.closed))
    assert.deepEqual(model?.errors ?? [], [])
    results.push({ name: "host state isolation and owned process cleanup", verdict: "PASS" })
  } catch (error) { results.push({ name: "isolation", verdict: "FAIL", error: String(error) }) }
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ results, before, after, processes: runner.processes,
    sandboxRemoved: !existsSync(sandbox), omitted: "No credentials or host configuration copied; loopback model only." }, null, 2))
}
console.log(JSON.stringify({ evidence, results }, null, 2))
process.exitCode = results.some((entry) => entry.verdict === "FAIL") ? 1 : 0
