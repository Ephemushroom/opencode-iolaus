import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "./qa-api-upgrade/fixture.mjs"
import { createApi, createHostRunner, hostState } from "./qa-api-upgrade/host.mjs"
import { createHeldModel } from "./qa-execution/model.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
assert.ok(process.argv[2], "Usage: node scripts/qa-execution.mjs NEW_EVIDENCE_DIR")
const evidence = resolve(process.argv[2])
assert.ok(evidence.startsWith(join(repo, ".omo/evidence") + "/"))
mkdirSync(evidence)
const before = hostState()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "omo-native-execution-")))
const binary = process.env.QA_OPENCODE_BIN ?? execFileSync("which", ["opencode2"], { encoding: "utf8" }).trim()
const runner = createHostRunner(binary, evidence)
const results = []
const expectedVersion = JSON.parse(readFileSync(join(repo, "packages/omo-opencode2/package.json"), "utf8")).dependencies["@opencode/plugin"]
let version
let model
let fixture
let host
try {
  model = await createHeldModel(evidence)
  fixture = createFixture({ sandbox, mode: "enabled", repo, mockUrl: model.url })
  const config = JSON.parse(readFileSync(fixture.configPath, "utf8"))
  config.plugins = [join(repo, "packages/omo-opencode2/scripts/qa-execution/plugin")]
  writeFileSync(fixture.configPath, JSON.stringify(config))
  const versionRun = await runner.run("version", ["--version"], fixture)
  assert.equal(versionRun.code, 0)
  version = versionRun.output.match(/(?:opencode2? v)?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1]
  assert.equal(version, expectedVersion, "QA host must match the pinned SDK")
  host = await runner.serve("native-execution", fixture)
  const api = createApi(host, join(evidence, "api.ndjson"))
  const parent = await api("POST", "/api/session", { location: { directory: fixture.project }, title: "Executor QA" })
  assert.equal(parent.status, 200)
  async function command(input) {
    const response = await api("POST", `/api/session/${parent.body.data.id}/command`, { command: "qa-execution", text: JSON.stringify(input) })
    assert.equal(response.status, 204)
    return JSON.parse(readFileSync(fixture.env.OMO_SPIKE_TRACE, "utf8").trim().split("\n").at(-1)).result
  }
  const active = await command({ action: "submit", text: "EXECUTION_QA_ACTIVE", team: "team-one" })
  await model.entered("EXECUTION_QA_ACTIVE")
  results.push({ name: "background acceptance before held model completion", verdict: "PASS" })
  const blocked = await command({ action: "submit", text: "EXECUTION_QA_BLOCKED", team: "team-one" })
  const ordinary = await command({ action: "submit", text: "EXECUTION_QA_ORDINARY" })
  await model.entered("EXECUTION_QA_ORDINARY")
  assert.equal((await command({ action: "snapshot", ref: blocked.ref })).status, "queued")
  assert.equal(model.requests.length, 2)
  results.push({ name: "atomic Team/model admission without permit hoarding", verdict: "PASS" })
  await command({ action: "cancel", ref: blocked.ref })
  model.release("EXECUTION_QA_ACTIVE")
  model.release("EXECUTION_QA_ORDINARY")
  for (const record of [active, ordinary]) {
    const result = await command({ action: "wait", ref: record.ref })
    assert.equal(result.status, "completed")
    assert.match(result.output, /EXECUTION_QA_(ACTIVE|ORDINARY)_DONE/)
  }
  assert.equal((await command({ action: "wait", ref: blocked.ref })).status, "cancelled")
  assert.equal(model.requests.length, 2)
  results.push({ name: "queued cancellation launches nothing after capacity opens", verdict: "PASS" })
  const cancelled = await command({ action: "submit", text: "EXECUTION_QA_CANCEL" })
  await model.entered("EXECUTION_QA_CANCEL")
  await command({ action: "cancel", ref: cancelled.ref })
  assert.equal((await command({ action: "wait", ref: cancelled.ref })).status, "cancelled")
  results.push({ name: "active cancellation settles host before terminal result", verdict: "PASS" })
} catch (error) {
  results.push({ name: "native executor scenarios", verdict: "FAIL", error: String(error) })
} finally {
  const cleanup = await Promise.allSettled([runner.cleanup(), model?.close()])
  if (fixture && existsSync(fixture.env.OMO_SPIKE_TRACE)) writeFileSync(join(evidence, "trace.ndjson"), readFileSync(fixture.env.OMO_SPIKE_TRACE))
  rmSync(sandbox, { recursive: true, force: true })
  const after = hostState()
  try {
    assert.deepEqual(after, before)
    assert.ok(cleanup.every((result) => result.status === "fulfilled"))
    assert.ok(runner.processes.every((process) => process.closed))
    assert.deepEqual(model?.errors ?? [], [])
    results.push({ name: "host isolation and owned process cleanup", verdict: "PASS" })
  } catch (error) { results.push({ name: "cleanup", verdict: "FAIL", error: String(error) }) }
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ version, expectedVersion, surface: "dedicated executor fixture; not production plugin parity", results, before, after, processes: runner.processes,
    sandboxRemoved: !existsSync(sandbox), mockClosed: model?.closed, invocation: process.argv.slice(1),
    isolation: fixture && Object.fromEntries(Object.entries(fixture.env).filter(([key]) =>
      ["HOME", "USERPROFILE", "PWD", "OPENCODE_TEST_HOME"].includes(key) || key.startsWith("XDG_"))),
    omitted: "No inherited credentials, raw host configuration or authorization headers recorded.",
  }, null, 2) + "\n")
}
console.log(JSON.stringify({ evidence, results }, null, 2))
process.exitCode = results.some((result) => result.verdict === "FAIL") ? 1 : 0
