import type { Context } from "@opencode/plugin/promise/plugin"

import { formatMonitorBatch, type EnvelopeRecord } from "./envelope"
import type { MonitorCounters, OutputBatch } from "./types"

export type DeliveryTrace = (event: string, detail?: Record<string, unknown>) => void

export type MonitorDispatchInput = {
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly metadata: Readonly<Record<string, string | number>>
  readonly delivery: "queue"
  readonly resume: false
}

export type MonitorDeliveryDeps = {
  readonly trace?: DeliveryTrace
} & (
  | { readonly dispatch: (input: MonitorDispatchInput) => Promise<unknown> }
  | { readonly ctx: Pick<Context, "session"> }
)

/**
 * Delivers monitor batches into the parent session.
 *
 * v1 had to hand-roll this: poll session busy/idle, inspect the last assistant
 * turn, detect a user message in progress, defer, retry, and dedupe through the
 * prompt-async gate. v2 offers a queued synthetic delivery mode, which hands the
 * message to the harness queue (the `session_pending` table) and lets core
 * decide when the session can accept it. That removes the entire defer ladder,
 * so none of it is ported.
 *
 * NOT behind `session-dispatch-gate`, deliberately. Per the gate doctrine in the
 * package AGENTS.md, the gate serializes N observers of ONE idle edge. Monitor
 * output is a per-item notification: two monitors flushing at the same moment
 * are two distinct events, and a per-session reservation would silently drop the
 * second and lose output. Same reasoning as background completion in index.ts.
 */
export class MonitorDelivery {
  private readonly deps: MonitorDeliveryDeps
  private readonly deliveredSources = new Set<string>()

  constructor(deps: MonitorDeliveryDeps) {
    this.deps = deps
  }

  async deliver(
    record: EnvelopeRecord & { parentSessionId: string },
    batch: OutputBatch,
    counters: MonitorCounters,
  ): Promise<boolean> {
    const source = `monitor-output:${record.id}:batch-${batch.batchSeq}`
    if (this.deliveredSources.has(source)) {
      this.deps.trace?.("omo.monitor.delivery-deduped", { monitorId: record.id, batchSeq: batch.batchSeq })
      return false
    }
    this.deliveredSources.add(source)

    const text = formatMonitorBatch(record, batch, counters)

    try {
      const input: MonitorDispatchInput = {
        sessionID: record.parentSessionId,
        text,
        description: `Monitor output: ${record.label}`,
        metadata: { source: "omo.monitor.output", monitor_id: record.id, batch_seq: batch.batchSeq },
        delivery: "queue",
        resume: false,
      }
      if ("dispatch" in this.deps) await this.deps.dispatch(input)
      else await this.deps.ctx.session.synthetic(input)
    } catch (error) {
      // A failed delivery must not poison the dedupe set, or the batch is lost.
      this.deliveredSources.delete(source)
      this.deps.trace?.("omo.monitor.delivery-failed", {
        monitorId: record.id,
        batchSeq: batch.batchSeq,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }

    this.deps.trace?.("omo.monitor.delivered", {
      monitorId: record.id,
      batchSeq: batch.batchSeq,
      lines: batch.lines.length,
      stillRunning: batch.stillRunning,
      bytes: text.length,
    })
    return true
  }

  forget(monitorId: string): void {
    for (const source of this.deliveredSources) {
      if (source.startsWith(`monitor-output:${monitorId}:`)) this.deliveredSources.delete(source)
    }
  }
}
