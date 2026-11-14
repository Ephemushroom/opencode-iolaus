import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_COMMENT_PATTERN, detectCheckers, loadVerifyConfig, parseVerifyConfig } from "../src/verify/config"
import { filterDiagnostics, mutatedPaths, renderReport, scanComments, verify } from "../src/verify/run"
import { registerVerifyHook } from "../src/verify/hook"
import { parseOptions } from "../src/options"
import { Effect, Fiber } from "effect"

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

test("diagnostics preserve spaces in relative and absolute paths", () => {
  const directory = "/project with spaces"
  expect(filterDiagnostics([
    "src/my file.ts(3,7): error TS2322: bad type",
    "/project with spaces/src/my file.ts:9:2: unused",
    "src/other file.ts(1,1): error TS1000: ignored",
  ].join("\n"), directory, [join(directory, "src/my file.ts")])).toEqual([
    { path: "src/my file.ts", line: 3, message: "error TS2322: bad type" },
    { path: "src/my file.ts", line: 9, message: "unused" },
  ])
})

test("config: detection, global section, disabled and validation", () => {
  const dir = project({ "tsconfig.json": "{}" })
  expect(detectCheckers(dir)[0]?.argv.slice(1)).toEqual(["--noEmit", "--pretty", "false"])
  expect(loadVerifyConfig(dir).source).toBe("detected")
  mkdirSync(join(dir, ".iolaus"))
  writeFileSync(join(dir, ".iolaus", "verify.json"), JSON.stringify({ checkers: [{ argv: ["old-check"] }] }))
  expect(loadVerifyConfig(dir).source).toBe("detected")
  const fromFile = loadVerifyConfig(dir, { checkers: [{ argv: ["bun", "run", "lint"] }], timeoutMs: 5000 })
  expect(fromFile.source).toBe("config")
  expect(fromFile.checkers[0]).toEqual({ name: "bun", argv: ["bun", "run", "lint"] })
  expect(fromFile.timeoutMs).toBe(5000)
  expect(loadVerifyConfig(dir, { checkers: [], commentPattern: null }).source).toBe("disabled")
  expect(() => parseVerifyConfig({ checkers: [{ argv: [] }] })).toThrow(/argv/)
  expect(() => parseVerifyConfig({ nope: 1 })).toThrow(/Unknown verify keys/)
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
    { directory: async () => dir, trace: (event, data) => traces.push({ event, ...data }), config: { checkers: [] } })))
  const event = { tool: "edit", status: "completed", sessionID: "ses_1", agent: "sisyphus", input: { filePath: "src/a.ts" }, result: { output: "ok", content: "Edited." } }
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

test("a checker that fails without locating a problem is reported, not passed", async () => {
  const dir = project({ "src/a.ts": "export const a = 1\n" })
  const run = (checker: { name: string; argv: string[]; format?: "json" }) =>
    verify({ checkers: [checker], timeoutMs: 10_000, commentPattern: null, source: "config" }, dir, [join(dir, "src/a.ts")]).then((report) => ({ checker: report.checkers[0], text: renderReport(report) }))
  const script = (body: string) => ["node", "-e", body]

  const broken = await run({ name: "tsc", argv: script(`console.log("error TS5083: Cannot read file 'tsconfig.json'."); process.exit(1)`) })
  expect(broken.checker).toMatchObject({ ok: false, diagnostics: [], error: "exit code 1: error TS5083: Cannot read file 'tsconfig.json'." })
  expect(broken.text).toContain("tsc: check failed (exit code 1: error TS5083: Cannot read file 'tsconfig.json'.)")

  // Problems it located in other files are the project's, not this edit's.
  const elsewhere = await run({ name: "tsc", argv: script(`console.log("src/b.ts(1,5): error TS2322: bad"); process.exit(2)`) })
  expect(elsewhere.checker).toMatchObject({ ok: true, diagnostics: [] })
  expect(elsewhere.checker.error).toBeUndefined()
  expect(elsewhere.text).toBe("")

  const garbled = await run({ name: "lint", format: "json", argv: script(`console.log("Oops, something went wrong")`) })
  expect(garbled.checker).toMatchObject({ ok: false, error: "output is not JSON: Oops, something went wrong" })
  const crashed = await run({ name: "lint", format: "json", argv: script(`console.error("config error"); process.exit(2)`) })
  expect(crashed.checker).toMatchObject({ ok: false, error: "exit code 2: config error" })
  const clean = await run({ name: "lint", format: "json", argv: script(`console.log("[]")`) })
  expect(clean.checker).toMatchObject({ ok: true, diagnostics: [] })
  expect((await run({ name: "lint", format: "json", argv: script("") })).checker.ok).toBe(true)
  rmSync(dir, { recursive: true, force: true })
})

test("JSON checker rejects malformed reports without throwing and keeps unrelated diagnostics clean", async () => {
  const dir = project({ "a.ts": "export {}\n" })
  try {
    const run = (output: string, code = 0) => verify({
      checkers: [{ name: "json", format: "json", argv: ["node", "-e", `process.stdout.write(${JSON.stringify(output)}); process.exit(${code})`] }],
      timeoutMs: 10_000, commentPattern: null, source: "config",
    }, dir, [join(dir, "a.ts")])
    for (const output of ["{broken", "null", "42", '"text"', "{}", '{"results":{}}', "[null]", '[{"filePath":"a.ts","messages":[null]}]', '[{"filePath":" ","messages":[]}]', '[{"file":"a.ts","message":{"toString":null}}]']) {
      const report = await run(output)
      expect(report.checkers[0].ok).toBe(false)
      expect(renderReport(report)).toContain("json: check failed")
    }
    const unrelated = await run('[{"filePath":"other file.ts","messages":[{"line":1,"message":"unrelated"}]}]', 1)
    expect(unrelated.checkers[0]).toMatchObject({ ok: true, diagnostics: [] })
    expect(renderReport(unrelated)).toBe("")
    expect((await run('{"results":[]}')).checkers[0].ok).toBe(true)
    expect((await run('[{"filePath":"a.ts","messages":[]}]')).checkers[0].ok).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("checker termination overrides numeric exits and partial unrelated diagnostics", async () => {
  const dir = project({ "a.ts": "export {}\n" })
  try {
    for (const body of [
      `process.on('SIGTERM', () => process.exit(2)); console.log('other.ts(1,1): error: unrelated'); setInterval(() => {}, 1000)`,
      `process.on('SIGTERM', () => process.exit(0)); console.log('other.ts(1,1): error: unrelated'); setInterval(() => {}, 1000)`,
      `console.log('other.ts(1,1): error: unrelated'); process.kill(process.pid, 'SIGTERM')`,
    ]) {
      const report = await verify({
        checkers: [{ name: "terminated", argv: ["node", "-e", body] }], timeoutMs: 250, commentPattern: null, source: "config",
      }, dir, [join(dir, "a.ts")])
      expect(report.checkers[0]).toMatchObject({ ok: false, diagnostics: [], error: expect.any(String) })
      expect(renderReport(report)).toContain("terminated: check failed")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("timeout kills a checker ignoring TERM within a bounded grace period", async () => {
  const dir = project({ "a.ts": "export {}\n" })
  const ready = join(dir, "ready")
  const stopped = join(dir, "stopped")
  try {
    const started = Date.now()
    const report = await verify({
      checkers: [{ name: "ignores-term", argv: ["node", "-e", `const fs = require('node:fs'); process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(stopped)}, 'TERM')); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => process.exit(0), 2500)`] }],
      timeoutMs: 250, commentPattern: null, source: "config",
    }, dir, [join(dir, "a.ts")])
    expect(Date.now() - started).toBeLessThan(1200)
    expect(existsSync(stopped)).toBe(true)
    expect(report.checkers[0]).toMatchObject({ ok: false, error: expect.any(String) })
    const pid = Number(readFileSync(ready, "utf8"))
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    if (existsSync(ready)) {
      try { process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL") } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test("abort kills a checker ignoring TERM without waiting for its normal timeout", async () => {
  const dir = project({ "a.ts": "export {}\n" })
  const ready = join(dir, "ready")
  const stopped = join(dir, "stopped")
  const controller = new AbortController()
  const reason = new Error("cancel checker")
  const result = verify({
    checkers: [{ name: "ignores-term", argv: ["node", "-e", `const fs = require('node:fs'); process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(stopped)}, 'TERM')); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => process.exit(0), 2500)`] }],
    timeoutMs: 10_000, commentPattern: null, source: "config",
  }, dir, [join(dir, "a.ts")], controller.signal).then(() => undefined, (error: unknown) => error)
  try {
    const deadline = Date.now() + 1000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10))
    expect(existsSync(ready)).toBe(true)
    const started = Date.now()
    controller.abort(reason)
    expect(await result).toBe(reason)
    expect(Date.now() - started).toBeLessThan(1200)
    expect(existsSync(stopped)).toBe(true)
    const pid = Number(readFileSync(ready, "utf8"))
    const stoppedDeadline = Date.now() + 500
    while (Date.now() < stoppedDeadline) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    controller.abort(reason)
    if (existsSync(ready)) {
      try { process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL") } catch {}
    }
    await result
    rmSync(dir, { recursive: true, force: true })
  }
})

test("timeout and abort finish even when an exited checker's descendant holds its pipes", async () => {
  for (const cancel of [false, true]) {
    const dir = project({ "a.ts": "export {}\n" })
    const ready = join(dir, "ready")
    const controller = new AbortController()
    const reason = new Error("cancel inherited pipes")
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => process.exit(0), 2500)`
    const started = Date.now()
    const result = verify({
      checkers: [{ name: "inherited-pipes", argv: ["node", "-e", `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'inherit', 'inherit']}); process.exit(0)`] }],
      timeoutMs: cancel ? 10_000 : 250, commentPattern: null, source: "config",
    }, dir, [join(dir, "a.ts")], controller.signal).then((report) => report, (error: unknown) => error)
    try {
      const deadline = Date.now() + 1000
      while (!existsSync(ready) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10))
      expect(existsSync(ready)).toBe(true)
      if (cancel) controller.abort(reason)
      const outcome = await result
      expect(Date.now() - started).toBeLessThan(1200)
      if (cancel) expect(outcome).toBe(reason)
      else expect(outcome).toMatchObject({ checkers: [{ ok: false, error: expect.any(String) }] })
    } finally {
      controller.abort(reason)
      if (existsSync(ready)) {
        try { process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL") } catch {}
      }
      await result
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("interrupting the registered hook stops its checker and suppresses late postprocessing", async () => {
  const dir = project({ "a.ts": "// added by AI\n" })
  let handler!: (event: unknown) => Effect.Effect<void>
  const traces: string[] = []
  const ready = join(dir, "ready")
  const stopped = join(dir, "stopped")
  const body = `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(2) }); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); console.log('other.ts(1,1): error: unrelated'); setInterval(() => {}, 1000)`
  await Effect.runPromise(Effect.scoped(registerVerifyHook({ tool: { hook: (_name: string, callback: unknown) => Effect.sync(() => { handler = callback as never; return { dispose: Effect.void } }) } } as never,
    { directory: async () => dir, trace: (event) => traces.push(event), config: { checkers: [{ name: "waiting", argv: ["node", "-e", body] }], timeoutMs: 10_000 } })))
  const event = { tool: "patch", status: "completed", sessionID: "ses_cancel", agent: "sisyphus", input: { path: "a.ts" }, result: { content: "Edited." } }
  const fiber = Effect.runFork(handler(event))
  const waitFor = async (path: string) => {
    const deadline = Date.now() + 1000
    while (!existsSync(path) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10))
    expect(existsSync(path)).toBe(true)
  }
  try {
    await waitFor(ready)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await waitFor(stopped)
    await new Promise((done) => setTimeout(done, 50))
    expect(event.result.content).toBe("Edited.")
    expect(traces).toEqual([])
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    if (existsSync(ready)) {
      try { process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL") } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an interrupted hook does not resume after directory lookup finishes", async () => {
  const dir = project({ "a.ts": "// added by AI\n" })
  let handler!: (event: unknown) => Effect.Effect<void>
  let finishDirectory!: (directory: string) => void
  let enteredDirectory!: () => void
  const entered = new Promise<void>((done) => { enteredDirectory = done })
  const directory = new Promise<string>((done) => { finishDirectory = done })
  const traces: string[] = []
  await Effect.runPromise(Effect.scoped(registerVerifyHook({ tool: { hook: (_name: string, callback: unknown) => Effect.sync(() => { handler = callback as never; return { dispose: Effect.void } }) } } as never,
    { directory: () => { enteredDirectory(); return directory }, trace: (event) => traces.push(event), config: { checkers: [] } })))
  const event = { tool: "write", status: "completed", sessionID: "ses_lookup", agent: "sisyphus", input: { path: "a.ts" }, result: { content: "Written." } }
  const fiber = Effect.runFork(handler(event))
  try {
    await entered
    await Effect.runPromise(Fiber.interrupt(fiber))
    finishDirectory(dir)
    await new Promise((done) => setTimeout(done, 20))
    expect(event.result.content).toBe("Written.")
    expect(traces).toEqual([])
  } finally {
    finishDirectory(dir)
    await Effect.runPromise(Fiber.interrupt(fiber))
    rmSync(dir, { recursive: true, force: true })
  }
})

test("verify refuses an already cancelled signal before accessing checker configuration", async () => {
  const controller = new AbortController()
  const reason = new Error("verification cancelled")
  controller.abort(reason)
  await expect(verify({
    get checkers(): never { throw new Error("checker configuration accessed after cancellation") },
    timeoutMs: 1000, commentPattern: "(", source: "config",
  }, "/p", [], controller.signal)).rejects.toBe(reason)
})
