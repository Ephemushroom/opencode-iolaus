import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"
import { once } from "node:events"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const packageRoot = resolve(process.env.IOLAUS_QA_PACKAGE_ROOT ?? root)
const evidence = resolve(process.argv[2] ?? join(root, `.iolaus/evidence/tui-responsive-${Date.now()}`))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence")}/`))
mkdirSync(join(root, ".iolaus/evidence"), { recursive: true })
mkdirSync(evidence)
const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const mode = process.env.IOLAUS_QA_THEME ?? "light"
assert.ok(mode === "light" || mode === "dark")
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-responsive-qa-")))
const home = join(sandbox, "home"), config = join(sandbox, "config"), project = join(sandbox, "project")
const localPackage = join(sandbox, "iolaus-package")
const tracePath = join(evidence, "trace.ndjson")
const session = `iolaus-responsive-${process.pid}`, target = `${session}:0.0`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const digest = async (path) => {
  if (!existsSync(path)) return "absent"
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
// Other host sessions keep writing the real database, so its digest is only recorded: the config must not change, and
// isolation from the database is proven by the sandbox TUI's own open files (sandboxDatabases).
const hostPaths = [".config/opencode/opencode.json", ".config/opencode/opencode.jsonc", ".config/opencode/cli.json"]
const hostDatabase = join(homedir(), ".local/share/opencode/opencode.db")
const hostState = async () => Object.fromEntries(await Promise.all(hostPaths.map(async (path) => [path, await digest(join(homedir(), path))])))
const realBefore = await hostState(), databaseBefore = await digest(hostDatabase)
const requests = [], screens = [], checks = []
const longResult = ["RESULT_START", "", "## RESULT_HEADING", "", "- **RESULT_BOLD** item", "- `RESULT_CODE` inline", "", ...Array.from({ length: 60 }, (_, i) => `RESULT_LINE_${String(i + 1).padStart(2, "0")}`), "RESULT_END"].join("\n")
const definition = {
  schemaVersion: 1,
  name: "Responsive seven parallel cards whose long flow name must truncate",
  nodes: Array.from({ length: 7 }, (_, i) => ({
    id: `p${i + 1}`, kind: "judge", agent: "momus", title: i === 6 ? "CARD_LAST_VISIBLE" : `Parallel card ${i + 1}`,
    prompt: `RESPONSIVE_FIXTURE_NODE_${i + 1}`, model: "openai/gpt-5.5", dependsOn: [],
  })),
}
// One card fans out to three judges and back in, for the fork/join connectors and the ↑/↓ markers.
const forkNode = (id, title, part, dependsOn) => ({ id, kind: "judge", agent: "momus", title, prompt: `FORK_FIXTURE_NODE_${part}`, model: "openai/gpt-5.5", dependsOn })
const fork = {
  schemaVersion: 1,
  name: "Fork join",
  nodes: [
    forkNode("split", "Split the work", "split", []),
    ...["a", "b", "c"].map((part) => forkNode(`part-${part}`, `Part ${part}`, part, ["split"])),
    forkNode("join", "Join the parts", "join", ["part-a", "part-b", "part-c"]),
  ],
}
const DIALOG = /Flow · Responsive seven/
writeFileSync(join(evidence, "fixture.json"), JSON.stringify({ definition, fork, longResult }, null, 2))
function events(text, call) {
  const id = `resp_${requests.length}`, item = `item_${requests.length}`
  const output = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } }]
  if (call) {
    const args = JSON.stringify(call.args)
    output.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: item, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: args, status: "completed" } })
  } else {
    output.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: item } },
      { type: "response.output_text.delta", item_id: item, output_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: item } })
  }
  output.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  return output
}
const mock = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const tools = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name)
    const input = body.input ?? []
    const messages = input.filter((item) => item?.type === "message").map((item) => JSON.stringify(item)).join("\n")
    const node = messages.match(/RESPONSIVE_FIXTURE_NODE_(\d)/)?.[1]
    const part = messages.match(/FORK_FIXTURE_NODE_([a-z]+)/)?.[1]
    requests.push({ node: node ?? (part ? `fork-${part}` : "owner"), tools })
    let text = "RESPONSIVE_QA_READY", call
    if (node) text = node === "1" ? longResult : `SHORT_RESULT_${node}`
    else if (part) text = `FORK_RESULT_${part}`
    else if (tools.includes("iolaus_dag")) {
      // Each user turn creates its own flow: only this turn's tool results say whether it already exists.
      const lastUser = input.findLastIndex((item) => item?.type === "message" && item.role === "user")
      const turn = lastUser >= 0 ? input.slice(lastUser) : input
      const forkTurn = JSON.stringify(input[lastUser] ?? "").includes("FORK_JOIN_QA")
      const prior = turn.filter((item) => item?.type === "function_call_output").at(-1)?.output
      let result
      if (typeof prior === "string") {
        try { result = JSON.parse(prior); if (result?.run && result?.events) result = result.run }
        catch (error) { throw new Error(`Mock received invalid tool result: ${String(error)}`) }
      }
      if (!result) call = { name: "iolaus_dag", args: { action: "create", definition: forkTurn ? fork : definition } }
      else if (result.status === "running" || result.status === "paused") {
        await sleep(500)
        call = { name: "iolaus_dag", args: { action: "snapshot", run_id: result.runID } }
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    for (const event of events(text, call)) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) { res.writeHead(500).end(String(error)) }
})
const env = {
  PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? tmpdir(), TERM: "xterm-256color", LANG: "en_US.UTF-8",
  HOME: home, USERPROFILE: home, PWD: project, XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: join(sandbox, "data"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
  OPENCODE_TEST_HOME: home, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  IOLAUS_TRACE: tracePath, IOLAUS_HOME: join(home, ".iolaus"),
  OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [localPackage] }),
}
const tmux = (...args) => spawnSync("tmux", ["-L", session, ...args], { env, encoding: "utf8" })
const checkedTmux = (...args) => { const result = tmux(...args); assert.equal(result.status, 0, result.stderr); return result.stdout }
const keys = (...args) => checkedTmux("send-keys", "-t", target, ...args)
const pane = () => checkedTmux("capture-pane", "-p", "-t", target)
const capture = (name) => {
  const text = pane()
  writeFileSync(join(evidence, `${name}.txt`), text)
  writeFileSync(join(evidence, `${name}.ansi`), checkedTmux("capture-pane", "-p", "-e", "-t", target))
  screens.push(name)
  return text
}
const waitFor = async (predicate, label, timeout = 30000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (predicate()) return; await sleep(250) }
  throw new Error(`Timed out: ${label}`)
}
const trace = () => existsSync(tracePath) ? readFileSync(tracePath, "utf8") : ""
const resize = async (width, height) => { checkedTmux("resize-window", "-t", session, "-x", String(width), "-y", String(height)); await sleep(900) }
const selectLast = async () => { for (let i = 0; i < 6; i++) { keys("j"); await sleep(100) } await sleep(500) }
const selectFirst = async () => { for (let i = 0; i < 6; i++) { keys("k"); await sleep(100) } await sleep(500) }
// The cell `offset` columns into the first `label` of an ANSI capture: its RGB foreground and whether it is bold.
function cellStyle(ansi, label, offset = 0) {
  for (const raw of ansi.split("\n")) {
    let fg = "default", bold = false, text = ""
    const cells = []
    for (const part of raw.split(/(\x1b\[[0-9;:]*m)/)) {
      if (part.startsWith("\x1b[")) {
        const codes = part.slice(2, -1).split(/[;:]/).map(Number)
        for (let i = 0; i < codes.length; i++) {
          if (codes[i] === 0) { fg = "default"; bold = false }
          else if (codes[i] === 1) bold = true
          else if (codes[i] === 22) bold = false
          else if (codes[i] === 39) fg = "default"
          else if (codes[i] === 38 && codes[i + 1] === 2) { fg = codes.slice(i + 2, i + 5).join(","); i += 4 }
          else if (codes[i] === 48 && codes[i + 1] === 2) i += 4
        }
      } else for (const char of part) { text += char; cells.push({ fg, bold }) }
    }
    const at = text.indexOf(label)
    if (at >= 0) return cells[[...text.slice(0, at)].length + offset]
  }
  throw new Error(`${label} is not on the screen`)
}
// Columns of `chars` on a captured line, and the centre column of each card whose corners are `left` and `right`.
const columns = (line, chars) => [...line].flatMap((char, i) => chars.includes(char) ? [i] : [])
function cardCentres(line, left, right) {
  const chars = [...line]
  return columns(line, left).map((start) => start + Math.floor((chars.indexOf(right, start) - start) / 2))
}
function selectedCard(screen, id) {
  assert.match(screen, new RegExp(`┃ › ${id}\\b`), `selected ${id} card must be in the graph viewport`)
}
const processTable = () => execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n").map((line) => {
  const [, pid, ppid, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) ?? []
  return { pid: Number(pid), ppid: Number(ppid), command }
})
let failure, panePID, tracked = [], forcedCleanup = []
const databases = { atStart: [], atEnd: [] }
const sandboxDatabase = join(sandbox, "data", "opencode", "opencode.db")
/** Every database file the sandbox TUI's process tree has open. */
const sandboxDatabases = () => {
  const table = processTable(), pids = new Set([panePID])
  for (let changed = true; changed;) {
    changed = false
    for (const row of table) if (pids.has(row.ppid) && !pids.has(row.pid)) { pids.add(row.pid); changed = true }
  }
  // A child that exits between ps and lsof makes lsof exit 1; the files of the others are still listed.
  const files = spawnSync("lsof", ["-Fn", "-p", [...pids].join(",")], { encoding: "utf8" }).stdout ?? ""
  return [...new Set(files.split("\n").filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line)).map((line) => line.slice(1)))].sort()
}
try {
  for (const path of [project, localPackage, join(home, ".iolaus"), join(config, "opencode/plugins/iolaus")]) mkdirSync(path, { recursive: true })
  symlinkSync(join(packageRoot, "dist"), join(localPackage, "dist"), "dir")
  writeFileSync(join(localPackage, "package.json"), JSON.stringify({ name: "opencode-iolaus", type: "module", main: "./dist/index.js", exports: { ".": "./dist/index.js", "./tui": "./dist/tui.js" } }))
  mock.listen(0, "127.0.0.1"); await once(mock, "listening")
  writeFileSync(join(home, ".iolaus", "iolaus.json"), JSON.stringify({ enabled: true, mcps: [], gh: false, astGrep: false, verify: false, models: { agents: { momus: "openai/gpt-5.5" } } }))
  writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
    plugins: [{ package: join(packageRoot, "dist") }],
    model: "openai/gpt-5.5", permissions: [{ action: "*", resource: "*", effect: "allow" }],
    provider: { openai: { options: { apiKey: "fake-key", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } } } } },
  }))
  writeFileSync(join(config, "opencode/cli.json"), JSON.stringify({ plugins: [localPackage], theme: { name: "opencode", mode } }))
  writeFileSync(join(config, "opencode/plugins/iolaus/package.json"), JSON.stringify({ type: "module", exports: { "./tui": "./tui.ts" } }))
  writeFileSync(join(config, "opencode/plugins/iolaus/tui.ts"), `export { default } from ${JSON.stringify(join(packageRoot, "dist/tui.js"))}\n`)
  checkedTmux("new-session", "-d", "-s", session, "-c", project, `${JSON.stringify(binary)} --standalone`)
  panePID = Number(checkedTmux("display-message", "-p", "-t", target, "#{pane_pid}").trim())
  checkedTmux("pipe-pane", "-t", target, "-o", `cat >> ${JSON.stringify(join(evidence, "tmux.log"))}`)
  await resize(160, 45)
  await waitFor(() => /iolaus\.tui\.loaded/.test(trace()), "TUI plugin load")
  await sleep(1500)
  databases.atStart = sandboxDatabases()
  assert.ok(databases.atStart.includes(sandboxDatabase), `the sandbox TUI must open its own database: ${databases.atStart}`)
  assert.ok(databases.atStart.every((path) => path.startsWith(`${sandbox}/`)), `the sandbox TUI opened a database outside the sandbox: ${databases.atStart}`)
  capture("01-idle")
  keys("Create the responsive seven parallel QA DAG", "Enter")
  await waitFor(() => /iolaus\.dag\.run\.completed/.test(trace()), "seven-node completion", 60000)
  await sleep(1200)
  capture("02-completed-sidebar")
  keys("C-x"); await sleep(150); keys("d"); await sleep(700)
  assert.match(pane(), DIALOG)
  await selectLast()
  await waitFor(() => pane().includes("SHORT_RESULT_7"), "the selected judge's reply rendered")
  const wide = capture("03-wide-short-details-last-selected")
  selectedCard(wide, "p7")
  assert.match(wide, /CARD_LAST_VISIBLE.*┃/, "the selected card's bottom content must be visible")
  assert.match(wide, /7 in parallel/, "short details must reclaim enough graph height to show the whole parallel wave")
  assert.match(wide, /[│┃] +p1\b/, "reclaimed graph must also retain its first row")
  assert.match(wide, /SHORT_RESULT_7/, "short details must fit alongside the expanded graph")
  assert.match(wide, /Flow · Responsive seven parallel cards whose long flow name must truncate +esc close/, "a wide dialog shows the whole flow name and the esc close hint")
  // As in the host's own key hints, the key takes the text colour and its action is muted.
  const wideAnsi = readFileSync(join(evidence, "03-wide-short-details-last-selected.ansi"), "utf8")
  const hint = { name: cellStyle(wideAnsi, "Responsive seven"), label: cellStyle(wideAnsi, "Flow · Responsive"), key: cellStyle(wideAnsi, "esc close"), action: cellStyle(wideAnsi, "esc close", 4) }
  writeFileSync(join(evidence, "esc-close-styles.json"), JSON.stringify(hint, null, 2))
  assert.equal(hint.key.fg, hint.name.fg, `the esc key must take the text colour: ${JSON.stringify(hint)}`)
  assert.ok(!hint.key.bold, `the esc key must not be bold: ${JSON.stringify(hint)}`)
  assert.equal(hint.action.fg, hint.label.fg, `the close action must be muted like the Flow label: ${JSON.stringify(hint)}`)
  assert.notEqual(hint.action.fg, hint.key.fg, `the close action must differ from its key: ${JSON.stringify(hint)}`)
  checks.push("esc close: the key in the text colour, the action muted")
  checks.push("wide: all seven cards and short result visible")

  for (const [width, height, label] of [[100, 45, "narrow"], [80, 30, "narrow-short"], [160, 24, "wide-short"], [160, 45, "restored"]]) {
    await resize(width, height)
    const screen = capture(`04-resize-${label}`)
    selectedCard(screen, "p7")
    assert.match(screen, /Node details/, `${label} must retain the details pane`)
    assert.match(screen, /Flow · Responsive seven.*esc close/, `${label} must retain the dialog header and its esc close hint`)
    assert.match(screen, /Esc close/, `${label} must retain a visible close hint`)
    if (width === 80) assert.match(screen, /Flow · Responsive seven[^\n]*\.\.\.[^\n]*esc close/, "a long flow name truncates before the close hint")
    checks.push(`${width}x${height}: selected last card survives resize`)
  }

  await selectFirst()
  // Highlighting runs in the background: wait for the Markdown markers to be concealed, not for the first paint.
  await waitFor(() => { const screen = pane(); return screen.includes("RESULT_HEADING") && !screen.includes("## RESULT_HEADING") }, "the long reply rendered as Markdown")
  const longTop = capture("05-long-result-top")
  selectedCard(longTop, "p1")
  assert.match(longTop, /RESULT_START/, "long result must begin in the initial detail viewport")
  // Agent and judge replies are Markdown: markers are concealed and the theme's Markdown styles apply.
  assert.match(longTop, /RESULT_HEADING/)
  assert.doesNotMatch(longTop, /## RESULT_HEADING/, "heading markers must be concealed")
  assert.match(longTop, /RESULT_BOLD item/)
  assert.doesNotMatch(longTop, /\*\*RESULT_BOLD/, "bold markers must be concealed")
  assert.match(longTop, /RESULT_CODE inline/)
  assert.doesNotMatch(longTop, /`RESULT_CODE`/, "inline code markers must be concealed")
  const longTopAnsi = readFileSync(join(evidence, "05-long-result-top.ansi"), "utf8")
  const markdown = { body: cellStyle(longTopAnsi, "RESULT_START"), heading: cellStyle(longTopAnsi, "RESULT_HEADING"), bold: cellStyle(longTopAnsi, "RESULT_BOLD"), code: cellStyle(longTopAnsi, "RESULT_CODE") }
  writeFileSync(join(evidence, "markdown-styles.json"), JSON.stringify(markdown, null, 2))
  assert.ok(markdown.heading.bold && markdown.heading.fg !== markdown.body.fg, `the heading must take the theme's Markdown heading style: ${JSON.stringify(markdown)}`)
  assert.ok(markdown.bold.bold, `bold text must render bold: ${JSON.stringify(markdown)}`)
  assert.notEqual(markdown.code.fg, markdown.body.fg, `inline code must take the theme's code colour: ${JSON.stringify(markdown)}`)
  checks.push("long result: Markdown concealed and styled from the host theme")
  assert.doesNotMatch(longTop, /RESULT_END/, "fixture must genuinely exceed the detail viewport")
  for (let i = 0; i < 30 && !pane().includes("RESULT_END"); i++) { keys("PageDown"); await sleep(100) }
  const longEnd = capture("05-long-result-bottom")
  assert.match(longEnd, /RESULT_END/, "PgDn must reach the end of a long result")
  selectedCard(longEnd, "p1")
  assert.doesNotMatch(longEnd, /RESULT_START/, "details must actually scroll, rather than grow outside the dialog")
  for (let i = 0; i < 30 && !pane().includes("RESULT_START"); i++) { keys("PageUp"); await sleep(100) }
  assert.match(capture("05-long-result-page-up"), /RESULT_START/, "PgUp must restore the result start")
  checks.push("long result: independent PgDn/PgUp scrolling reaches both ends")
  await resize(80, 30)
  for (let i = 0; i < 60 && !pane().includes("RESULT_END"); i++) { keys("PageDown"); await sleep(80) }
  assert.match(capture("06-narrow-long-result-bottom"), /RESULT_END/, "long result remains reachable after narrow resize")
  await selectLast()
  const reset = capture("06-selection-resets-detail-scroll")
  selectedCard(reset, "p7")
  assert.match(reset, /Node details/, "selecting another node resets detail scroll")
  assert.doesNotMatch(reset, /RESULT_END/, "old result content must not leak into the new selection")
  checks.push("narrow long result scrolls; changing selection resets details")
  keys("Escape"); await sleep(300)
  keys("-l", "responsive-draft"); await sleep(300)
  const closed = capture("07-closed-draft")
  assert.doesNotMatch(closed, DIALOG)
  assert.match(closed, /responsive-draft/)
  assert.doesNotMatch(trace(), /iolaus\.tui\.action/, "navigation/scroll/resize must not trigger DAG mutations")
  assert.equal([...trace().matchAll(/"event":"iolaus\.dag\.run\.started"/g)].length, 1)
  assert.equal(requests.filter((request) => request.node !== "owner").length, 7)
  checks.push("closing disposes dialog bindings; navigation caused no mutations")

  // Fork and join: the connectors meet the card centres, and the selection marks its real neighbours.
  keys("C-e", "C-u")
  await resize(160, 45)
  keys("-l", "Create the FORK_JOIN_QA flow"); keys("Enter")
  await waitFor(() => (trace().match(/"event":"iolaus\.dag\.run\.completed"/g) ?? []).length >= 2, "fork-join completion", 60000)
  await sleep(1200)
  keys("C-x"); await sleep(150); keys("d")
  await waitFor(() => /Flow · Fork join/.test(pane()) && pane().includes("FORK_RESULT_split"), "fork-join dialog with the split reply")
  const forkScreen = capture("08-fork-join")
  const lines = forkScreen.split("\n")
  const fb = lines.findIndex((line) => /┌─+┼─+┐/.test(line))
  assert.ok(fb >= 5, "the fork bar must be drawn below the split card")
  const forkCols = columns(lines[fb], "┌┼┐")
  assert.equal(forkCols.length, 3, `the fork bar must branch three ways: ${lines[fb]}`)
  assert.deepEqual(cardCentres(lines[fb - 5], "┏", "┓"), [forkCols[1]], "the trunk must leave the selected split card from its centre")
  assert.equal([...lines[fb - 1]][forkCols[1]], "│", "the trunk must meet the fork bar")
  assert.deepEqual(columns(lines[fb + 1], "▼"), forkCols, "an arrow must point into each part card")
  assert.deepEqual(cardCentres(lines[fb + 2], "╭", "╮"), forkCols, "each fork arrow must land on a part card's centre")
  const jb = lines.findIndex((line) => /└─+┼─+┘/.test(line))
  assert.equal(jb, fb + 6, "the join bar must follow the part cards")
  assert.deepEqual(columns(lines[jb], "└┼┘"), forkCols, "the join bar must collect every part card from its centre")
  assert.deepEqual(columns(lines[jb + 1], "▼"), [forkCols[1]], "one arrow must point into the join card")
  assert.deepEqual(cardCentres(lines[jb + 2], "╭", "╮"), [forkCols[1]], "the join arrow must land on the join card's centre")
  assert.match(forkScreen, /╭─ ✓ Done ─+╮/, "cards must carry their status in the border title")
  assert.match(forkScreen, /┃ › split\b/, "the split card must be selected")
  for (const id of ["part-a", "part-b", "part-c"]) assert.match(forkScreen, new RegExp(`│ ↓ ${id}\\b`), `${id} depends on the selection`)
  assert.match(forkScreen, /│   join\b/, "join does not depend on split directly")
  keys("j"); await sleep(600)
  const partScreen = capture("08-fork-join-part-selected")
  assert.match(partScreen, /┃ › part-a\b/, "j must select the first part")
  assert.match(partScreen, /│ ↑ split\b/, "the selection must mark what it depends on")
  assert.match(partScreen, /│ ↓ join\b/, "the selection must mark what depends on it")
  assert.match(partScreen, /│   part-b\b/, "siblings are not marked")
  keys("Escape"); await sleep(300)
  assert.equal(requests.filter((request) => request.node.startsWith("fork-")).length, 5)
  assert.equal([...trace().matchAll(/"event":"iolaus\.dag\.run\.started"/g)].length, 2)
  checks.push("fork/join: connectors meet card centres; ↑/↓ mark the selection's neighbours")
  databases.atEnd = sandboxDatabases()
  assert.ok(databases.atEnd.includes(sandboxDatabase), `the sandbox TUI lost its own database: ${databases.atEnd}`)
  assert.ok(databases.atEnd.every((path) => path.startsWith(`${sandbox}/`)), `the sandbox TUI opened a database outside the sandbox: ${databases.atEnd}`)
  checks.push("isolation: the sandbox TUI opened no database outside the sandbox")
} catch (error) {
  failure = error
  try { capture("99-failure") } catch (captureError) {
    writeFileSync(join(evidence, "capture-failure.txt"), String(captureError?.stack ?? captureError))
  }
  writeFileSync(join(evidence, "failure.txt"), String(error?.stack ?? error))
} finally {
  const table = processTable(), descendants = new Set(panePID ? [panePID] : [])
  for (let changed = true; changed;) {
    changed = false
    for (const row of table) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true }
  }
  tracked = table.filter((row) => descendants.has(row.pid))
  tmux("kill-server")
  mock.closeAllConnections()
  if (mock.listening) await new Promise((done) => mock.close(done))
  await sleep(1000)
  for (const row of processTable()) if (tracked.some((old) => old.pid === row.pid && old.command === row.command)) {
    try { process.kill(row.pid, "SIGTERM"); forcedCleanup.push(row.pid) }
    catch (killError) { if (killError?.code !== "ESRCH") writeFileSync(join(evidence, `cleanup-${row.pid}.txt`), String(killError?.stack ?? killError)) }
  }
  await sleep(500)
  rmSync(sandbox, { recursive: true, force: true })
}
const survivors = processTable().filter((row) => tracked.some((old) => old.pid === row.pid && old.command === row.command))
const realAfter = await hostState()
const hostUnchanged = JSON.stringify(realBefore) === JSON.stringify(realAfter)
const realDatabaseDigestChanged = (await digest(hostDatabase)) !== databaseBefore
const cleanup = { sandboxRemoved: !existsSync(sandbox), mockClosed: !mock.listening, tmuxStopped: tmux("has-session", "-t", session).status !== 0, trackedPIDs: tracked.map((row) => row.pid), forcedCleanup, survivors: survivors.map((row) => row.pid) }
const cleanupPassed = cleanup.sandboxRemoved && cleanup.mockClosed && cleanup.tmuxStopped && survivors.length === 0
writeFileSync(join(evidence, "receipt.json"), JSON.stringify({
  verdict: failure || !hostUnchanged || !cleanupPassed ? "FAIL" : "PASS", failure: failure ? String(failure) : undefined,
  binary, version: execFileSync(binary, ["--version"], { encoding: "utf8", env }).trim(), packageRoot, mode,
  screens, checks, requests, realBefore, realAfter, hostUnchanged, realDatabaseDigestChanged, cleanup,
  isolation: { standalone: true, home, config, project, databases, inheritedEnvironment: Object.keys(env).filter((key) => ["PATH", "TMPDIR"].includes(key)) },
}, null, 2) + "\n")
if (failure) throw failure
assert.ok(hostUnchanged, "host config hashes changed")
assert.ok(cleanupPassed, "sandbox, mock, TMUX and all tracked processes must stop")
console.log(JSON.stringify({ evidence, verdict: "PASS", checks, cleanup }, null, 2))
