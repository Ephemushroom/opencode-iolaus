import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"
import { once } from "node:events"

const root = resolve(new URL("..", import.meta.url).pathname)
const packageRoot = resolve(process.env.IOLAUS_QA_PACKAGE_ROOT ?? root)
const mode = process.env.IOLAUS_QA_THEME ?? "light"
assert.ok(mode === "light" || mode === "dark")
const evidence = resolve(process.argv[2] ?? join(root, ".iolaus/evidence/20260924-iolaus-dag-tui"))
assert.ok(evidence.startsWith(`${join(root, ".iolaus/evidence")}/`))
mkdirSync(evidence, { recursive: false })

const binary = process.env.QA_OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-tui-qa-")))
const project = join(sandbox, "project")
const localPackage = join(sandbox, "iolaus-package")
const home = join(sandbox, "home")
const config = join(sandbox, "config")
const tracePath = join(evidence, "trace.ndjson")
const tmuxLog = join(evidence, "tmux.log")
mkdirSync(project, { recursive: true })
mkdirSync(localPackage, { recursive: true })
mkdirSync(join(config, "opencode"), { recursive: true })
mkdirSync(home, { recursive: true })
mkdirSync(join(project, "node_modules"), { recursive: true })
mkdirSync(join(config, "opencode/plugins/iolaus"), { recursive: true })
symlinkSync(root, join(project, "node_modules/opencode-iolaus"), "dir")
symlinkSync(join(packageRoot, "dist"), join(localPackage, "dist"), "dir")
writeFileSync(join(localPackage, "package.json"), JSON.stringify({ name: "opencode-iolaus", type: "module", main: "./dist/index.js", exports: { ".": "./dist/index.js", "./tui": "./dist/tui.js" } }))

const realHome = homedir()
const realConfig = join(realHome, ".config/opencode/opencode.json")
const realDatabase = join(realHome, ".local/share/opencode/opencode.db")
const digest = async (path) => {
  if (!existsSync(path)) return "absent"
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
const realBefore = { config: await digest(realConfig), database: await digest(realDatabase) }
const hostDatabaseUsers = () => {
  const result = spawnSync("lsof", ["-t", realDatabase], { encoding: "utf8" })
  assert.ok(result.status === 0 || result.status === 1, result.stderr)
  return result.stdout.trim().split("\n").filter(Boolean).map(Number)
}
const hostUsersBefore = hostDatabaseUsers()
// Other host sessions keep writing the real database, so its digest can change for unrelated reasons. Isolation is
// proven directly: no process of the sandbox TUI opens a database outside the sandbox, at the start or at the end.
const sandboxDatabases = (panePID) => {
  const processes = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
  assert.equal(processes.status, 0, processes.stderr)
  const children = processes.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
  const processPIDs = [panePID]
  for (const pid of processPIDs) for (const [child, parent] of children) if (parent === pid) processPIDs.push(child)
  // A child that exits between ps and lsof makes lsof exit 1; the files of the others are still listed.
  const openFiles = spawnSync("lsof", ["-Fn", "-p", processPIDs.join(",")], { encoding: "utf8" })
  return [...new Set(openFiles.stdout.split("\n").filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line)).map((line) => line.slice(1)))].sort()
}

// Local mock model: the main session creates a plan-review DAG and waits; children answer by role. The reviewer (a
// judge) fails once so the graph shows a revise branch, then passes so the accept gate waits on screen.
const requests = []
function events(text, call) {
  const id = `resp_${requests.length}`, item = `item_${requests.length}`
  const result = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model: "gpt-5.5" } }]
  if (call) {
    const args = JSON.stringify(call.args)
    result.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: item, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: call.name, arguments: args, status: "completed" } })
  } else {
    result.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: item } },
      { type: "response.output_text.delta", item_id: item, output_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: item } })
  }
  result.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  return result
}
const mock = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const tools = (body.tools ?? []).map((t) => t.name ?? t.function?.name)
  const messageText = (body.input ?? []).filter((item) => item?.type === "message").map((item) => JSON.stringify(item)).join("\n")
  requests.push({ tools, hasInstructions: Boolean(body.instructions), text: messageText.slice(0, 200) })
  let text = "IOLAUS_TUI_QA_DONE", call
  if (messageText.includes("You are the reviewer node")) {
    // Slow the judge a little so the sidebar has time to show the running node; then FAIL once, PASS on the revised plan.
    await new Promise((done) => setTimeout(done, 1500))
    text = messageText.includes("This is the revised plan") ? "Looks right.\nVERDICT: PASS" : "Step 2 has no verification.\nVERDICT: FAIL"
  } else if (messageText.includes("Write the work plan")) { await new Promise((done) => setTimeout(done, 2500)); text = "IOLAUS_TUI_PLAN_V1" }
  else if (messageText.includes("The reviewer rejected the plan")) { await new Promise((done) => setTimeout(done, 2500)); text = "IOLAUS_TUI_PLAN_V2" }
  else if (messageText.includes("Execute the approved plan")) text = "IOLAUS_TUI_EXECUTED"
  else if (tools.includes("iolaus_dag")) {
    const prior = (body.input ?? []).filter((item) => item?.type === "function_call_output").at(-1)?.output
    let result; try { result = JSON.parse(prior); if (result?.run && result?.events) result = result.run } catch {}
    if (!result) call = { name: "iolaus_dag", args: { action: "create", template: { template: "plan-review", task: "IOLAUS_TUI_TASK", executor: "sisyphus" } } }
    else if (result.status === "running" || result.status === "paused") { await new Promise((done) => setTimeout(done, 3000)); call = { name: "iolaus_dag", args: { action: "snapshot", run_id: result.runID } } }
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  for (const event of events(text, call)) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end("data: [DONE]\n\n")
})
mock.listen(0, "127.0.0.1"); await once(mock, "listening")
const mockURL = `http://127.0.0.1:${mock.address().port}/v1`
mkdirSync(join(home, ".iolaus"), { recursive: true })
writeFileSync(join(home, ".iolaus", "iolaus.json"), JSON.stringify({ enabled: true, mcps: [], gh: false, verify: false, models: { agents: { prometheus: "openai/gpt-5.5", momus: "openai/gpt-5.5", sisyphus: "openai/gpt-5.5" } } }))

writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify({
  plugins: [{ package: join(packageRoot, "dist") }],
  model: "openai/gpt-5.5",
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  provider: { openai: { options: { apiKey: "fake-key", baseURL: mockURL }, models: {
    "gpt-5.5": { tool_call: true, limit: { context: 200000, output: 8192 } },
  } } },
}))
writeFileSync(join(config, "opencode/cli.json"), JSON.stringify({ plugins: [localPackage], theme: { name: "opencode", mode } }))
writeFileSync(join(config, "opencode/plugins/iolaus/package.json"), JSON.stringify({ type: "module", exports: { "./tui": "./tui.ts" } }))
writeFileSync(join(config, "opencode/plugins/iolaus/tui.ts"), `export { default } from ${JSON.stringify(join(packageRoot, "dist/tui.js"))}\n`)

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PWD: project,
  XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: join(sandbox, "data"),
  XDG_CACHE_HOME: join(sandbox, "cache"),
  XDG_STATE_HOME: join(sandbox, "state"),
  OPENCODE_TEST_HOME: home,
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  IOLAUS_TRACE: tracePath,
  IOLAUS_HOME: join(home, ".iolaus"),
  OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [localPackage], keybinds: { "theme.switch_mode": "f6" } }),
}

const session = `iolaus-tui-${process.pid}`
const tmux = (...args) => spawnSync("tmux", ["-L", session, ...args], { env, encoding: "utf8" })
const start = tmux("new-session", "-d", "-s", session, "-c", project, `${binary} --standalone`)
assert.equal(start.status, 0, start.stderr)
tmux("pipe-pane", "-t", `${session}:0.0`, "-o", `cat >> ${tmuxLog}`)

const target = `${session}:0.0`
const keys = (...args) => tmux("send-keys", "-t", target, ...args)
const capture = (name) => {
  const out = tmux("capture-pane", "-p", "-t", target).stdout ?? ""
  const ansi = tmux("capture-pane", "-p", "-e", "-t", target).stdout ?? ""
  writeFileSync(join(evidence, `${name}.txt`), out)
  writeFileSync(join(evidence, `${name}.ansi`), ansi)
  return out
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const traceHas = (pattern) => existsSync(tracePath) && pattern.test(readFileSync(tracePath, "utf8"))
const traceCount = (pattern) => existsSync(tracePath) ? readFileSync(tracePath, "utf8").split("\n").filter((line) => pattern.test(line)).length : 0
const waitFor = async (pattern, timeoutMs, label) => { const until = Date.now() + timeoutMs; while (Date.now() < until) { if (traceHas(pattern)) return; await sleep(300) } throw new Error(`timed out waiting for ${label}`) }
const waitForMore = async (pattern, above, timeoutMs, label) => { const until = Date.now() + timeoutMs; while (Date.now() < until) { if (traceCount(pattern) > above) return; await sleep(300) } throw new Error(`timed out waiting for ${label}`) }
const click = (x, y) => {
  keys("-l", `\x1b[<0;${x + 1};${y + 1}M`)
  keys("-l", `\x1b[<0;${x + 1};${y + 1}m`)
}
const SIDEBAR_HEADER = /^\s*Iolaus\s*$/m
const COMPOSER_STATUS = /Flow plan-review: IOLAUS_TUI_TASK ·/
const GATE_STATUS = /⏸ Flow plan-review: IOLAUS_TUI_TASK · \d+\/6 · awaiting approval: approve · waiting \d+(?:s|m(?: \d+s)?)/
// The details dialog is titled with the flow it shows; child session tabs read "Flow · <node>".
const DIALOG = /Flow · plan-review/
const SIDEBAR_MOUNTED = /iolaus\.tui\.sidebar\.mounted/
const SIDEBAR_UNMOUNTED = /iolaus\.tui\.sidebar\.unmounted/
const screens = {}
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "")
const isolation = { standalone: true, home, config, data: env.XDG_DATA_HOME, project, databasePaths: [], databasePathsAtEnd: [] }
let failure
let colors = [], nodeOrder = [], presence
tmux("resize-window", "-t", session, "-x", "160", "-y", "45")
try {
  await waitFor(/iolaus\.tui\.loaded/, 20000, "tui load")
  const panePID = Number(tmux("display-message", "-p", "-t", target, "#{pane_pid}").stdout.trim())
  assert.ok(Number.isSafeInteger(panePID) && panePID > 0, "missing standalone pane process")
  isolation.databasePaths = sandboxDatabases(panePID)
  assert.ok(isolation.databasePaths.some((path) => path === join(env.XDG_DATA_HOME, "opencode/opencode.db")), "standalone process did not open sandbox DB")
  assert.ok(isolation.databasePaths.every((path) => path.startsWith(`${sandbox}/`)), "standalone process opened a DB outside sandbox")
  await sleep(1500)
  screens.idle = capture("01-idle")
  // Cycle the primary agents with Shift+Tab (the host footer shows "shift+tab agents") and record each footer, back to Build.
  const footers = []
  for (let i = 0; i < 10; i++) {
    keys("BTab"); await sleep(400)
    const footer = strip(capture(`01-agent-${i}`)).split("\n").find((line) => / · GPT-5\.5/.test(line)) ?? ""
    footers.push(footer.trim())
    if (/\bBuild · GPT-5\.5/.test(footer)) break
  }
  screens.agents = footers.join("\n")
  writeFileSync(join(evidence, "01-agent-footers.txt"), screens.agents + "\n")
  keys("Run a plan-review DAG for IOLAUS_TUI_TASK", "Enter")
  await waitFor(/iolaus\.dag\.node\.started.*"nodeID":"plan"/, 30000, "plan node start")
  await sleep(800)
  screens.running = capture("02-running")
  await waitFor(/iolaus\.dag\.node\.waiting.*"nodeID":"approve"/, 60000, "approve gate")
  await sleep(1200)
  screens.gate = capture("03-gate-waiting")
  assert.doesNotMatch(screens.gate, DIALOG, "a new gate must not open a popup")
  // The host hides the sidebar below its width threshold and unmounts sidebar.content with it. While it is gone the
  // composer carries the live status; the moment the sidebar returns the status line leaves again.
  const unmountedBeforeNarrow = traceCount(SIDEBAR_UNMOUNTED)
  tmux("resize-window", "-t", session, "-x", "100", "-y", "45")
  await waitForMore(SIDEBAR_UNMOUNTED, unmountedBeforeNarrow, 5000, "sidebar unmount on the narrow layout")
  await sleep(600)
  screens.narrowStatus = capture("03-narrow-composer-status")
  assert.doesNotMatch(strip(screens.narrowStatus), SIDEBAR_HEADER, "narrow layout must hide the sidebar")
  assert.match(strip(screens.narrowStatus), GATE_STATUS, "composer status must appear when the host hides the sidebar")
  keys("-l", "nrw"); await sleep(300)
  const statusLines = capture("03-narrow-before-click").split("\n")
  const statusRow = statusLines.findIndex((line) => COMPOSER_STATUS.test(line))
  assert.ok(statusRow >= 0, "composer status row missing")
  click(statusLines[statusRow].indexOf("plan-review") + 1, statusRow)
  await sleep(400)
  screens.narrowStatusClick = capture("03-narrow-status-clicked")
  assert.match(screens.narrowStatusClick, DIALOG, "clicking the composer status must open the details dialog")
  assert.match(screens.narrowStatusClick, /Approval request/, "the dialog opened from the composer status must select the waiting gate")
  keys("Escape"); await sleep(300)
  screens.narrowAfterClick = capture("03-narrow-after-click")
  assert.doesNotMatch(screens.narrowAfterClick, DIALOG)
  assert.match(screens.narrowAfterClick, /nrw/, "closing the dialog opened from the composer status must keep the draft")
  assert.match(strip(screens.narrowAfterClick), COMPOSER_STATUS, "composer status must survive the dialog round trip while the sidebar stays hidden")
  keys("C-e", "C-u")
  const mountedBeforeWide = traceCount(SIDEBAR_MOUNTED)
  tmux("resize-window", "-t", session, "-x", "160", "-y", "45")
  await waitForMore(SIDEBAR_MOUNTED, mountedBeforeWide, 5000, "sidebar remount on the wide layout")
  await sleep(600)
  screens.wideAgain = capture("03-wide-composer-absent")
  assert.match(strip(screens.wideAgain), SIDEBAR_HEADER, "wide layout must restore the sidebar")
  assert.doesNotMatch(strip(screens.wideAgain), COMPOSER_STATUS, "composer status must disappear as soon as the sidebar returns")
  // Plain letters belong to the composer until the user explicitly opens the dialog.
  keys("-l", "jkoar"); await sleep(300)
  screens.typing = capture("03-composer-typing")
  assert.match(screens.typing, /jkoar/, "DAG shortcuts swallowed text intended for the composer")
  assert.ok(!traceHas(/iolaus\.tui\.(action|open)/), "typing must not execute DAG commands")
  keys("Left", "Left")
  keys("C-x"); await sleep(150); keys("d"); await sleep(300)
  screens.dialog = capture("03-dag-dialog")
  assert.match(screens.dialog, DIALOG, "the keyboard command must open a modal")
  assert.match(screens.dialog, /Approval request/, "the waiting gate must be selected")
  assert.match(screens.dialog, /Depends on:/)
  assert.match(screens.dialog, /Attempt:/)
  tmux("resize-window", "-t", session, "-x", "100", "-y", "45"); await sleep(400)
  screens.narrowDialog = capture("03-dialog-narrow")
  assert.match(screens.narrowDialog, DIALOG)
  assert.match(screens.narrowDialog, /Depends on:/, "narrow dialog must retain node details")
  assert.match(screens.narrowDialog, /Approval request/)
  tmux("resize-window", "-t", session, "-x", "160", "-y", "45"); await sleep(300)
  keys("Escape"); await sleep(200)
  keys("-l", "X"); await sleep(300)
  screens.escaped = capture("03-escape-to-composer")
  assert.match(screens.escaped, /jkoXar/, "Escape must restore the draft and original cursor position")
  assert.doesNotMatch(screens.escaped, DIALOG)
  keys("C-e", "C-u")
  // Hiding the sidebar by hand on a wide terminal (session.sidebar.toggle, <leader>b) follows the same rule.
  const unmountedBeforeToggle = traceCount(SIDEBAR_UNMOUNTED)
  keys("C-x"); await sleep(150); keys("b")
  await waitForMore(SIDEBAR_UNMOUNTED, unmountedBeforeToggle, 5000, "sidebar unmount on the manual toggle")
  await sleep(600)
  screens.manualHidden = capture("03-manual-hidden-sidebar")
  assert.doesNotMatch(strip(screens.manualHidden), SIDEBAR_HEADER, "the toggle must hide the sidebar")
  assert.match(strip(screens.manualHidden), GATE_STATUS, "composer status must appear when the user hides the sidebar on a wide terminal")
  keys("-l", "hid"); await sleep(300)
  screens.manualTyping = capture("03-manual-hidden-typing")
  assert.match(screens.manualTyping, /hid/, "the composer must keep accepting input under the status line")
  assert.ok(!traceHas(/iolaus\.tui\.(action|open)/), "typing under the status line must not execute DAG commands")
  keys("C-e", "C-u")
  const mountedBeforeToggle = traceCount(SIDEBAR_MOUNTED)
  keys("C-x"); await sleep(150); keys("b")
  await waitForMore(SIDEBAR_MOUNTED, mountedBeforeToggle, 5000, "sidebar remount on the manual toggle")
  await sleep(600)
  screens.manualShown = capture("03-manual-shown-sidebar")
  assert.match(strip(screens.manualShown), SIDEBAR_HEADER, "the toggle must show the sidebar again")
  assert.doesNotMatch(strip(screens.manualShown), COMPOSER_STATUS, "composer status must disappear when the sidebar is shown again")
  const gateLines = capture("03-before-click").split("\n")
  const gateRow = gateLines.findIndex((line) => line.includes("⏸ Approve the plan"))
  assert.ok(gateRow >= 0)
  click(gateLines[gateRow].indexOf("Approve the plan") + 1, gateRow)
  await sleep(300)
  screens.clicked = capture("03-clicked-node")
  assert.match(screens.clicked, DIALOG, "clicking a node must open the modal")
  assert.match(screens.clicked, /Approval request/, "clicking a gate must select that exact node")
  assert.ok(!traceHas(/iolaus\.tui\.(action|open)/))
  keys("k"); await sleep(200)
  screens.previousNode = capture("03-previous-node")
  assert.match(screens.previousNode, /Agent: momus/, "j/k must navigate the popup's dependency-ordered nodes")
  // Owner → child → owner while the run is paused and the sidebar is visible. Presence is keyed by session: the child
  // shows neither the owner's card nor a composer status, and back on the owner the card returns with the composer
  // empty. Closing the tab is also the host path that mounts sidebar.content more than once, so hiding the sidebar
  // afterwards proves the counted presence still reaches zero and the composer status returns.
  keys("k"); await sleep(200)
  screens.reviseNode = capture("03-revise-node")
  assert.match(screens.reviseNode, /Agent: prometheus/, "the revise node must be selectable for opening its child session")
  const opensBeforeChild = traceCount(/iolaus\.tui\.open/), mountedBeforeChild = traceCount(SIDEBAR_MOUNTED)
  keys("Enter")
  await waitForMore(/iolaus\.tui\.open/, opensBeforeChild, 5000, "opening the revise child session")
  await waitForMore(SIDEBAR_MOUNTED, mountedBeforeChild, 5000, "sidebar mount for the child session")
  await sleep(1200)
  screens.childDuringRun = capture("03-child-during-run")
  assert.doesNotMatch(screens.childDuringRun, DIALOG, "opening the child must close the popup")
  assert.match(strip(screens.childDuringRun), /No active flows/, "the child session must not inherit the owner's active run")
  assert.doesNotMatch(strip(screens.childDuringRun), COMPOSER_STATUS, "the child session must not show the owner's composer status")
  const mountedBeforeReturn = traceCount(SIDEBAR_MOUNTED)
  keys("C-x"); await sleep(150); keys("w")
  await waitForMore(SIDEBAR_MOUNTED, mountedBeforeReturn, 5000, "sidebar remount for the owner session")
  await sleep(1200)
  screens.ownerDuringRun = capture("03-owner-during-run")
  assert.match(strip(screens.ownerDuringRun), /waiting approval/, "returning to the owner must restore the paused run card")
  assert.match(strip(screens.ownerDuringRun), /⏸ Approve the plan/, "returning to the owner must restore the waiting gate")
  assert.doesNotMatch(strip(screens.ownerDuringRun), COMPOSER_STATUS, "the composer status must stay absent while the owner's sidebar is visible")
  const unmountedBeforeOwnerHide = traceCount(SIDEBAR_UNMOUNTED)
  keys("C-x"); await sleep(150); keys("b")
  await waitForMore(SIDEBAR_UNMOUNTED, unmountedBeforeOwnerHide, 5000, "sidebar unmount after the tab round trip")
  await sleep(600)
  screens.ownerHiddenAfterChild = capture("03-owner-hidden-after-child")
  assert.doesNotMatch(strip(screens.ownerHiddenAfterChild), SIDEBAR_HEADER, "the toggle must hide the sidebar after the tab round trip")
  assert.match(strip(screens.ownerHiddenAfterChild), GATE_STATUS, "composer status must return after the tab round trip once the sidebar is hidden")
  const lifecycle = readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => /^iolaus\.tui\.(sidebar\.(mounted|unmounted)|open)$/.test(event.event))
  const ownerID = lifecycle.find((event) => event.event === "iolaus.tui.sidebar.mounted")?.sessionID
  const childID = lifecycle.findLast((event) => event.event === "iolaus.tui.open")?.sessionID
  assert.ok(ownerID && childID && ownerID !== childID, "owner and child session ids must be distinct")
  const live = new Map()
  for (const event of lifecycle) if (event.event !== "iolaus.tui.open") live.set(event.sessionID, (live.get(event.sessionID) ?? 0) + (event.event.endsWith(".mounted") ? 1 : -1))
  presence = { owner: { mounted: lifecycle.filter((e) => e.event.endsWith(".mounted") && e.sessionID === ownerID).length, live: live.get(ownerID) ?? 0 }, child: { mounted: lifecycle.filter((e) => e.event.endsWith(".mounted") && e.sessionID === childID).length, live: live.get(childID) ?? 0 }, sessions: live.size }
  assert.ok(presence.child.mounted >= 1, "the child session must mount its own sidebar presence")
  assert.ok([...live.values()].every((count) => count === 0), `every mounted sidebar must be released once hidden: ${JSON.stringify([...live])}`)
  const mountedBeforeOwnerShow = traceCount(SIDEBAR_MOUNTED)
  keys("C-x"); await sleep(150); keys("b")
  await waitForMore(SIDEBAR_MOUNTED, mountedBeforeOwnerShow, 5000, "sidebar remount after the tab round trip")
  await sleep(600)
  screens.ownerShownAfterChild = capture("03-owner-shown-after-child")
  assert.match(strip(screens.ownerShownAfterChild), SIDEBAR_HEADER, "the toggle must show the sidebar again after the tab round trip")
  assert.doesNotMatch(strip(screens.ownerShownAfterChild), COMPOSER_STATUS, "composer status must leave again once the sidebar is back after the tab round trip")
  keys("C-x"); await sleep(150); keys("d"); await sleep(400)
  screens.reopened = capture("03-reopened-dialog")
  assert.match(screens.reopened, /Approval request/, "reopening the dialog must select the waiting gate again")
  keys("k"); await sleep(200)
  keys("j"); await sleep(200); keys("a")
  await waitFor(/iolaus\.tui\.action.*"action":"approve"/, 10000, "approve via keybind")
  await waitFor(/iolaus\.dag\.run\.completed/, 30000, "run completion")
  await sleep(1200)
  // The successor of the gate is an agent node below the viewport; selecting it must scroll its card into view.
  keys("j"); await sleep(300)
  screens.completed = capture("04-completed")
  assert.match(screens.completed, DIALOG, "the popup must update live without closing")
  // Enter opens the selected agent node and dismisses the modal.
  keys("Enter"); await sleep(400)
  await sleep(1200)
  screens.opened = capture("05-opened-child")
  assert.doesNotMatch(screens.opened, DIALOG, "opening an agent must close the popup")
  keys("F6"); await sleep(1200)
  screens.switched = capture("05-theme-switched")
  // A child has no directly owned DAG. Returning to the owner must restore its view without a new DAG event.
  keys("M-Up"); await sleep(1200)
  screens.returned = capture("06-returned-owner")
  await sleep(2100)
  screens.returnedLater = capture("06-returned-owner-later")
  keys("-l", "jkoar"); await sleep(300)
  screens.afterClose = capture("06-typing-after-dialog")
  assert.match(screens.afterClose, /jkoar/, "closed dialog bindings must be disposed")
  tmux("resize-window", "-t", session, "-x", "100", "-y", "45"); await sleep(600)
  screens.narrowFinished = capture("06-narrow-finished-run")
  assert.doesNotMatch(strip(screens.narrowFinished), SIDEBAR_HEADER, "narrow layout must hide the sidebar")
  assert.doesNotMatch(strip(screens.narrowFinished), COMPOSER_STATUS, "a finished run must not show the composer status even while the sidebar is hidden")
  keys("C-x"); await sleep(150); keys("d"); await sleep(400)
  screens.hiddenSidebar = capture("06-dialog-with-hidden-sidebar")
  assert.match(screens.hiddenSidebar, DIALOG, "keyboard entry must work when the host hides the sidebar")
  keys("Escape"); await sleep(200)
  tmux("resize-window", "-t", session, "-x", "160", "-y", "45"); await sleep(300)
  keys("C-p"); await sleep(200); keys("-l", "Iolaus Flow"); await sleep(200)
  screens.commands = capture("06-command-palette")
  assert.match(screens.commands, /Flow: show details/, "the Flow launcher must be discoverable in the palette")
  keys("Enter"); await sleep(400)
  screens.palette = capture("06-dialog-from-palette")
  assert.match(screens.palette, DIALOG, "the command palette must open the same dialog")
  keys("Escape"); await sleep(200)
  screens.afterPalette = capture("06-draft-after-palette")
  assert.match(screens.afterPalette, /jkoar/, "palette entry must also preserve the input draft")
  keys("C-e", "C-u")
  isolation.databasePathsAtEnd = sandboxDatabases(panePID)
  assert.ok(isolation.databasePathsAtEnd.some((path) => path === join(env.XDG_DATA_HOME, "opencode/opencode.db")), "standalone process lost its sandbox DB")
  assert.ok(isolation.databasePathsAtEnd.every((path) => path.startsWith(`${sandbox}/`)), "standalone process opened a DB outside sandbox at the end of the run")
  keys("C-c"); await sleep(500)
const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : ""
assert.match(trace, /iolaus\.tui\.loaded/)
assert.match(screens.agents, /\bSisyphus · GPT-5\.5/, `agent cycle did not show "Sisyphus": ${screens.agents}`)
// Hephaestus is a subagent and is not in the primary cycle; Prometheus and Atlas are.
assert.match(screens.agents, /\bPrometheus · GPT-5\.5/, `agent cycle did not show "Prometheus": ${screens.agents}`)
assert.match(screens.agents, /\bAtlas · GPT-5\.5/, `agent cycle did not show "Atlas": ${screens.agents}`)
assert.ok(!/iolaus-(sisyphus|hephaestus|prometheus|atlas)/.test(screens.agents), `primary agents still show the iolaus- prefix: ${screens.agents}`)
assert.match(strip(screens.running), /^\s*Iolaus\s*$/m, "sidebar header missing")
assert.doesNotMatch(strip(screens.running), /Flow · \d+ run/, "redundant sidebar footer must not be rendered")
assert.match(strip(screens.running), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Write the plan/, "running plan node not rendered with the spinner and its title")
assert.match(strip(screens.running), /╭╌ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] running · \d+s ╌*╮/, "running run must carry its spinner and live clock in the dashed frame title")
assert.doesNotMatch(strip(screens.running), COMPOSER_STATUS, "redundant composer status must not be rendered")
assert.doesNotMatch(strip(screens.gate), COMPOSER_STATUS, "waiting gates must not restore the redundant composer status")
assert.match(strip(screens.running), /Write the plan/, "node summary line missing")
assert.match(strip(screens.running), /━+ \d+\/6/, "progress bar missing")
assert.match(strip(screens.gate), /⏸ Approve the plan +◇/, "waiting gate not rendered with its title and gate mark")
assert.match(strip(screens.gate), /✓ Review the plan +⚖/, "judge node not rendered with its title and judge mark")
assert.match(strip(screens.dialog).replace(/\s+/g, " "), /Plan for "IOLAUS_TUI_TASK" passed review/, "full gate prompt not rendered in the popup")
assert.match(strip(screens.gate), /[↷✓] (Revise the plan|Re-review the revised plan)/, "review branch state not rendered")
assert.match(strip(screens.gate), /╭╌ ⏸ waiting approval · \d+(?:s|m(?: \d+s)?) ╌*╮/, "sidebar frame title must report the waiting gate with its clock")
assert.doesNotMatch(strip(screens.gate), /\d+ awaiting approval/, "the sidebar must not repeat the waiting gate on a line of its own")
assert.doesNotMatch(strip(screens.gate), /gen 1\b/, "the first generation must not be shown")
assert.match(strip(screens.gate), /Click for details/, "sidebar must explain how to open details")
assert.match(strip(screens.dialog).replace(/\s+/g, " "), /Esc close/, "dialog must explain how to return to typing")
assert.match(strip(screens.dialog), /esc close/, "the dialog header must carry the native esc close hint")
assert.match(strip(screens.dialog), /╭─ ✓ Done ─+╮/, "dialog cards must carry their status in the border title")
assert.match(strip(screens.dialog), /┏━ ⏸ Waiting approval ━+┓/, "the selected card must use the heavy border with its status title")
assert.match(strip(screens.dialog), /│ ↑ rereview\b/, "the selected gate must mark the card it depends on")
assert.match(strip(screens.previousNode), /┃ › rereview\b/, "j/k must move the selection to the previous card")
assert.match(strip(screens.previousNode), /│ ↑ revise\b/, "the selection must mark its upstream card")
assert.match(strip(screens.previousNode), /│ ↓ approve\b/, "the selection must mark its downstream card")
assert.doesNotMatch(strip(screens.dialog), /gen \d/, "the dialog must not show the first generation")
assert.match(strip(screens.dialog), /▼/, "dialog must draw arrows between dependency waves")
assert.match(strip(screens.dialog), /Waiting approval/, "cards must carry a readable status label")
assert.match(strip(screens.dialog), /Unblocks: execute/, "node details must name the nodes the selection unblocks")
assert.match(strip(screens.dialog), /Node details/, "dialog must show the node details panel")
assert.match(trace, /iolaus\.tui\.action.*"action":"approve".*"nodeID":"approve"/, "approve keybind did not reach the RPC")
assert.match(strip(screens.completed), /✓ execute/, "execute node not shown completed")
assert.match(strip(screens.completed), /┃ › execute/, "selecting the next node must scroll its highlighted card into view")
assert.match(trace, /iolaus\.tui\.open.*"sessionID":"ses_/, "open keybind did not target a child session")
assert.match(strip(screens.opened), /No active flows/, "child session must not inherit another session's ownership")
assert.match(strip(screens.returned), /plan-review: IOLAUS_TUI_TASK/, "switching back must reload the owner flow without an event")
const finishedClock = (screen) => strip(screen).match(/done in [0-9hms ]+/)?.[0].trim()
assert.ok(finishedClock(screens.returned), "completed run must show a fixed duration")
assert.equal(finishedClock(screens.returnedLater), finishedClock(screens.returned), "completed run clock kept ticking")
assert.doesNotMatch(strip(screens.returned), /╌/, "completed run must not keep the running frame")
assert.doesNotMatch(strip(screens.returned), COMPOSER_STATUS, "composer status must disappear once the run finishes")
assert.match(strip(screens.returned), /Recent/, "completed run must move to the history list")
colors = []
for (const [file, label, expectedMode] of [["02-running.ansi", "Iolaus", mode], ["05-opened-child.ansi", "No active flows", mode], ["05-theme-switched.ansi", "No active flows", mode === "light" ? "dark" : "light"]]) {
  const line = readFileSync(join(evidence, file), "utf8").split("\n").find((line) => strip(line).includes(label))
  assert.ok(line, `missing ${label}`)
  let fg
  let text = ""
  let color
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      const codes = part.slice(2, -1).split(";").map(Number)
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === 0 || codes[i] === 39) fg = undefined
        if (codes[i] === 38 && codes[i + 1] === 2) { fg = codes.slice(i + 2, i + 5); i += 4 }
      }
    } else {
      text += part
      if (text.includes(label)) { color = fg; break }
    }
  }
  assert.ok(color, `${label} has no explicit RGB foreground (the original flat-theme bug)`)
  const luminance = color.reduce((sum, channel, i) => {
    const value = channel / 255
    return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
  }, 0)
  assert.ok(expectedMode === "light" ? luminance < 0.5 : luminance > 0.1, `${label} unreadable in ${expectedMode}: ${color}`)
  colors.push({ label, mode: expectedMode, rgb: color, luminance })
}
assert.notDeepEqual(colors[1].rgb, colors[2].rgb, "live theme switch must update the mounted sidebar")
nodeOrder = [...trace.matchAll(/iolaus\.dag\.node\.(?:completed|approved)[^\n]*"nodeID":"([a-z]+)"/g)].map((m) => m[1])
assert.deepEqual(nodeOrder, ["plan", "review", "revise", "rereview", "approve", "execute"], `unexpected node order ${nodeOrder}`)
assert.ok(!/iolaus\.agent\.rendered[^\n]*"agent":"momus"/.test(trace), "judge review opened a momus child session")
assert.equal([...trace.matchAll(/"event":"iolaus\.dag\.run\.started"/g)].length, 1, "popup Enter must not submit the background draft")
} catch (error) {
  failure = error
  if (tmux("has-session", "-t", session).status === 0) capture("99-failure")
} finally {
  tmux("kill-session", "-t", session)
  mock.closeAllConnections(); await new Promise((done) => mock.close(done))
  rmSync(sandbox, { recursive: true, force: true })
}
const realAfter = { config: await digest(realConfig), database: await digest(realDatabase) }
const hostUsersAfter = hostDatabaseUsers()
const hostUnchanged = realAfter.config === realBefore.config
const sandboxRemoved = !existsSync(sandbox)
const cleanup = { sandboxRemoved, mockClosed: !mock.listening, tmuxStopped: tmux("has-session", "-t", session).status !== 0 }
if (!hostUnchanged) failure ??= new assert.AssertionError({ message: "real host config changed during isolated QA", actual: realAfter.config, expected: realBefore.config, operator: "strictEqual" })
if (!cleanup.sandboxRemoved || !cleanup.mockClosed || !cleanup.tmuxStopped) failure ??= new Error("QA cleanup incomplete")
if (failure) writeFileSync(join(evidence, "failure.txt"), String(failure?.stack ?? failure))
writeFileSync(join(evidence, "receipt.json"), JSON.stringify({
  verdict: failure ? "FAIL" : "PASS",
  failure: failure ? String(failure.message) : undefined,
  binary,
  version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
  mode,
  colors,
  tracePath,
  tmuxLog,
  nativeTuiLoaded: traceHas(/iolaus\.tui\.loaded/),
  screens: Object.keys(screens),
  nodeOrder,
  sidebarPresence: presence,
  requestCount: requests.length,
  realBefore,
  realAfter,
  hostUnchanged,
  realDatabaseDigestChanged: realAfter.database !== realBefore.database,
  hostDatabaseUsers: { before: hostUsersBefore, after: hostUsersAfter },
  isolation,
  cleanup,
  sandboxRemoved,
  omitted: "No provider credentials, auth files, prompts, or inherited secret-bearing environment values were recorded.",
}, null, 2) + "\n")
if (failure) throw failure
console.log(JSON.stringify({ evidence, verdict: "PASS", nativeTuiLoaded: true, sandboxRemoved }, null, 2))
