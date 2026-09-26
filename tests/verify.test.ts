import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_COMMENT_PATTERN, detectCheckers, loadVerifyConfig, parseVerifyConfig } from "../src/verify/config"
import { filterDiagnostics, mutatedPaths, renderReport, scanComments, verify } from "../src/verify/run"
import { registerVerifyHook } from "../src/verify/hook"
import { parseOptions } from "../src/options"
import { Effect } from "effect"

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "iolaus-verify-"))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

test("mutated paths come from edit/write inputs and apply_patch headers", () => {
  expect(mutatedPaths({ filePath: "src/a.ts", oldString: "x", newString: "y" }, "/p")).toEqual(["/p/src/a.ts"])
  expect(mutatedPaths({ path: "/p/b.ts", content: "" }, "/p")).toEqual(["/p/b.ts"])
  const patch = "*** Begin Patch\n*** Update File: src/c.ts\n@@\n-a\n+b\n*** Add File: d.md\n+hi\n*** End Patch"
  expect(mutatedPaths({ patchText: patch }, "/p").sort()).toEqual(["/p/d.md", "/p/src/c.ts"])
  expect(mutatedPaths("nope", "/p")).toEqual([])
})

test("diagnostics are filtered to changed files across tsc and colon formats", () => {
  const out = [
    "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/other.ts(1,1): error TS1000: ignored",
    "src/a.ts:9:2 - error lint/x: unused",
    "Found 3 errors.",
  ].join("\n")
  const d = filterDiagnostics(out, "/p", ["/p/src/a.ts"])
  expect(d).toEqual([
    { path: "src/a.ts", line: 3, message: "error TS2322: Type 'string' is not assignable to type 'number'." },
    { path: "src/a.ts", line: 9, message: "error lint/x: unused" },
  ])
})

test("comment scan flags request-explaining comments only", () => {
  const dir = project({ "a.ts": "// added by AI as requested\nconst x = 1 // per user request\n// explains the algorithm\n// wait for the user to confirm\nlet y = 2 // changed as requested by the user\n" })
  const found = scanComments([join(dir, "a.ts")], dir, DEFAULT_COMMENT_PATTERN)
  expect(found.map((d) => d.line)).toEqual([1, 2, 5])
  expect(scanComments([join(dir, "a.ts")], dir, null)).toEqual([])
  rmSync(dir, { recursive: true, force: true })
})

test("config: detection, file, inline, disabled and validation", () => {
  const dir = project({ "tsconfig.json": "{}" })
  expect(detectCheckers(dir)[0]?.argv.slice(1)).toEqual(["--noEmit", "--pretty", "false"])
  expect(loadVerifyConfig(dir).source).toBe("detected")
  mkdirSync(join(dir, ".iolaus"))
  writeFileSync(join(dir, ".iolaus", "verify.json"), JSON.stringify({ checkers: [{ argv: ["bun", "run", "lint"] }], timeoutMs: 5000 }))
  const fromFile = loadVerifyConfig(dir)
  expect(fromFile.source).toBe("config")
  expect(fromFile.checkers[0]).toEqual({ name: "bun", argv: ["bun", "run", "lint"] })
  expect(fromFile.timeoutMs).toBe(5000)
  expect(loadVerifyConfig(dir, { checkers: [], commentPattern: null }).source).toBe("disabled")
  expect(() => parseVerifyConfig({ checkers: [{ argv: [] }] })).toThrow(/argv/)
  expect(() => parseVerifyConfig({ nope: 1 })).toThrow(/Unknown verify.json keys/)
  expect(() => parseVerifyConfig({ commentPattern: "(" })).toThrow()
  rmSync(dir, { recursive: true, force: true })
})

test("verify runs a real checker without a shell and reports only changed-file issues", async () => {
  const dir = project({ "src/a.ts": "let n: number = 'x'\n// changed as requested by the user\n", "src/b.ts": "let m: number = 'y'\n" })
  const checker = { name: "fake", argv: ["node", "-e", "console.log('src/a.ts(1,5): error TS2322: bad'); console.log('src/b.ts(1,5): error TS2322: also bad'); process.exit(2)"] }
  const report = await verify({ checkers: [checker], timeoutMs: 10_000, commentPattern: DEFAULT_COMMENT_PATTERN, source: "config" }, dir, [join(dir, "src/a.ts")])
  expect(report.paths).toEqual(["src/a.ts"])
  expect(report.checkers[0].ok).toBe(false)
  expect(report.checkers[0].diagnostics).toEqual([{ path: "src/a.ts", line: 1, message: "error TS2322: bad" }])
  expect(report.comments).toEqual([{ path: "src/a.ts", line: 2, message: expect.stringContaining("comment explains a request") }])
  const text = renderReport(report)
  expect(text).toContain("[iolaus verify] 2 issues")
  expect(text).toContain("fake: src/a.ts:1 error TS2322: bad")
  const missing = await verify({ checkers: [{ name: "gone", argv: ["definitely-not-a-binary-xyz"] }], timeoutMs: 5000, commentPattern: null, source: "config" }, dir, [join(dir, "src/a.ts")])
  expect(missing.checkers[0].error).toMatch(/ENOENT|not found/)
  expect(renderReport({ paths: [], checkers: [], comments: [] })).toBe("")
  rmSync(dir, { recursive: true, force: true })
})

test("hook appends the report to completed mutations only", async () => {
  const dir = project({ "src/a.ts": "// added by AI\n" })
  let handler: ((event: unknown) => Effect.Effect<void>) | undefined
  const traces: unknown[] = []
  await Effect.runPromise(Effect.scoped(registerVerifyHook({ tool: { hook: (_name: string, callback: unknown) => Effect.sync(() => { handler = callback as never; return { dispose: Effect.void } }) } } as never,
    { directory: async () => dir, trace: (event, data) => traces.push({ event, ...data }), inline: { checkers: [] } })))
  const event = { tool: "edit", status: "completed", sessionID: "ses_1", agent: "iolaus-sisyphus", input: { filePath: "src/a.ts" }, result: { output: "ok", content: "Edited." } }
  await Effect.runPromise(handler!(event))
  expect(event.result.content).toContain("[iolaus verify] 1 issue")
  expect(event.result.content).toContain("comment-check: src/a.ts:1")
  const read = { tool: "read", status: "completed", sessionID: "ses_1", agent: "x", input: { filePath: "src/a.ts" }, result: { content: "text" } }
  await Effect.runPromise(handler!(read))
  expect(read.result.content).toBe("text")
  const failed = { tool: "edit", status: "error", sessionID: "ses_1", agent: "x", input: { filePath: "src/a.ts" }, error: {} }
  await Effect.runPromise(handler!(failed))
  expect(traces.filter((t) => (t as { event: string }).event === "iolaus.verify.ran")).toHaveLength(1)
  rmSync(dir, { recursive: true, force: true })
})

test("verify option accepts boolean or object", () => {
  expect(parseOptions({}).verify).toBe(true)
  expect(parseOptions({ verify: false }).verify).toBe(false)
  expect(parseOptions({ verify: { checkers: [] } }).verify).toEqual({ checkers: [] })
  expect(() => parseOptions({ verify: "yes" })).toThrow(/verify must be/)
})

test("checkers are detected per stack from marker files; every command is read-only", () => {
  const dir = project({ "tsconfig.json": "{}", "biome.json": "{}", "pyproject.toml": "", "Cargo.toml": "", "go.mod": "module x" })
  const names = detectCheckers(dir).map((c) => c.name)
  expect(names).toEqual(["tsc", "biome", "ruff", "cargo", "go vet"])
  for (const c of detectCheckers(dir)) expect(c.argv.join(" ")).not.toMatch(/--fix|--write|--apply/)
  rmSync(dir, { recursive: true, force: true })
  const eslintDir = project({ "eslint.config.js": "" })
  expect(detectCheckers(eslintDir).map((c) => c.name)).toEqual(["eslint"])
  rmSync(eslintDir, { recursive: true, force: true })
  expect(detectCheckers(project({}))).toEqual([])
})

test("location parser accepts tsc, unix, go/cargo relative paths and biome's github reporter", () => {
  const out = [
    "src/a.ts(3,7): error TS2322: bad type",
    "./a.go:9:2: unreachable code",
    "src/main.rs:4:5: error: mismatched types",
    "::error title=lint/suspicious/noDebugger,file=src/a.ts,line=12,endLine=12,col=1,endColumn=9::This is an unexpected use of the debugger statement.",
    "::error title=lint/x,file=src/other.ts,line=1,col=1::ignored",
    "warning: 1 warning emitted",
  ].join("\n")
  const d = filterDiagnostics(out, "/p", ["/p/src/a.ts", "/p/a.go", "/p/src/main.rs"])
  expect(d).toEqual([
    { path: "src/a.ts", line: 3, message: "error TS2322: bad type" },
    { path: "a.go", line: 9, message: "unreachable code" },
    { path: "src/main.rs", line: 4, message: "error: mismatched types" },
    { path: "src/a.ts", line: 12, message: "lint/suspicious/noDebugger: This is an unexpected use of the debugger statement." },
  ])
})

test("json format parses flat arrays, wrapped arrays and eslint's per-file groups", async () => {
  const { filterJsonDiagnostics } = await import("../src/verify/run")
  expect(filterJsonDiagnostics(JSON.stringify([{ file: "src/a.ts", line: 2, message: "m1" }, { path: "src/b.ts", line: 1, message: "other" }]), "/p", ["/p/src/a.ts"]))
    .toEqual([{ path: "src/a.ts", line: 2, message: "m1" }])
  expect(filterJsonDiagnostics(JSON.stringify({ diagnostics: [{ filename: "src/a.ts", location: { row: 7 }, code: "F401" }] }), "/p", ["/p/src/a.ts"]))
    .toEqual([{ path: "src/a.ts", line: 7, message: "F401" }])
  expect(filterJsonDiagnostics(JSON.stringify([{ filePath: "/p/src/a.ts", messages: [{ line: 4, message: "no-unused-vars" }, { line: 9, ruleId: "eqeqeq" }] }]), "/p", ["/p/src/a.ts"]))
    .toEqual([{ path: "src/a.ts", line: 4, message: "no-unused-vars" }, { path: "src/a.ts", line: 9, message: "eqeqeq" }])
  expect(filterJsonDiagnostics("not json", "/p", ["/p/src/a.ts"])).toEqual([])
  expect(() => parseVerifyConfig({ checkers: [{ argv: ["x"], format: "yaml" }] })).toThrow(/format/)
  expect(parseVerifyConfig({ checkers: [{ argv: ["x"], format: "json" }] }).checkers[0].format).toBe("json")
  const dir = project({ "src/a.ts": "x" })
  const report = await verify({ checkers: [{ name: "j", argv: ["node", "-e", `console.log(JSON.stringify([{file:"src/a.ts",line:1,message:"from json"}]))`], format: "json" }], timeoutMs: 10_000, commentPattern: null, source: "config" }, dir, [join(dir, "src/a.ts")])
  expect(report.checkers[0].diagnostics).toEqual([{ path: "src/a.ts", line: 1, message: "from json" }])
  rmSync(dir, { recursive: true, force: true })
})
