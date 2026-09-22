import type { SessionDispatchGate } from "./session-dispatch-gate"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Cause, Effect, Queue, Scope } from "effect"

export type NativeIdlePorts = {
  readonly run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>
  readonly sessionExists: (sessionID: string) => Promise<boolean>
  readonly dispatch: (sessionID: string, prompt: string) => Promise<void>
  readonly settle: () => Promise<void>
}

type NativeIdleJob = Effect.Effect<void, never>
export type NativeIdleDispatch = (sessionID: string, prompt: string) => Effect.Effect<void, unknown>

export function createNativeIdlePorts(ctx: { readonly session: Pick<Context["session"], "get" | "synthetic"> }, dispatch?: NativeIdleDispatch): Effect.Effect<NativeIdlePorts, never, Scope.Scope> {
  return Effect.gen(function* () {
    const jobs = yield* Queue.unbounded<NativeIdleJob>()
    const scope = yield* Effect.scope
    const pending = new Set<(error: unknown) => void>()
    let closed = false
    const request = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => new Promise((resolve, reject) => {
      if (closed) { reject(new Error("Idle continuation scope closed")); return }
      const fail = (error: unknown): void => {
        pending.delete(fail)
        reject(error)
      }
      pending.add(fail)
      const accepted = Queue.offerUnsafe(jobs, effect.pipe(
        Effect.map((value) => Effect.sync(() => { pending.delete(fail); resolve(value) })),
        Effect.flatten,
        Effect.catchCause((cause) => Effect.sync(() => fail(Cause.squash(cause)))),
      ))
      if (!accepted) fail(new Error("Idle continuation queue closed"))
    })
    yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
      yield* Effect.forkIn(yield* Queue.take(jobs), scope)
    })))
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      closed = true
      for (const fail of pending) fail(new Error("Idle continuation scope closed"))
      pending.clear()
      yield* Queue.shutdown(jobs)
    }))
    return {
      run: request,
      sessionExists: (sessionID) => request(ctx.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(Effect.map(() => true))),
      dispatch: (sessionID, prompt) => request(dispatch ? dispatch(sessionID, prompt)
        : ctx.session.synthetic({ sessionID: Session.ID.make(sessionID), text: prompt, delivery: "queue", resume: true }).pipe(Effect.asVoid)),
      settle: () => request(Effect.sleep("150 millis")),
    }
  })
}

export type IdleInjectorEvent = {
  readonly type: string
  readonly id?: string
  readonly data?: unknown
}

export type IdleResolution = {
  readonly prompt: string
  readonly detail?: Record<string, unknown>
}

export type IdleInjectorTrace = (event: string, detail?: Record<string, unknown>) => void

export type IdleInjectorDependencies = {
  // Trace prefix, e.g. "omo.goal". Emits `<name>.continuation-injected` and
  // `<name>.continuation-failed`.
  readonly name: string
  // The plugin-wide instance. Two injectors holding separate gates would each
  // admit a dispatch on the same idle edge, which is the double injection the
  // gate exists to prevent.
  readonly gate: SessionDispatchGate
  readonly sessionExists: (sessionID: string) => Promise<boolean>
  readonly dispatch: (sessionID: string, prompt: string) => Promise<void>
  readonly settle: () => Promise<void>
  // Decides whether this session still wants an injection, and what to inject.
  // Called twice per idle edge: once before reserving as a cheap filter, then
  // again after settling as the authoritative check, because the session may
  // have changed while the settle delay elapsed.
  readonly resolve: (sessionID: string) => IdleResolution | null
  readonly onSessionDeleted?: (sessionID: string) => void
  readonly trace?: IdleInjectorTrace
}

export type IdleInjector = ReturnType<typeof createIdleInjector>

/**
 * Shared machinery for a feature that injects into a session when it goes idle.
 *
 * Goal and the todo continuation enforcer differ only in the resolve predicate,
 * the prompt it produces, and the trace name. Everything else, the busy/idle
 * activity tracking, the settle delay, the post-settle re-checks and the gated
 * dispatch, is identical, so it lives here rather than in each feature.
 */
export function createIdleInjector(dependencies: IdleInjectorDependencies) {
  const { dispatch, gate, name, onSessionDeleted, resolve, sessionExists, settle, trace } = dependencies
  const activity = new Map<string, "busy" | "idle">()
  let disposed = false

  async function inject(sessionID: string): Promise<void> {
    if (disposed || resolve(sessionID) === null) return

    // Errors are caught inside the body so the gate sees a normal return and
    // still releases; a rejection here would escape into the event pump.
    await gate.run(sessionID, async (markDispatched) => {
      try {
        await settle()
        if (disposed || activity.get(sessionID) !== "idle") return
        if (!await sessionExists(sessionID)) return
        if (disposed || activity.get(sessionID) !== "idle") return
        const resolution = resolve(sessionID)
        if (resolution === null) return

        markDispatched()
        await dispatch(sessionID, resolution.prompt)
        trace?.(`${name}.continuation-injected`, { sessionID, ...resolution.detail })
      } catch (error) {
        trace?.(`${name}.continuation-failed`, {
          sessionID,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  return {
    async handleEvent(event: IdleInjectorEvent): Promise<void> {
      if (disposed) return
      const sessionID = sessionIDFromEvent(event)
      if (sessionID === undefined) return

      switch (event.type) {
        case "session.input.admitted":
        case "session.execution.started":
          activity.set(sessionID, "busy")
          return
        case "session.idle":
        case "session.execution.succeeded":
          activity.set(sessionID, "idle")
          await inject(sessionID)
          return
        case "session.execution.failed":
        case "session.execution.interrupted":
          activity.set(sessionID, "idle")
          return
        case "session.deleted":
          activity.delete(sessionID)
          gate.release(sessionID)
          onSessionDeleted?.(sessionID)
          return
        default:
          return
      }
    },

    hasReservation(sessionID: string): boolean {
      return gate.isReserved(sessionID)
    },

    // The gate is shared, so disposing one injector must not clear it. Doing so
    // would free a reservation another injector is holding.
    dispose(): void {
      disposed = true
      activity.clear()
    },
  }
}

function sessionIDFromEvent(event: IdleInjectorEvent): string | undefined {
  if (typeof event.data === "object" && event.data !== null && "sessionID" in event.data) {
    const sessionID = event.data.sessionID
    if (typeof sessionID === "string") return sessionID
  }
  return event.type === "session.deleted" && typeof event.id === "string" ? event.id : undefined
}
