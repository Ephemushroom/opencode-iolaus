import { describe, expect, test } from "bun:test"

import { parseMessage, searchableText } from "./message-shape"

// Payloads captured verbatim from a real opencode2 store on 0.0.0-next-17444.
const REAL_USER = '{"time":{"created":1786717760407},"text":"\\"Reply with the single word ok.\\"","files":[]}'
const REAL_ASSISTANT = JSON.stringify({
  time: { created: 1786717767268, completed: 1786717767935 },
  agent: "sisyphus",
  model: { id: "glm-4.7", providerID: "zhipuai" },
  content: [
    { type: "reasoning", text: "The user is asking me to reply with one word.", state: { reasoningField: "reasoning_content" } },
    { type: "text", text: "ok" },
  ],
  finish: "stop",
  cost: 0.0127604,
  tokens: { input: 21150, output: 3, reasoning: 29, cache: { read: 0, write: 0 } },
})
const REAL_AGENT_SWITCHED = '{"time":{"created":1786717823411},"agent":"prometheus"}'

describe("parseMessage", () => {
  describe("#given a real user payload", () => {
    describe("#when parsed", () => {
      test("#then it exposes text, created time, and file count", () => {
        const parsed = parseMessage("user", REAL_USER)

        expect(parsed.kind).toBe("user")
        if (parsed.kind !== "user") return
        expect(parsed.text).toBe('"Reply with the single word ok."')
        expect(parsed.createdAt).toBe(1786717760407)
        expect(parsed.fileCount).toBe(0)
      })
    })
  })

  describe("#given a real assistant payload", () => {
    describe("#when parsed", () => {
      test("#then reasoning and answer text are separated", () => {
        const parsed = parseMessage("assistant", REAL_ASSISTANT)

        expect(parsed.kind).toBe("assistant")
        if (parsed.kind !== "assistant") return
        expect(parsed.text).toBe("ok")
        expect(parsed.reasoning).toContain("one word")
      })

      test("#then model is rendered as provider/id", () => {
        const parsed = parseMessage("assistant", REAL_ASSISTANT)

        expect(parsed.kind).toBe("assistant")
        if (parsed.kind !== "assistant") return
        expect(parsed.model).toBe("zhipuai/glm-4.7")
      })

      test("#then cost, finish, and tokens survive", () => {
        const parsed = parseMessage("assistant", REAL_ASSISTANT)

        expect(parsed.kind).toBe("assistant")
        if (parsed.kind !== "assistant") return
        expect(parsed.finish).toBe("stop")
        expect(parsed.cost).toBeCloseTo(0.0127604)
        expect(parsed.tokens).toEqual({ input: 21150, output: 3, reasoning: 29 })
      })
    })
  })

  describe("#given a real agent-switched payload", () => {
    describe("#when parsed", () => {
      test("#then it reports the agent it switched to", () => {
        const parsed = parseMessage("agent-switched", REAL_AGENT_SWITCHED)

        expect(parsed.kind).toBe("agent-switched")
        if (parsed.kind !== "agent-switched") return
        expect(parsed.agent).toBe("prometheus")
      })
    })
  })

  describe("#given a payload the schema does not describe", () => {
    describe("#when the type is unrecognized", () => {
      test("#then it degrades to unknown instead of throwing", () => {
        const parsed = parseMessage("tool-result", '{"time":{"created":1},"text":"hi"}')

        expect(parsed.kind).toBe("unknown")
        if (parsed.kind !== "unknown") return
        expect(parsed.rawType).toBe("tool-result")
        expect(parsed.text).toBe("hi")
      })
    })

    describe("#when the JSON is unparseable", () => {
      test("#then it degrades to unknown instead of throwing", () => {
        const parsed = parseMessage("assistant", "{not json")

        expect(parsed.kind).toBe("unknown")
      })
    })

    describe("#when required fields have the wrong type", () => {
      test("#then missing values are undefined and nothing throws", () => {
        const parsed = parseMessage("assistant", '{"time":"nope","agent":42,"content":"nope","cost":"free"}')

        expect(parsed.kind).toBe("assistant")
        if (parsed.kind !== "assistant") return
        expect(parsed.createdAt).toBeUndefined()
        expect(parsed.agent).toBeUndefined()
        expect(parsed.text).toBe("")
        expect(parsed.cost).toBeUndefined()
      })
    })
  })
})

describe("searchableText", () => {
  describe("#given an assistant message", () => {
    describe("#when building the search corpus", () => {
      test("#then reasoning is excluded so search matches what was said", () => {
        const parsed = parseMessage("assistant", REAL_ASSISTANT)

        expect(searchableText(parsed)).toBe("ok")
      })
    })
  })
})
