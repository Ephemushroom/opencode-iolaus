import { mkdir, writeFile } from "node:fs/promises"

await mkdir("dist", { recursive: true })
const metadata = []
for (const [entry, output] of [["./src/index.ts", "index.js"], ["./src/prompts/index.ts", "prompts.js"]]) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: "dist",
    naming: output,
    target: "node",
    format: "esm",
    external: ["@opencode/plugin", "@opencode/plugin/*"],
    loader: { ".md": "text" },
    metafile: true,
  })
  if (!result.success) throw new AggregateError(result.logs, "Iolaus build failed")
  metadata.push(result.metafile)
}
await writeFile("dist/metafile.json", JSON.stringify(metadata, null, 2))
console.log("Built prompt-only Iolaus plugin and prompt library.")
