import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const evidence = resolve(process.argv[2] ?? join(root, ".iolaus/evidence/flow-owner-rescue/cleanup"))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence")}/`))
mkdirSync(evidence, { recursive: true })
assert.ok(!existsSync(join(evidence, "regressions.json")), "use a fresh evidence directory")
const fixtures = mkdtempSync(join(tmpdir(), "iolaus-owner-rescue-cleanup-"))
const results = []
try {
  const mismatch = join(fixtures, "mismatch")
  writeFileSync(mismatch, "#!/bin/sh\nprintf 'opencode v0.0.0\\n'\n", { mode: 0o755 })
  const disappearing = join(fixtures, "disappearing")
  writeFileSync(disappearing, "#!/bin/sh\nrm \"$0\"\nprintf 'opencode v2.0.27\\n'\n", { mode: 0o755 })
  const preload = join(fixtures, "partial.cjs")
  writeFileSync(preload, 'const fs = require("node:fs"); fs.symlinkSync = () => { throw new Error("QA_PARTIAL_ACQUISITION_FAILURE") }; require("node:module").syncBuiltinESMExports();\n')
  for (const [name, binary, options, pattern] of [
    ["missing-binary", join(fixtures, "missing"), "", /ENOENT/],
    ["version-mismatch", mismatch, "", /opencode v0\.0\.0/],
    ["partial-acquisition", mismatch, `--require=${preload}`, /QA_PARTIAL_ACQUISITION_FAILURE/],
    ["spawn-failure", disappearing, "", /ENOENT/],
  ]) {
    const path = join(evidence, name)
    const result = spawnSync(process.execPath, [join(root, "script/qa-owner-rescue.mjs"), path], {
      env: { ...process.env, QA_OPENCODE_BIN: binary, NODE_OPTIONS: options }, encoding: "utf8", timeout: 15000,
    })
    writeFileSync(join(evidence, `${name}.log`), result.stdout + result.stderr)
    assert.equal(result.error, undefined, `${name}: ${result.error}`)
    assert.equal(result.status, 1)
    const receipt = JSON.parse(readFileSync(join(path, "receipt.json")))
    assert.equal(receipt.verdict, "FAIL"); assert.match(receipt.failure, pattern)
    assert.deepEqual(receipt.cleanup, { sandboxRemoved: true, processGone: true, mockClosed: true })
    assert.deepEqual(receipt.cleanupErrors, [])
    assert.deepEqual(receipt.isolation.before, receipt.isolation.after)
    assert.equal(existsSync(receipt.isolation.env.TMPDIR), false)
    results.push({ name, verdict: "PASS", cleanup: receipt.cleanup })
  }
} finally {
  rmSync(fixtures, { recursive: true, force: true })
  writeFileSync(join(evidence, "regressions.json"), JSON.stringify(results, null, 2))
}
console.log(JSON.stringify(results, null, 2))
