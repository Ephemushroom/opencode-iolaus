import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture, installFixture } from "./qa-api-upgrade/fixture.mjs"
import { createHostRunner, hostState } from "./qa-api-upgrade/host.mjs"
import { createModel } from "./qa-api-upgrade/model.mjs"
import { runScenarios } from "./qa-api-upgrade/scenarios.mjs"

assert.ok(process.argv[2] && !process.argv[2].startsWith("--"),
  "Usage: node packages/omo-opencode2/scripts/qa-api-upgrade.mjs NEW_EVIDENCE_DIR [--installer | --red]")
const flags = process.argv.slice(3)
assert.ok(flags.every((flag) => ["--red", "--installer"].includes(flag)), "unknown QA option")
const red = flags.includes("--red")
const installer = flags.includes("--installer")
assert.ok(!(red && installer), "RED loader fixtures must not be migrated by installer")
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const evidence = resolve(process.argv[2])
assert.ok(evidence.startsWith(`${join(repo, ".omo/evidence")}/`), "evidence must be inside this checkout's .omo/evidence")
mkdirSync(dirname(evidence), { recursive: true })
mkdirSync(evidence) // Exclusive creation: never overwrite historical RED or GREEN artifacts.
const binary = process.env.QA_OPENCODE_BIN ?? execFileSync("which", ["opencode2"], { encoding: "utf8" }).trim()
const runner = createHostRunner(binary, evidence)
const before = hostState()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "omo-oc2-api-")))
const results = []
const fixtures = []
let model
async function check(name, action) {
  try {
    await action()
    results.push({ name, verdict: "PASS" })
  } catch (error) {
    results.push({ name, verdict: "FAIL", error: String(error) })
  }
  writeFileSync(join(evidence, "assertions.json"), JSON.stringify(results, null, 2) + "\n")
}

try {
  model = await createModel(evidence)
  for (const mode of red ? ["old-file", "old-command"] : ["enabled", "disabled"]) {
    const fixture = createFixture({ sandbox, mode, repo, mockUrl: model.url, installer })
    fixtures.push({ mode, project: fixture.project,
      isolation: Object.fromEntries(Object.entries(fixture.env).filter(([key]) =>
        ["HOME", "USERPROFILE", "PWD", "OPENCODE_TEST_HOME", "OMO_SPIKE_TRACE"].includes(key) || key.startsWith("XDG_"))),
      configSource: installer ? "installer resolver/writer" : "direct source directory" })
    if (fixtures.length === 1) {
      for (const [name, args, success] of [
        ["version", ["--version"], true], ["help", ["run", "--help"], true],
        ["serve-help", ["serve", "--help"], true], ["bad-input", ["run", "--omo-invalid-option"], false],
      ]) await check(name, async () => assert.equal((await runner.run(name, args, fixture)).code === 0, success))
    }
    await check(`${mode}: suite`, async () => {
      if (installer) await installFixture(fixture, { runner, repo, evidence })
      writeFileSync(join(evidence, `${mode}-config.json`), readFileSync(fixture.configPath))
      if (!red) return runScenarios({ runner, fixture, model, evidence, check })
      model.select(mode)
      const result = await runner.run(mode, ["run", "--standalone", "--auto", "--print-logs", "--log-level", "debug",
        "--model", "openai/gpt-fake", "Say QA_API_OK."], fixture)
      writeFileSync(join(evidence, `${mode}.ndjson`), existsSync(fixture.env.OMO_SPIKE_TRACE)
        ? readFileSync(fixture.env.OMO_SPIKE_TRACE) : "")
      assert.equal(result.code, 0)
      assert.match(result.output, mode === "old-file" ? /configured plugin path must be a directory/ : /draft\.update is not a function/)
      const requests = model.requests.filter((request) => request.scenario === mode)
      assert.ok(requests.length > 0)
      assert.ok(requests.every((request) => !request.tools.includes("background_output")))
    })
    await check(`${mode}: original OMO configuration unchanged`, () => {
      for (const path of fixture.originalOmoPaths) assert.equal(readFileSync(path, "utf8"), fixture.originalOmoText)
      writeFileSync(join(evidence, `${mode}-omo-config.json`), readFileSync(fixture.omoConfigPath))
      writeFileSync(join(evidence, `${mode}-original-omo.json`), fixture.originalOmoText)
    })
  }
} catch (error) {
  results.push({ name: "driver", verdict: "FAIL", error: String(error) })
} finally {
  const cleanup = await Promise.allSettled([runner.cleanup(), model?.close()])
  rmSync(sandbox, { recursive: true, force: true })
  const after = hostState()
  await check("real host unchanged", () => assert.deepEqual(after, before))
  await check("cleanup completed", () => {
    assert.ok(cleanup.every((result) => result.status === "fulfilled"))
    assert.ok(runner.processes.every((process) => process.closed))
  })
  await check("mock protocol", () => assert.deepEqual(model?.errors ?? [], []))
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify({
    invocation: process.argv.slice(1), binary, red, installer, results, before, after, fixtures,
    processes: runner.processes, requestCount: model?.requests.length ?? 0, sandbox,
    sandboxRemoved: !existsSync(sandbox), mockClosed: model?.closed ?? true,
    cleanup: cleanup.map((result) => result.status === "fulfilled" ? "closed" : String(result.reason)),
    omitted: "No host credentials, authorization headers, or inherited environment dumps captured; local fake model only.",
  }, null, 2) + "\n")
}
const failures = results.filter((result) => result.verdict === "FAIL")
console.log(JSON.stringify({ evidence, assertions: results.length, failures }, null, 2))
process.exitCode = failures.length ? 1 : 0
