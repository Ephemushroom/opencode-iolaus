import { describe, expect, test } from "bun:test"

import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { TaskRegistry } from "../../orchestration/task-registry"
import { registerConfiguredModelFallback } from "./register"
import type { ModelFallbackContext } from "./register"

async function* emptyEvents() {
  return
}

function createContext(
  options: Readonly<Record<string, unknown>>,
  calls: { contextHooks: number; subscriptions: number },
): ModelFallbackContext {
  return {
    options,
    event: {
      subscribe: () => {
        calls.subscriptions += 1
        return emptyEvents()
      },
    },
    session: {
      get: async () => ({ agent: "oracle", model: { providerID: "openai", id: "gpt-5.6-sol" } }),
      hook: async () => {
        calls.contextHooks += 1
      },
      switchModel: async () => undefined,
      synthetic: async () => undefined,
    },
  }
}

describe("registerConfiguredModelFallback", () => {
  test("#given model fallback is not enabled #when registration runs #then it traces disabled and installs no event pump", async () => {
    // given
    const calls = { contextHooks: 0, subscriptions: 0 }
    const traces: Array<{ readonly event: string; readonly detail?: Record<string, unknown> }> = []

    // when
    const registration = await registerConfiguredModelFallback(createContext({}, calls), {
      directory: process.cwd(),
      gate: createSessionDispatchGate(),
      registry: new TaskRegistry(),
      trace: (event, detail) => traces.push(detail === undefined ? { event } : { event, detail }),
    })

    // then
    expect(calls.subscriptions).toBe(0)
    expect(calls.contextHooks).toBe(0)
    expect(traces).toContainEqual({
      event: "omo.model-fallback.disabled",
      detail: { reason: "model_fallback.enabled is not true" },
    })
    registration.dispose()
  })

  test("#given model fallback is enabled but listed in disabled_hooks #when registration runs #then disabled_hooks wins", async () => {
    // given
    const calls = { contextHooks: 0, subscriptions: 0 }
    const traces: Array<{ readonly event: string; readonly detail?: Record<string, unknown> }> = []
    const context = createContext({
      model_fallback: { enabled: true, max_retries: 2 },
      disabled_hooks: ["model_fallback"],
    }, calls)

    // when
    const registration = await registerConfiguredModelFallback(context, {
      directory: process.cwd(),
      gate: createSessionDispatchGate(),
      registry: new TaskRegistry(),
      trace: (event, detail) => traces.push(detail === undefined ? { event } : { event, detail }),
    })

    // then
    expect(calls.subscriptions).toBe(0)
    expect(calls.contextHooks).toBe(0)
    expect(traces).toContainEqual({
      event: "omo.model-fallback.disabled",
      detail: { reason: "listed in disabled_hooks" },
    })
    registration.dispose()
  })

  test("#given model fallback is enabled without a retry override #when registration runs #then one event pump is installed with the default retry bound", async () => {
    // given
    const calls = { contextHooks: 0, subscriptions: 0 }
    const traces: Array<{ readonly event: string; readonly detail?: Record<string, unknown> }> = []
    const context = createContext({ model_fallback: { enabled: true } }, calls)

    // when
    const registration = await registerConfiguredModelFallback(context, {
      directory: process.cwd(),
      gate: createSessionDispatchGate(),
      registry: new TaskRegistry(),
      trace: (event, detail) => traces.push(detail === undefined ? { event } : { event, detail }),
    })

    // then
    expect(calls.subscriptions).toBe(1)
    expect(calls.contextHooks).toBe(1)
    expect(traces).toContainEqual({
      event: "omo.model-fallback.registered",
      detail: { maxRetries: 1 },
    })
    registration.dispose()
  })

  test("#given Session.Info omits the active agent and model #when the context hook recorded them before a quota failure #then fallback still switches", async () => {
    // given
    let resolveSwitch: ((model: { readonly providerID: string; readonly id: string }) => void) | undefined
    const switched = new Promise<{ readonly providerID: string; readonly id: string }>((resolve) => {
      resolveSwitch = resolve
    })
    const context: ModelFallbackContext = {
      options: { model_fallback: { enabled: true } },
      event: {
        subscribe: async function* () {
          yield {
            type: "session.execution.failed",
            data: {
              sessionID: "session-main",
              error: { type: "ProviderError", message: "Subscription quota exhausted", status: 429 },
            },
          }
        },
      },
      session: {
        get: async () => ({}),
        hook: async (_event, handler) => {
          await handler({
            sessionID: "session-main",
            agent: "oracle",
            model: { providerID: "openai", id: "gpt-5.6-sol" },
          })
        },
        switchModel: async ({ model }) => {
          resolveSwitch?.(model)
        },
        synthetic: async () => undefined,
      },
    }

    // when
    const registration = await registerConfiguredModelFallback(context, {
      directory: process.cwd(),
      gate: createSessionDispatchGate(),
      registry: new TaskRegistry(),
    })
    const model = await switched

    // then
    expect(`${model.providerID}/${model.id}`).not.toBe("openai/gpt-5.6-sol")
    registration.dispose()
  })
})
