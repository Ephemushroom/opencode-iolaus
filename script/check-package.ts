import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const manifest = JSON.parse(readFileSync(join(root, "reference/active-manifest.json"), "utf8")) as {
  files: Array<{ path: string; sourceSha256: string; activeSha256: string }>
}
for (const entry of manifest.files) {
  const hash = createHash("sha256").update(readFileSync(join(root, entry.path))).digest("hex")
  if (hash !== entry.activeSha256) throw new Error(`Active source changed without lineage update: ${entry.path}`)
}

const forbidden = ["reference/", "omo-opencode2", "task-tools"]
const distFiles = existsSync(join(root, "dist")) ? readdirSync(join(root, "dist"), { recursive: true }) : []
for (const file of distFiles) {
  if (typeof file !== "string" || !file.endsWith(".js")) continue
  const text = readFileSync(join(root, "dist", file), "utf8")
  for (const token of forbidden) if (text.includes(token)) throw new Error(`Forbidden reference token in dist/${file}: ${token}`)
}
if (existsSync(join(root, "dist/metafile.json"))) {
  const metafile = readFileSync(join(root, "dist/metafile.json"), "utf8")
  if (metafile.includes("reference/")) throw new Error("Reference source entered the build graph")
}

const packageFiles = ["dist/index.js", "dist/prompts.js", "README.md", "LICENSE.md", "NOTICE.md"]
for (const file of packageFiles) if (!existsSync(join(root, file))) throw new Error(`Missing package file: ${file}`)
console.log(JSON.stringify({ activeFiles: manifest.files.length, packageFiles, verdict: "PASS" }, null, 2))
