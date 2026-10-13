import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(new URL("..", import.meta.url).pathname)
const evidence = resolve(process.argv[2])
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence/flow-steering-sdk/final-cleanup-")}`))
mkdirSync(evidence, { recursive: false })
const fixtures = mkdtempSync(join(tmpdir(), "iolaus-cleanup-probes-"))
const results = []
try {
  const sdk = JSON.parse(readFileSync(join(root, "package.json"))).peerDependencies["@opencode/plugin"]
  const mismatch = join(fixtures, "mismatch")
  writeFileSync(mismatch, "#!/bin/sh\nprintf 'opencode v0.0.0\\n'\n", { mode: 0o755 })
  const disappearing = join(fixtures, "disappearing")
  writeFileSync(disappearing, `#!/bin/sh\nrm "$0"\nprintf 'opencode v${sdk}\\n'\n`, { mode: 0o755 })
  const preload = join(fixtures, "partial.cjs")
  writeFileSync(preload, 'const fs = require("node:fs"); fs.cpSync = () => { throw new Error("QA_PARTIAL_COPY_FAILURE") }; require("node:module").syncBuiltinESMExports();\n')
  const cleanupPreload = join(fixtures, "cleanup.cjs")
  writeFileSync(cleanupPreload, 'const http = require("node:http"); const close = http.Server.prototype.close; http.Server.prototype.close = function(done) { return close.call(this, () => done(new Error("QA_MOCK_CLEANUP_FAILURE"))) };\n')
  for (const [name, binary, options, pattern, cleanupPattern] of [
    ["missing-binary", join(fixtures, "missing"), "", /ENOENT/],
    ["version-mismatch", mismatch, "", /opencode v0\.0\.0/],
    ["partial-acquisition", mismatch, `--require=${preload}`, /QA_PARTIAL_COPY_FAILURE/],
    ["spawn-failure", disappearing, "", /ENOENT/],
    ["cleanup-error", join(fixtures, "missing"), `--require=${cleanupPreload}`, /ENOENT/, /QA_MOCK_CLEANUP_FAILURE/],
  ]) {
    const path = join(evidence, name)
    const result = spawnSync(process.execPath, [join(root, "script/qa-flow-steering.mjs"), path], {
      env: { ...process.env, QA_OPENCODE_BIN: binary, NODE_OPTIONS: options }, encoding: "utf8", timeout: 15000,
    })
    writeFileSync(join(evidence, `${name}.log`), result.stdout + result.stderr)
    assert.equal(result.error, undefined, `${name}: ${result.error}`)
    assert.equal(result.status, 1, `${name}: ${result.stderr}`)
    const receipt = JSON.parse(readFileSync(join(path, "receipt.json")))
    assert.equal(receipt.verdict, "FAIL")
    assert.match(receipt.failure, pattern)
    assert.deepEqual(receipt.cleanup, { sandboxRemoved: true, processGone: true, mockClosed: true })
    if (cleanupPattern) assert.match(receipt.cleanupErrors.join("\n"), cleanupPattern)
    else assert.deepEqual(receipt.cleanupErrors, [])
    assert.deepEqual(receipt.isolation.before, receipt.isolation.after)
    assert.equal(existsSync(receipt.isolation.env.TMPDIR), false)
    results.push({ name, verdict: "PASS", failure: receipt.failure, cleanup: receipt.cleanup })
  }
} finally {
  rmSync(fixtures, { recursive: true, force: true })
  writeFileSync(join(evidence, "regressions.json"), JSON.stringify(results, null, 2))
}
console.log(JSON.stringify(results, null, 2))
