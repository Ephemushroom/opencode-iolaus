import { Effect, Semaphore } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionStateStore } from "./database"
import type { DagController } from "./dag/controller"
import type { DagRunRecord } from "./dag/types"
import { readGoal } from "./roles/goal"
import { readRole } from "./roles/register"

type Trace = (event: string, data?: Record<string, unknown>) => void

/** The session instruction entry key; the host renders it as `<context key="iolaus.state">`. */
export const STATE_ENTRY_KEY = "iolaus.state"

const TERMINAL = new Set(["completed", "failed", "cancelled"])

/**
 * The Iolaus state a session's model must keep knowing: its goal, its role, and every
 * unfinished DAG run it owns with the nodes that are waiting on it. All of it lives in
 * iolaus.db anyway; the entry keeps the model from forgetting it exists. Undefined when
 * there is nothing to keep.
 */
export function sessionState(goal: ReturnType<typeof readGoal>, role: ReturnType<typeof readRole>, runs: readonly DagRunRecord[]): string | undefined {
  const lines: string[] = []
  if (goal && goal.status !== "complete") lines.push(`Session goal (${goal.status}${goal.reason ? `: ${goal.reason}` : ""}): ${goal.objective}`)
  if (role) lines.push(`Session role: ${role.role}${role.plan ? ` for plan "${role.plan}"` : ""}${role.runID ? ` (run ${role.runID})` : ""}`)
  for (const run of runs) {
    if (run.definition.observed || TERMINAL.has(run.status)) continue
    const open = run.nodes.filter((node) => !["completed", "reused", "skipped"].includes(node.status))
      .map((node) => `${node.definition.id}=${node.status}${node.status === "waiting_approval" ? " (the user decides)" : ""}`)
    lines.push(`DAG run ${run.runID} "${run.name}" is ${run.status}${run.definition.directory ? ` in ${run.definition.directory}` : ""}; open nodes: ${open.join(", ") || "none"}`)
  }
  if (!lines.length) return undefined
  return `Iolaus state of this session, kept current by the plugin; work in these runs continues in the background. Operate the runs with iolaus_flow (snapshot, node, retry; optional blocking wait; approve or reject only on the user's word). Forward user supplements with steer only to eligible active nodes, preserving their identity.
${lines.map((line) => `- ${line}`).join("\n")}`
}

type Instructions = Context["session"]["instructions"]

/**
 * Keeps the `iolaus.state` instruction entry of a session equal to `sessionState`. The host
 * announces a change at the session's next step boundary without waking it, keeps the entry
 * through compaction and revert, and treats an unchanged put or a missing remove as a no-op.
 * Refreshes of one session are serialized so a stale snapshot never lands last.
 */
export function createStateSync(instructions: Instructions, host: { readonly controller: DagController; readonly state: SessionStateStore; readonly trace: Trace }) {
  const locks = new Map<string, Semaphore.Semaphore>()
  const lock = (sessionID: string) => {
    let permit = locks.get(sessionID)
    if (!permit) locks.set(sessionID, permit = Semaphore.makeUnsafe(1))
    return permit
  }
  const refresh = (sessionID: string): Effect.Effect<void> => lock(sessionID).withPermits(1)(Effect.gen(function* () {
    const runs = yield* host.controller.list(sessionID)
    const text = sessionState(readGoal(host.state, sessionID), readRole(host.state, sessionID), runs)
    if (text === undefined) yield* instructions.entry.remove({ sessionID: sessionID as never, key: STATE_ENTRY_KEY })
    else yield* instructions.entry.put({ sessionID: sessionID as never, key: STATE_ENTRY_KEY, value: text })
  })).pipe(Effect.catchCause((cause) => Effect.sync(() => host.trace("iolaus.state.failed", { sessionID, cause: String(cause).slice(0, 300) }))))
  return { refresh }
}
