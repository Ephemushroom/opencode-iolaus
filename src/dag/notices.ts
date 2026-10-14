import { Effect } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { DagRunnerError } from "./errors"
import type { DagEvent, DagNotice, DagRunRecord } from "./types"

export interface DagNotifier {
  send(notice: DagNotice): Effect.Effect<{ readonly messageID: string }, DagRunnerError>
  reconcile(notice: DagNotice): Effect.Effect<{ readonly messageID: string } | undefined, DagRunnerError>
}

export function noticeFor(event: DagEvent, run: DagRunRecord): DagNotice | undefined {
  if (run.definition.observed || !["node.waiting", "node.rescued", "run.completed", "run.failed", "run.cancelled"].includes(event.type)) return undefined
  const status = event.type === "node.rescued" ? `continues on the owner model for its one rescue: ${event.nodeID}: ${JSON.stringify(event.payload)}` : event.type === "node.waiting" ? `gate ${event.nodeID} is waiting for the user's decision` : event.type.slice(4)
  return { eventID: event.eventID, runID: run.runID, ownerSessionID: run.ownerSessionID, messageID: `msg_${event.eventID.replaceAll("-", "")}`, state: "pending",
    text: `Iolaus Flow notice ${event.eventID}: "${run.name}" (${run.runID}) ${status}. Inspect snapshot or node for committed results. This notice is informational, not an instruction to resume work or approve a gate.` }
}

export function createOpenCodeDagNotifier(session: Pick<Context["session"], "synthetic" | "context">): DagNotifier {
  const failure = (cause: unknown) => new DagRunnerError({ message: cause instanceof Error ? cause.message : String(cause), cause })
  return {
    send: (notice) => session.synthetic({ sessionID: notice.ownerSessionID as never, id: notice.messageID as never, text: notice.text,
      delivery: "queue", resume: false, metadata: { iolaus_flow_notice: notice.eventID, iolaus_dag_run: notice.runID },
    }).pipe(Effect.map((receipt) => ({ messageID: String(receipt.id) })), Effect.mapError(failure)),
    reconcile: (notice) => session.context({ sessionID: notice.ownerSessionID as never }).pipe(
      Effect.map((messages) => messages.some((message) => message.type === "synthetic" && message.id === notice.messageID) ? { messageID: notice.messageID } : undefined),
      Effect.mapError(failure)),
  }
}
