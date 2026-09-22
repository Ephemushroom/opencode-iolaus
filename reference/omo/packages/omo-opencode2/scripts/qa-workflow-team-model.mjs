import assert from "node:assert/strict"
import { once } from "node:events"
import { appendFileSync } from "node:fs"
import http from "node:http"
import { join } from "node:path"
import { sendSse, textEvents, toolCallEvents } from "../../../.agents/skills/opencode-qa/scripts/lib/fake-openai-events.mjs"

export async function createWorkflowTeamModel(evidence) {
  const requests = []
  const errors = []
  let pending
  const holds = new Map()
  const observations = new Map()
  const failures = new Set()
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const tools = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name)
      const request = { model: body.model, tools, schemas: body.tools, input: body.input }
      requests.push(request)
      appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(request) + "\n")
      assert.ok(requests.length <= 200, "Model request budget exceeded")
      if (body.model === "gpt-explore" || body.model === "gpt-quick") {
        const text = JSON.stringify(body.input)
        for (const [marker, gate] of observations) if (text.includes(marker)) gate.resolve()
        const fail = [...failures].find((marker) => text.includes(marker))
        if (fail) {
          failures.delete(fail)
          return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: "QA_EXPECTED_NODE_FAILURE" } }))
        }
        const hold = [...holds].find(([marker]) => text.includes(marker))
        if (hold) {
          await hold[1].promise
          if (res.destroyed) return
        }
        const marker = text.includes("QA_TEAM_MESSAGE") ? "QA_TEAM_MESSAGE"
          : text.includes("QA_TEAM_INITIAL") ? "QA_TEAM_INITIAL" : "QA_WORKFLOW_NODE"
        return sendSse(res, textEvents(requests.length, `${marker}_DONE`))
      }
      if (body.model === "gpt-fake" && tools.length && pending) {
        const call = pending
        pending = undefined
        assert.ok(tools.includes(call.name), `Actual plugin did not register ${call.name}`)
        return sendSse(res, toolCallEvents(requests.length, call.name, call.id, call.input))
      }
      sendSse(res, textEvents(requests.length, "QA_PARENT_DONE"))
    } catch (error) {
      errors.push(String(error))
      res.writeHead(500).end("QA mock failed")
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    requests, errors, url: `http://127.0.0.1:${address.port}`,
    arm(call) { assert.equal(pending, undefined); pending = call },
    watch(marker) { observations.set(marker, Promise.withResolvers()) },
    hold(marker) { observations.set(marker, Promise.withResolvers()); holds.set(marker, Promise.withResolvers()) },
    release(marker) { holds.get(marker)?.resolve() },
    failOnce(marker) { failures.add(marker) },
    async entered(marker) {
      let timer
      try { await Promise.race([observations.get(marker).promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Missing model request ${marker}`)), 15000)
      })]) } finally { clearTimeout(timer) }
    },
    async close() {
      for (const gate of holds.values()) gate.resolve()
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
    get closed() { return !server.listening },
  }
}
