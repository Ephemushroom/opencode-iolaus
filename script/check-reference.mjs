import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(join(root, "reference/manifest.json"), "utf8"))
const expected = new Set()
for (const entry of manifest.files) {
  assert.ok(entry.path.startsWith("reference/omo/") && !entry.path.split("/").includes(".."))
  assert.ok(!expected.has(entry.path), `Duplicate reference: ${entry.path}`)
  expected.add(entry.path)
  const actual = createHash("sha256").update(readFileSync(join(root, entry.path))).digest("hex")
  assert.equal(actual, entry.sha256, `Reference changed: ${entry.source}`)
}
function walk(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    assert.ok(!entry.isSymbolicLink(), `Reference must not follow symlinks: ${path}`)
    return entry.isDirectory() ? walk(path) : [path]
  })
}
assert.deepEqual(new Set(walk("reference/omo")), expected)
assert.ok(![...expected].some((path) => path.endsWith("/AGENTS.md")))
console.log(JSON.stringify({ sourceCommit: manifest.commit, verifiedFiles: expected.size, verdict: "PASS" }, null, 2))
