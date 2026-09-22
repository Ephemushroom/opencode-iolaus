import { describe, expect, test } from "bun:test"

import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { createModelFallbackRuntime } from "./runtime"
import type { ModelFallbackEvent, ModelFallbackTrace } from "./runtime"

const SESSION_ID = "session-main"
const CURRENT_MODEL = { providerID: "openai", id: "gpt-5.6-sol" } as const
const QUOTA_FAILURE: ModelFallbackEvent = {
  type: "session.execution.failed",
  data: {
    sessionID: SESSION_ID,
    error: { type: "ProviderError", message: "Subscription quota exhausted", status: 429 },
  },
}

function createFixture(options: { readonly maxRetries?: number; readonly gate?: ReturnType<typeof createSessionDispatchGate> } = {}) {
  const switches: Array<{ readonly sessionID: string; readonly providerID: string; readonly id: string }> = []
  const redispatches: string[] = []
  const traces: Array<{ readonly event: string; readonly detail?: Record<string, unknown> }> = []
  const trace: ModelFallbackTrace = (event, detail) => traces.push(detail === undefined ? { event } : { event, detail })
  const managedSessions = new Set<string>()
  const runtime = createModelFallbackRuntime({
    gate: options.gate ?? createSessionDispatchGate({ postDispatchHoldMs: 1 }),
    isManaged: async (sessionID) => managedSessions.has(sessionID),
    maxRetries: options.maxRetries ?? 1,
    getSession: async () => ({ agent: "oracle", model: CURRENT_MODEL }),
    switchModel: async (sessionID, model) => {
      switches.push({ sessionID, ...model })
    },
    redispatch: async (sessionID) => {
      redispatches.push(sessionID)
    },
    trace,
  })
  return { redispatches, managedSessions, runtime, switches, traces }
}

describe("model fallback runtime", () => {
  test("#given a provider-exhaustion failure on a main session #when handled #then it switches to the next chain model and redispatches once", async () => {
    // given
    const fixture = createFixture()

    // when
    await fixture.runtime.handleEvent(QUOTA_FAILURE)

    // then
    expect(fixture.switches).toHaveLength(1)
    expect(fixture.switches[0]?.sessionID).toBe(SESSION_ID)
    expect(`${fixture.switches[0]?.providerID}/${fixture.switches[0]?.id}`).not.toBe("openai/gpt-5.6-sol")
    expect(fixture.redispatches).toEqual([SESSION_ID])
    expect(fixture.traces.map(({ event }) => event)).toContain("omo.model-fallback.triggered")
    expect(fixture.traces.map(({ event }) => event)).toContain("omo.model-fallback.switched")
  })

  test("#given a non-exhaustion execution failure #when handled #then it does not switch or redispatch", async () => {
    // given
    const fixture = createFixture()
    const event: ModelFallbackEvent = {
      type: "session.execution.failed",
      data: { sessionID: SESSION_ID, error: { type: "ValidationError", message: "Invalid request payload", status: 400 } },
    }

    // when
    await fixture.runtime.handleEvent(event)

    // then
    expect(fixture.switches).toEqual([])
    expect(fixture.redispatches).toEqual([])
  })

  test("#given an eligible failure from a task-engine child session #when handled #then it is skipped", async () => {
    // given
    const fixture = createFixture()
    fixture.managedSessions.add(SESSION_ID)

    // when
    await fixture.runtime.handleEvent(QUOTA_FAILURE)

    // then
    expect(fixture.switches).toEqual([])
    expect(fixture.traces).toContainEqual({
      event: "omo.model-fallback.skipped-child",
      detail: { sessionID: SESSION_ID },
    })
  })

  test("#given one allowed retry #when failures repeat and then a success resets the counter #then only one switch occurs before reset and another is allowed after", async () => {
    // given
    let clock = 1_000
    const gate = createSessionDispatchGate({ postDispatchHoldMs: 1, now: () => clock })
    const fixture = createFixture({ gate, maxRetries: 1 })

    // when
    await fixture.runtime.handleEvent(QUOTA_FAILURE)
    clock += 1
    await fixture.runtime.handleEvent(QUOTA_FAILURE)
    await fixture.runtime.handleEvent({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    clock += 1
    await fixture.runtime.handleEvent(QUOTA_FAILURE)

    // then
    expect(fixture.switches).toHaveLength(2)
    expect(fixture.redispatches).toHaveLength(2)
    expect(fixture.traces.some(({ event, detail }) => event === "omo.model-fallback.exhausted" && detail?.reason === "max_retries")).toBe(true)
  })

  test("#given another feature holds the shared session gate #when an eligible failure arrives #then fallback does not switch or redispatch", async () => {
    // given
    const gate = createSessionDispatchGate()
    let releaseHold: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve
    })
    const reservation = gate.run(SESSION_ID, async (markDispatched) => {
      markDispatched()
      await held
    })
    const fixture = createFixture({ gate })

    // when
    await fixture.runtime.handleEvent(QUOTA_FAILURE)

    // then
    expect(fixture.switches).toEqual([])
    expect(fixture.redispatches).toEqual([])
    releaseHold?.()
    await reservation
  })

  test("#given the active model is already the last fallback entry #when an eligible failure arrives #then the chain is exhausted without redispatch", async () => {
    // given
    const switches: string[] = []
    const redispatches: string[] = []
    const traces: Array<{ readonly event: string; readonly detail?: Record<string, unknown> }> = []
    const runtime = createModelFallbackRuntime({
      gate: createSessionDispatchGate(),
      isManaged: async () => false,
      maxRetries: 1,
      getSession: async () => ({ agent: "hephaestus", model: CURRENT_MODEL }),
      switchModel: async (sessionID) => {
        switches.push(sessionID)
      },
      redispatch: async (sessionID) => {
        redispatches.push(sessionID)
      },
      trace: (event, detail) => traces.push(detail === undefined ? { event } : { event, detail }),
    })

    // when
    await runtime.handleEvent(QUOTA_FAILURE)

    // then
    expect(switches).toEqual([])
    expect(redispatches).toEqual([])
    expect(traces.some(({ event, detail }) => event === "omo.model-fallback.exhausted" && detail?.reason === "fallback_chain")).toBe(true)
  })
})
