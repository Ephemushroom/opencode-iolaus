import assert from "node:assert/strict"
import { once } from "node:events"
import { appendFileSync } from "node:fs"
import http from "node:http"
import { join } from "node:path"
import { sendSse, textEvents, toolCallEvents } from "../../../../.agents/skills/opencode-qa/scripts/lib/fake-openai-events.mjs"

export const GOAL_PAYLOAD = "QA_GOAL_LITERAL $$ $& $` $' $ARGUMENTS $SESSION_ID $TIMESTAMP"
export const TODO_PAYLOAD = "QA_TODO_DYNAMIC_CONTENT_19425"
export const TRANSPORT_PAYLOAD = "QA_NATIVE_COMMAND_TRANSPORT_19425"

export async function createModel(evidence) {
  const requests = []
  const errors = []
  let active = { name: "boot", step: 0 }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/responses") return res.writeHead(404).end()
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const tools = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name)
      const request = { scenario: active.name, model: body.model, tools, input: body.input, instructions: body.instructions }
      requests.push(request)
      appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(request) + "\n")
      assert.ok(requests.length <= 80, "unexpected model request loop")
      const count = requests.length
      if (body.model === "gpt-explore" || body.model === "gpt-quick") {
        return sendSse(res, textEvents(count, `QA_CHILD_${body.model}_DONE`))
      }
      if ((active.name.endsWith("-direct") || active.name.endsWith("-category")) && tools.length > 0) {
        active.step += 1
        if (active.step === 1) return sendSse(res, toolCallEvents(count, "task", `call_task_${count}`, {
          prompt: "Return the QA child answer", description: "QA child delegation", load_skills: [], run_in_background: false,
          ...(active.name.endsWith("-direct") ? { subagent_type: "explore" } : { category: "quick" }),
        }))
      }
      if (active.name.endsWith("-native") && tools.length > 0) {
        active.step += 1
        switch (active.step) {
          case 1:
            return sendSse(res, toolCallEvents(count, "read", `call_read_${count}`, { path: active.readPath }))
          case 2:
            return sendSse(res, toolCallEvents(count, "todowrite", `call_todo_${count}`, {
              todos: [{ id: "qa", content: TODO_PAYLOAD, status: "pending", priority: "high" }],
            }))
          case 3:
            return sendSse(res, toolCallEvents(count, "todowrite", `call_clear_${count}`, { todos: [] }))
          default: break
        }
      }
      sendSse(res, textEvents(count, "QA_API_OK"))
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
    select(name, readPath) { active = { name, readPath, step: 0 } },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
    get closed() { return !server.listening },
  }
}
