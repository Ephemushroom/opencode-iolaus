import { expect, test } from "bun:test"
import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { createModelFallbackRuntime } from "./runtime"

const failure = { type: "session.execution.failed", data: {
  sessionID: "ses_root", error: { type: "ProviderError", message: "Subscription quota exhausted", status: 429 },
} }

test.each([true, false])("#given delayed executor ownership %s #when a quota failure arrives #then the ownership result determines fallback", async (managed) => {
  // given
  const ownership = Promise.withResolvers<boolean>()
  const gate = createSessionDispatchGate()
  const switched: string[] = []
  const runtime = createModelFallbackRuntime({
    gate, maxRetries: 1, isManaged: () => ownership.promise,
    getSession: async () => ({ agent: "oracle", model: { providerID: "openai", id: "gpt-5.6-sol" } }),
    switchModel: async (id) => { switched.push(id) }, redispatch: async () => undefined,
  })
  // when
  const pending = runtime.handleEvent(failure)
  expect(gate.isReserved("ses_root")).toBe(false)
  ownership.resolve(managed)
  await pending
  // then
  expect(switched).toEqual(managed ? [] : ["ses_root"])
  gate.dispose()
})

test.each(["session.execution.started", "session.input.admitted", "session.deleted", "dispose"])(
  "#given fallback waits on session lookup #when %s arrives #then the stale recovery cannot switch or dispatch",
  async (type) => {
    // given
    const lookup = Promise.withResolvers<{ readonly agent: string; readonly model: { readonly providerID: string; readonly id: string } }>()
    const started = Promise.withResolvers<void>()
    const switches: string[] = []
    const dispatches: string[] = []
    const runtime = createModelFallbackRuntime({
      gate: createSessionDispatchGate(), maxRetries: 1, isManaged: async () => false,
      getSession: () => { started.resolve(); return lookup.promise },
      switchModel: async (id) => { switches.push(id) }, redispatch: async (id) => { dispatches.push(id) },
    })
    const pending = runtime.handleEvent(failure)
    await started.promise
    // when
    if (type === "dispose") runtime.dispose()
    else await runtime.handleEvent({ type, data: { sessionID: "ses_root" } })
    lookup.resolve({ agent: "oracle", model: { providerID: "openai", id: "gpt-5.6-sol" } })
    await pending
    // then
    expect(switches).toEqual([])
    expect(dispatches).toEqual([])
  },
)
