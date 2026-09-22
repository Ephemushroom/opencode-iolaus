import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

export function hostState() {
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share")
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const configs = [join(config, "opencode/opencode.json"), join(config, "opencode/opencode.jsonc"),
    join(homedir(), ".omo/omo.json"), join(homedir(), ".omo/omo.jsonc"),
    join(homedir(), ".omo/opencode2.json"), join(homedir(), ".omo/opencode2.jsonc")]
  const db = join(data, "opencode/opencode.db")
  const sql = (query) => execFileSync("sqlite3", ["-readonly", db, query], { encoding: "utf8" }).trim()
  const tables = existsSync(db) ? sql("SELECT name FROM sqlite_master WHERE type='table';").split("\n") : []
  return {
    configs: Object.fromEntries(configs.map((path) => [path, existsSync(path)
      ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent"])),
    db,
    sessions: Object.fromEntries(["session", "session_v2"].map((table) =>
      [table, tables.includes(table) ? Number(sql(`SELECT count(*) FROM ${table};`)) : "absent"])),
  }
}

function signalGroup(child, signal) {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
  }
}

export function createHostRunner(binary, evidence) {
  const children = new Map()
  const processes = []
  function start(name, args, fixture, executable = binary) {
    const child = spawn(executable, args, {
      cwd: fixture.project, env: fixture.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    })
    const record = { name, executable, args, pid: child.pid, cwd: fixture.project }
    processes.push(record)
    let output = ""
    const capture = (data) => {
      output += data
      appendFileSync(join(evidence, `${name}.log`), data)
    }
    child.stdout.on("data", capture)
    child.stderr.on("data", capture)
    const closed = new Promise((resolve) => {
      child.once("error", (error) => { record.error = error.message })
      child.once("close", (code, signal) => {
        Object.assign(record, { code, signal, closed: true })
        resolve({ code, signal, output })
      })
    })
    async function stop() {
      child.stdin.end()
      signalGroup(child, "SIGTERM")
      const deadline = setTimeout(() => signalGroup(child, "SIGKILL"), 3000)
      try { await closed } finally {
        clearTimeout(deadline)
        signalGroup(child, "SIGKILL")
        children.delete(child)
      }
    }
    children.set(child, stop)
    return { child, closed, stop }
  }
  async function run(name, args, fixture, executable) {
    const proc = start(name, args, fixture, executable)
    const deadline = setTimeout(() => signalGroup(proc.child, "SIGKILL"), 90000)
    try { return await proc.closed } finally { clearTimeout(deadline); await proc.stop() }
  }
  async function serve(name, fixture) {
    const password = randomBytes(32).toString("base64url")
    const proc = start(name, ["serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1",
      "--print-logs", "--log-level", "debug"], { ...fixture, env: { ...fixture.env, OPENCODE_PASSWORD: password } })
    const lines = createInterface({ input: proc.child.stdout })
    try {
      const ready = await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("Host readiness timed out")), 45000)
        lines.once("line", (line) => {
          clearTimeout(deadline)
          try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
        })
        proc.closed.then(() => { clearTimeout(deadline); reject(new Error("Host closed before readiness")) })
      })
      const url = new URL(ready.url)
      assert.equal(url.hostname, "127.0.0.1", "leased host must listen only on loopback")
      return { ...proc, url: url.origin, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
    } catch (error) { await proc.stop(); throw error } finally { lines.close() }
  }
  return {
    run, serve, processes,
    async cleanup() {
      await Promise.all([...children.values()].map((stop) => stop()))
    },
  }
}

export function createApi(host, logPath) {
  return async (method, path, body, authenticated = true) => {
    const response = await fetch(`${host.url}${path}`, {
      method, headers: { "content-type": "application/json", ...(authenticated ? { authorization: host.authorization } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000),
    })
    const text = await response.text()
    const result = { status: response.status, body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text || null }
    appendFileSync(logPath, JSON.stringify({ method, path, input: body, ...result }) + "\n")
    return result
  }
}
