import { classifyProviderExhaustionFallbackSignal } from "@oh-my-opencode/model-core"

import { nextFallbackModel } from "../../orchestration/child-session"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"

export type ModelFallbackEvent = {
  readonly type: string
  readonly data?: Readonly<Record<string, unknown>>
}

export type ModelFallbackSessionInfo = {
  readonly agent?: string
  readonly model?: {
    readonly providerID: string
    readonly id: string
  }
}

export type ModelFallbackTrace = (event: string, detail?: Record<string, unknown>) => void

export type ModelFallbackRuntimeOptions = {
  readonly gate: SessionDispatchGate
  readonly isManaged: (sessionID: string) => Promise<boolean>
  readonly maxRetries: number
  readonly getSession: (sessionID: string) => Promise<ModelFallbackSessionInfo>
  readonly switchModel: (sessionID: string, model: { readonly providerID: string; readonly id: string }) => Promise<void>
  readonly redispatch: (sessionID: string) => Promise<void>
  readonly trace?: ModelFallbackTrace
}

export type ModelFallbackRuntime = {
  readonly handleEvent: (event: ModelFallbackEvent) => Promise<void>
  readonly dispose: () => void
}

export function createModelFallbackRuntime(options: ModelFallbackRuntimeOptions): ModelFallbackRuntime {
  const { gate, getSession, maxRetries, redispatch, isManaged, switchModel, trace } = options
  const retryCounts = new Map<string, number>()
  const pending = new Map<string, symbol>()
  let disposed = false

  const exhausted = (sessionID: string, reason: string, detail: Record<string, unknown> = {}): void => {
    trace?.("omo.model-fallback.exhausted", {
      sessionID,
      reason,
      retries: retryCounts.get(sessionID) ?? 0,
      maxRetries,
      ...detail,
    })
  }

  const handleFailure = async (event: ModelFallbackEvent): Promise<void> => {
    const data = event.data
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return

    const signal = classifyProviderExhaustionFallbackSignal(data?.error)
    if (signal === undefined) return

    const retryCount = retryCounts.get(sessionID) ?? 0
    if (retryCount >= maxRetries) {
      exhausted(sessionID, "max_retries")
      return
    }

    if (pending.has(sessionID)) return
    const token = Symbol(sessionID)
    pending.set(sessionID, token)
    const current = () => !disposed && pending.get(sessionID) === token
    try {
      if (await isManaged(sessionID)) {
        trace?.("omo.model-fallback.skipped-child", { sessionID })
        return
      }
      if (!current()) return
      const outcome = await gate.run(sessionID, async (markDispatched) => {
        let session: ModelFallbackSessionInfo
        try {
          session = await getSession(sessionID)
        } catch (error) {
          exhausted(sessionID, "session_unavailable", {
            message: error instanceof Error ? error.message : String(error),
          })
          return
        }

        if (!current()) return
        const agent = session.agent
        const currentRef = session.model
        if (!agent || !currentRef?.providerID || !currentRef.id) {
          exhausted(sessionID, "session_model", { agent: agent ?? null })
          return
        }

        const currentModel = `${currentRef.providerID}/${currentRef.id}`
        const nextModel = nextFallbackModel(agent, currentModel)
        if (!nextModel) {
          exhausted(sessionID, "fallback_chain", { agent, currentModel })
          return
        }

        const slash = nextModel.indexOf("/")
        if (slash <= 0 || slash === nextModel.length - 1) {
          exhausted(sessionID, "fallback_model", { agent, currentModel, nextModel })
          return
        }
        const nextRef = { providerID: nextModel.slice(0, slash), id: nextModel.slice(slash + 1) }
        const nextRetryCount = retryCount + 1
        retryCounts.set(sessionID, nextRetryCount)
        trace?.("omo.model-fallback.triggered", {
          sessionID,
          agent,
          currentModel,
          nextModel,
          retry: nextRetryCount,
          signal,
        })

        await switchModel(sessionID, nextRef)
        if (!current()) return
        markDispatched()
        await redispatch(sessionID)
        trace?.("omo.model-fallback.switched", {
          sessionID,
          agent,
          previousModel: currentModel,
          model: nextModel,
          retry: nextRetryCount,
        })
      })
      if (outcome === "blocked") exhausted(sessionID, "dispatch_gate")
    } catch (error) {
      exhausted(sessionID, "switch_or_redispatch", {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (pending.get(sessionID) === token) pending.delete(sessionID)
    }
  }

  return {
    handleEvent: async (event) => {
      if (disposed) return
      const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined
      switch (event.type) {
        case "session.execution.succeeded":
        case "session.deleted":
          if (sessionID) { retryCounts.delete(sessionID); pending.delete(sessionID) }
          return
        case "session.execution.started":
        case "session.input.admitted":
        case "session.execution.interrupted":
          if (sessionID) pending.delete(sessionID)
          return
        case "session.execution.failed":
          await handleFailure(event)
          return
        default:
          return
      }
    },
    dispose: () => {
      disposed = true
      retryCounts.clear()
      pending.clear()
    },
  }
}
