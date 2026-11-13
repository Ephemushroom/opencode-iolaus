import { DateTime, Effect } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"

type SessionApi = Pick<Context["session"], "wait" | "list" | "interrupt">
type Page = Effect.Success<ReturnType<SessionApi["list"]>>
type Info = Page["data"][number]

const PAGE = 100
/** The host's own subagent depth limit is far lower; this only bounds the walk. */
const MAX_DEPTH = 8
/** An interrupted session only has cleanup left; a stop never waits longer than this for one level. */
const STOP_WAIT = "5 seconds"

const millis = (value: unknown) => typeof value === "number" ? value : DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : 0

/** `time.busy` is the start of the latest execution and `time.idle` the end of the latest finished one. */
const executing = (info: Info) => millis(info.time.busy) > millis(info.time.idle)

const stamp = (tree: readonly Info[]) => tree.map((info) => `${info.id}:${millis(info.time.busy)}:${millis(info.time.idle)}`).sort().join(",")

/**
 * A host subagent always runs in the background: its parent goes idle while it works and is woken by its report.
 * So "the session is idle" no longer means "the session is done". These helpers read a session together with the
 * subagent sessions below it. Background shells are not followed: one that never exits would never settle.
 */
export function createQuiescence(session: SessionApi) {
  const children = (parentID: string) => Effect.gen(function* () {
    const found: Info[] = []
    let cursor: Page["cursor"]["next"] = undefined
    do {
      const page: Page = yield* session.list({ parentID: parentID as never, limit: PAGE, ...(cursor ? { cursor } : {}) })
      found.push(...page.data)
      cursor = page.data.length === PAGE ? page.cursor.next : undefined
    } while (cursor)
    return found
  })

  /** The subagent sessions below `sessionID`, one array per generation: its children, then theirs. */
  const levels = (sessionID: string) => Effect.gen(function* () {
    const found: Info[][] = []
    let level = [sessionID]
    for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
      const next = (yield* Effect.forEach(level, children)).flat()
      if (next.length) found.push(next)
      level = next.map((info) => String(info.id))
    }
    return found
  })

  const idle = (tree: readonly Info[]) => Effect.forEach(tree, (info) => Effect.ignore(session.wait({ sessionID: info.id })), { discard: true })

  return {
    /** Whether a subagent below the session is executing right now. Does not wait. */
    busy: (sessionID: string) => levels(sessionID).pipe(Effect.map((tree) => tree.flat().some(executing))),

    /**
     * Resolves once the session and every subagent below it are idle and nothing ran in between. A child's report
     * is admitted to its parent before the child's own wait returns, so waiting on the children and then on the
     * session again sees the turn that report starts.
     */
    settle: (sessionID: string) => Effect.gen(function* () {
      for (;;) {
        yield* session.wait({ sessionID: sessionID as never })
        const before = (yield* levels(sessionID)).flat()
        if (!before.length) return
        yield* idle(before)
        yield* session.wait({ sessionID: sessionID as never })
        if (stamp(before) === stamp((yield* levels(sessionID)).flat())) return
      }
    }),

    /**
     * Interrupts the session and every subagent below it. The host leaves a session's subagents running when the
     * session is interrupted, and a stopped child's report wakes its parent. So each generation stops and settles
     * before the one above it, the session goes last, and the walk repeats until a pass finds nothing to stop.
     */
    stop: (sessionID: string) => Effect.gen(function* () {
      for (let pass = 0; pass < MAX_DEPTH; pass++) {
        let stopped = false
        for (const level of (yield* levels(sessionID)).reverse()) {
          const results = yield* Effect.forEach(level, (info) => session.interrupt({ sessionID: info.id, resume: false }).pipe(
            Effect.map((result) => result.interrupted), Effect.catch(() => Effect.succeed(false))))
          if (!results.some(Boolean)) continue
          stopped = true
          yield* idle(level).pipe(Effect.timeoutOption(STOP_WAIT))
        }
        yield* session.interrupt({ sessionID: sessionID as never, resume: false })
        if (!stopped) return
      }
    }),
  }
}
