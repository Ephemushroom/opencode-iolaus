import { Effect, type Scope } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionStateStore } from "./database"
import type { DagController } from "./dag/controller"
import type { DagRunRecord } from "./dag/types"
import { readGoal } from "./roles/goal"
import { readRole } from "./roles/register"

type Trace = (event: string, data?: Record<string, unknown>) => void

const TERMINAL = new Set(["completed", "failed", "cancelled"])

/**
 * The Iolaus state a session's model must still know after compaction: its goal,
 * its role, and every unfinished DAG run it owns with the nodes that are waiting on
 * it. All of it lives in iolaus.db and survives anyway; this keeps the model from
 * forgetting it exists. Undefined when there is nothing to keep.
 */
export function compactionState(goal: ReturnType<typeof readGoal>, role: ReturnType<typeof readRole>, runs: readonly DagRunRecord[]): string | undefined {
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
  return `<iolaus-compaction-state>
Keep these facts verbatim in the summary; they describe work that continues after it. Operate the runs with iolaus_dag (wait, snapshot, retry; approve or reject only on the user's word).
${lines.map((line) => `- ${line}`).join("\n")}
</iolaus-compaction-state>`
}

/** Adds the session's live Iolaus state to every compaction request, so the summary carries it forward. */
export function registerCompaction(ctx: Context, host: { readonly controller: DagController; readonly state: SessionStateStore; readonly trace: Trace }): Effect.Effect<void, never, Scope.Scope> {
  return ctx.session.hook("compaction", (event) => Effect.gen(function* () {
    const sessionID = String(event.sessionID)
    const runs = yield* host.controller.list(sessionID)
    const text = compactionState(readGoal(host.state, sessionID), readRole(host.state, sessionID), runs)
    if (!text) return
    event.system.push({ type: "text", text })
    host.trace("iolaus.compaction.preserved", { sessionID, runs: runs.filter((run) => !run.definition.observed && !TERMINAL.has(run.status)).length })
  }).pipe(Effect.catchCause((cause) => Effect.sync(() => host.trace("iolaus.compaction.failed", { cause: String(cause).slice(0, 300) })))))
}
