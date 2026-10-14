import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const evidence = resolve(process.argv[2] ?? join(root, ".iolaus/evidence/owner-rescue/verification-final"))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence/owner-rescue")}/`))
assert.ok(!existsSync(evidence), "use a fresh verification directory")
mkdirSync(evidence, { recursive: true })
const commands = []
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
let temporary, failure, stock
async function run(name, argv, extra = {}, expected = 0) {
  const started = Date.now(), env = { ...process.env, ...extra }
  const child = spawn(argv[0], argv.slice(1), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", (value) => { output += value }); child.stderr.on("data", (value) => { output += value })
  const exit = await new Promise((done, reject) => { child.once("close", done); child.once("error", reject) })
  writeFileSync(join(evidence, `${name}.log`), output)
  commands.push({ name, argv, controls: extra, exit, expected, durationMs: Date.now() - started })
  writeFileSync(join(evidence, "commands.json"), JSON.stringify(commands, null, 2))
  assert.equal(exit, expected, `${name}: ${output.slice(-3000)}`)
  return output
}
async function parallel(tasks) {
  const outcomes = await Promise.allSettled(tasks)
  const failures = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason)
  if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"))
}
try {
  assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64")
  const tempRoot = existsSync(join(tmpdir(), "opencode")) ? join(tmpdir(), "opencode") : tmpdir()
  temporary = mkdtempSync(join(tempRoot, "rescue-verification-"))
  const archive = join(temporary, "stock.zip")
  const url = "https://opencode.ai/files/bin/2.0.27/opencode-darwin-arm64.zip"
  if (process.env.QA_STOCK_ARCHIVE) writeFileSync(archive, readFileSync(process.env.QA_STOCK_ARCHIVE))
  else await run("download-stock", ["curl", "--fail", "--location", url, "--output", archive])
  assert.equal(hash(archive), "391b1061dc3f1f4394b7fd19513b2e6ff12f31739ee12f33880506ed6ee008bc")
  execFileSync("unzip", ["-q", archive, "-d", temporary])
  const binary = join(temporary, "opencode")
  assert.equal(hash(binary), "7fa5c8659e57cae76b1da4f45edbc583aef93aae917246a0b3abb1ac1b3fb93c")
  stock = { url, archiveHash: hash(archive), binaryHash: hash(binary) }
  writeFileSync(join(evidence, "stock-source.json"), JSON.stringify(stock, null, 2))
  for (const script of ["qa-owner-rescue-feature.mjs", "qa-owner-rescue-verify.mjs", "qa-owner-rescue.mjs", "qa-owner-rescue-cleanup.mjs", "qa-flow-steering.mjs"]) await run(`syntax-${script}`, ["node", "--check", `script/${script}`])
  await parallel([
    run("bun-tests", ["bun", "test"]), run("typecheck", ["bun", "run", "typecheck"]),
    run("package", ["bun", "run", "check:package"]), run("reference", ["bun", "run", "check:reference"]),
  ])
  const binaryEnv = { QA_OPENCODE_BIN: binary }
  await parallel([
    run("feature", ["node", "script/qa-owner-rescue-feature.mjs", join(evidence, "feature")], { QA_HOST_MODE: "patched" }),
    run("stock-off", ["node", "script/qa-owner-rescue-feature.mjs", join(evidence, "stock-off")], { ...binaryEnv, QA_HOST_MODE: "stock-off" }),
    run("stock-on", ["node", "script/qa-owner-rescue-feature.mjs", join(evidence, "stock-on")], { ...binaryEnv, QA_HOST_MODE: "stock-on" }, 2),
    run("steering", ["node", "script/qa-flow-steering.mjs", join(evidence, "steering")], binaryEnv),
    run("historical-blocked-probe", ["node", "script/qa-owner-rescue.mjs", join(evidence, "historical-blocked-probe")], binaryEnv, 2),
    run("historical-cleanup", ["node", "script/qa-owner-rescue-cleanup.mjs", join(evidence, "historical-cleanup")]),
  ])
  for (const fault of ["partial-setup", "spawn"]) {
    const directory = join(evidence, fault)
    await run(fault, ["node", "script/qa-owner-rescue-feature.mjs", directory], { QA_FAULT: fault, QA_HOST_MODE: "patched" }, 1)
    const receipt = JSON.parse(readFileSync(join(directory, "receipt.json")))
    assert.equal(receipt.verdict, "FAIL"); assert.match(receipt.failure, fault === "spawn" ? /ENOENT/ : /QA_PARTIAL_SETUP/)
    assert.deepEqual(receipt.cleanupErrors, [])
    assert.deepEqual(receipt.cleanup, { sandboxRemoved: true, processGone: true, mockClosed: true, sockets: 0 })
    assert.deepEqual(receipt.isolation.before, receipt.isolation.after)
  }
  const steering = JSON.parse(readFileSync(join(evidence, "steering/receipt.json")))
  assert.equal(steering.checks.length, 35); assert.equal(steering.verdict, "PASS")
  assert.equal(JSON.parse(readFileSync(join(evidence, "historical-blocked-probe/receipt.json"))).verdict, "BLOCKED")
  assert.equal(JSON.parse(readFileSync(join(evidence, "stock-on/receipt.json"))).verdict, "UNSUPPORTED")
  await run("diff-check", ["git", "diff", "--check"])
} catch (error) { failure = String(error.stack ?? error) }
finally { if (temporary) rmSync(temporary, { recursive: true, force: true }) }
const receipt = { verdict: failure ? "FAIL" : "PASS", failure, stock, commands, temporaryRemoved: !temporary || !existsSync(temporary) }
writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ verdict: receipt.verdict, commands: commands.length, failure, temporaryRemoved: receipt.temporaryRemoved }, null, 2))
process.exitCode = failure ? 1 : 0
