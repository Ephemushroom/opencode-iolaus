import assert from "node:assert/strict"
import { once } from "node:events"
import http from "node:http"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { sendSse, textEvents, toolCallEvents } from "../../../.agents/skills/opencode-qa/scripts/lib/fake-openai-events.mjs"

export async function createTeamModel(evidence) {
  const operations = []
  const requests = []
  const errors = []
  const held = new Map()
  const entered = new Map()
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const serialized = JSON.stringify(body.input)
      const operation = operations.findLast((candidate) => serialized.includes(candidate.marker))
      const receipt = { model: body.model, input: body.input, tools: (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name) }
      requests.push(receipt)
      appendFileSync(join(evidence, "model.ndjson"), JSON.stringify(receipt) + "\n")
      assert.ok(requests.length < 120, "unexpected execution loop")
      if (body.model !== "gpt-fake") {
        for (const [marker, gate] of entered) if (serialized.includes(marker)) gate.resolve()
        const marker = [...held.keys()].find((key) => serialized.includes(key))
        if (marker) {
          entered.get(marker)?.resolve()
          await held.get(marker).promise
          if (res.destroyed) return
        }
      }
      if (body.model === "gpt-quick" && serialized.includes("QA_PARENT_SPAWNS_BACKGROUND")) {
        const nestedID = "qa_nested_background"
        if (!body.input.some((item) => item.type === "function_call" && item.call_id === nestedID)) {
          return sendSse(res, toolCallEvents(requests.length, "task", nestedID, {
            category: "quick", prompt: "QA_NESTED_CHILD", run_in_background: true,
          }))
        }
        return sendSse(res, textEvents(requests.length, "QA_NESTED_PARENT_DONE"))
      }
      if (body.model === "gpt-quick" && serialized.includes("QA_NESTED_CHILD")) {
        return sendSse(res, textEvents(requests.length, "QA_NESTED_RESULT_PAYLOAD"))
      }
      if (body.model === "gpt-fake" && operation) {
        const output = body.input.findLast((item) => item.type === "function_call_output" && item.call_id === operation.callID)
        if (output) operation.output = output.output
        if (!operation.sent) {
          operation.sent = true
          return sendSse(res, toolCallEvents(requests.length, operation.tool, operation.callID, operation.input))
        }
      }
      sendSse(res, textEvents(requests.length, "QA_NATIVE_TEAM_TURN_DONE"))
    } catch (error) {
      errors.push(String(error))
      res.writeHead(500).end("QA failed")
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    url: `http://127.0.0.1:${address.port}`, requests, errors,
    watch(marker) { entered.set(marker, Promise.withResolvers()) },
    hold(marker) {
      held.set(marker, Promise.withResolvers())
      entered.set(marker, Promise.withResolvers())
    },
    async entered(marker) {
      const timer = AbortSignal.timeout(15000)
      await Promise.race([entered.get(marker).promise, new Promise((_, reject) => {
        timer.addEventListener("abort", () => reject(new Error(`model did not receive ${marker}`)), { once: true })
      })])
    },
    release(marker) { held.get(marker)?.resolve() },
    async enteredCount(markers, count) {
      const pending = new Map(markers.map((marker) => [marker, entered.get(marker).promise.then(() => marker)]))
      let timer
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("held member admission timed out")), 15000) })
        for (let index = 0; index < count; index++) pending.delete(await Promise.race([...pending.values(), timeout]))
        return [...pending.keys()]
      } finally { clearTimeout(timer) }
    },
    operation(tool, input) {
      const id = operations.length + 1
      const operation = { marker: `QA_NATIVE_OPERATION_${id}_END`, callID: `qa_native_call_${id}`, tool, input, sent: false }
      operations.push(operation)
      return operation
    },
    async close() {
      for (const gate of held.values()) gate.resolve()
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
