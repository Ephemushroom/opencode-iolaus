import assert from "node:assert/strict"
import { once } from "node:events"
import { appendFileSync } from "node:fs"
import http from "node:http"
import { join } from "node:path"
import { sendSse, textEvents } from "../../../../.agents/skills/opencode-qa/scripts/lib/fake-openai-events.mjs"

export async function createHeldModel(evidence) {
  const held = new Map()
  const requests = []
  const waiters = new Map()
  const errors = []
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const text = JSON.stringify(body.input)
      const marker = text.match(/EXECUTION_QA_[A-Z]+/)?.[0]
      if (!marker || body.model !== "gpt-explore") return sendSse(res, textEvents(requests.length + 1, "auxiliary"))
      requests.push({ marker, model: body.model })
      appendFileSync(join(evidence, "held-requests.ndjson"), JSON.stringify(requests.at(-1)) + "\n")
      assert.ok(!held.has(marker), "same work must not dispatch twice")
      held.set(marker, res)
      waiters.get(marker)?.()
      waiters.delete(marker)
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
    entered(marker) {
      if (held.has(marker)) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { waiters.delete(marker); reject(new Error(`No model request for ${marker}`)) }, 15000)
        waiters.set(marker, () => { clearTimeout(timeout); resolve() })
      })
    },
    release(marker) {
      const response = held.get(marker)
      assert.ok(response, `Expected held request ${marker}`)
      sendSse(response, textEvents(requests.length + 1, `${marker}_DONE`))
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
    get closed() { return !server.listening },
  }
}
