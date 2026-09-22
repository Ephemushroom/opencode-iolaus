import { MonitorBatcher, createRealScheduler, type SchedulerDeps } from "./batcher"
import { MonitorDelivery } from "./delivery"
import { createMonitorFilter } from "./filter"
import { LineStream } from "./line-stream"
import { spawnMonitoredProcess, type MonitoredProcess, type SpawnDeps } from "./process"
import { MonitorRingBuffer } from "./ring-buffer"
import type {
  MonitorId,
  MonitorOutputQuery,
  MonitorOutputResult,
  MonitorRecord,
  MonitorStartOpts,
  OutputBatch,
  OutputStreamType,
} from "./types"

export interface MonitorRuntimeConfig {
  readonly enabled: boolean
  readonly live_mode_enabled: boolean
  readonly allowed_commands?: readonly string[] | undefined
  readonly max_monitors_per_session: number
  readonly max_runtime_ms: number
  readonly batch_max_lines: number
  readonly batch_max_bytes: number
  readonly flush_interval_ms: number
  readonly ring_max_lines: number
  readonly line_max_bytes: number
  readonly pattern_max_length: number
}

export interface MonitorManagerDeps {
  readonly config: MonitorRuntimeConfig
  readonly delivery: MonitorDelivery
  readonly cwd?: string | undefined
  readonly scheduler?: SchedulerDeps
  readonly spawnDeps?: SpawnDeps
  readonly now?: () => Date
  readonly idFactory?: () => string
}

interface MonitorState {
  record: MonitorRecord
  process: MonitoredProcess
  ring: MonitorRingBuffer
  batcher: MonitorBatcher
  matches: (text: string) => boolean
  sequence: number
}

export class MonitorCapacityError extends Error {}
export class MonitorFilterError extends Error {}

let monitorCounter = 0

function defaultId(): string {
  monitorCounter += 1
  return `mon_${Date.now().toString(36)}_${monitorCounter}`
}

function deriveLabel(command: string, label: string | undefined): string {
  if (label && label.trim()) return label.trim()
  const head = command.trim().split(/\s+/, 1)[0] ?? "monitor"
  return head
}

/**
 * Owns every watcher process the plugin spawns, one registry per plugin
 * instance. Monitors are keyed by id and grouped by parent session so a session
 * teardown can reap exactly its own children.
 */
export class MonitorManager {
  private readonly deps: MonitorManagerDeps
  private readonly monitors = new Map<MonitorId, MonitorState>()

  constructor(deps: MonitorManagerDeps) {
    this.deps = deps
  }

  async start(opts: MonitorStartOpts): Promise<MonitorRecord> {
    const config = this.deps.config
    const running = this.list(opts.parentSessionId).filter((record) => record.status === "running")
    if (running.length >= config.max_monitors_per_session) {
      throw new MonitorCapacityError(
        `this session already has ${running.length} running monitor(s), the limit is ${config.max_monitors_per_session}. Stop one with monitor_stop first.`,
      )
    }

    const filterResult = createMonitorFilter(opts.matchPattern, { patternMaxLength: config.pattern_max_length })
    if (!filterResult.filter) {
      throw new MonitorFilterError(filterResult.error ?? "invalid match_pattern")
    }
    const matches = filterResult.filter.matches.bind(filterResult.filter)

    const id = (this.deps.idFactory ?? defaultId)()
    const record: MonitorRecord = {
      id,
      command: opts.command,
      label: deriveLabel(opts.command, opts.label),
      mode: opts.mode ?? "idle",
      parentSessionId: opts.parentSessionId,
      startedAt: (this.deps.now ?? (() => new Date()))(),
      status: "running",
      counters: {
        totalLines: 0,
        matchedLines: 0,
        unmatchedLines: 0,
        droppedMatched: 0,
        droppedUnmatched: 0,
        bytesDropped: 0,
        lastSequence: 0,
      },
    }

    const process = spawnMonitoredProcess(
      { command: opts.command, cwd: this.deps.cwd, maxRuntimeMs: config.max_runtime_ms },
      this.deps.spawnDeps ?? {},
    )

    const ring = new MonitorRingBuffer({ ringMaxLines: config.ring_max_lines })
    const batcher = new MonitorBatcher({
      batchMaxLines: config.batch_max_lines,
      batchMaxBytes: config.batch_max_bytes,
      flushIntervalMs: config.flush_interval_ms,
      scheduler: this.deps.scheduler ?? createRealScheduler(),
    })

    const state: MonitorState = { record, process, ring, batcher, matches, sequence: 0 }
    this.monitors.set(id, state)

    batcher.onBatch((batch) => {
      void this.dispatch(state, batch)
    })

    void this.pump(state, process.stdout, "stdout")
    void this.pump(state, process.stderr, "stderr")
    void this.observeExit(state)

    return { ...record, counters: { ...record.counters } }
  }

  async stop(id: MonitorId): Promise<void> {
    const state = this.monitors.get(id)
    if (!state) return
    state.record.status = "stopped"
    state.process.kill("SIGTERM")
    await this.finalize(state)
  }

  list(sessionId: string): MonitorRecord[] {
    const records: MonitorRecord[] = []
    for (const state of this.monitors.values()) {
      if (state.record.parentSessionId !== sessionId) continue
      records.push({ ...state.record, counters: state.ring.getCounters() })
    }
    return records
  }

  get(id: MonitorId): MonitorRecord | undefined {
    const state = this.monitors.get(id)
    if (!state) return undefined
    return { ...state.record, counters: state.ring.getCounters() }
  }

  getOutput(id: MonitorId, query: MonitorOutputQuery): MonitorOutputResult | undefined {
    const state = this.monitors.get(id)
    if (!state) return undefined
    return state.ring.query({
      stream: query.stream ?? "matched",
      since_sequence: query.since_sequence,
      limit: query.limit,
    })
  }

  /** Reaps every monitor a session owns. Called on session.deleted. */
  async stopSessionMonitors(sessionId: string): Promise<void> {
    const ids = [...this.monitors.entries()]
      .filter(([, state]) => state.record.parentSessionId === sessionId)
      .map(([id]) => id)
    await Promise.all(ids.map((id) => this.stop(id)))
  }

  /** Kills every child. Called on plugin dispose so nothing is orphaned. */
  async shutdown(): Promise<void> {
    const ids = [...this.monitors.keys()]
    await Promise.all(ids.map((id) => this.stop(id)))
    this.monitors.clear()
  }

  private async dispatch(state: MonitorState, batch: OutputBatch): Promise<void> {
    await this.deps.delivery.deliver(
      {
        id: state.record.id,
        label: state.record.label,
        status: state.record.status,
        parentSessionId: state.record.parentSessionId,
        ...(state.record.exitCode !== undefined ? { exitCode: state.record.exitCode } : {}),
        ...(state.record.signal !== undefined ? { signal: state.record.signal } : {}),
      },
      { ...batch, monitorId: state.record.id },
      state.ring.getCounters(),
    )
  }

  private async pump(
    state: MonitorState,
    stream: ReadableStream<Uint8Array>,
    streamType: OutputStreamType,
  ): Promise<void> {
    const lineStream = new LineStream({ lineMaxBytes: this.deps.config.line_max_bytes })
    const reader = stream.getReader()

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        for (const decoded of lineStream.feed(value).lines) {
          if (decoded.binary) continue
          this.ingest(state, streamType, decoded.text, decoded.truncated === true)
        }
      }
      for (const decoded of lineStream.flush().lines) {
        if (decoded.binary) continue
        this.ingest(state, streamType, decoded.text, decoded.truncated === true)
      }
    } catch {
      // A closed pipe is the normal end of a monitored process.
    } finally {
      reader.releaseLock()
    }
  }

  private ingest(state: MonitorState, stream: OutputStreamType, text: string, truncated: boolean): void {
    state.sequence += 1
    const line = { stream, seq: state.sequence, text, ...(truncated ? { truncated: true } : {}) }
    const matched = state.matches(text)
    state.ring.push(line, matched)
    state.record.counters = state.ring.getCounters()
    // Only matched lines are pushed at the model; the rest stay queryable via
    // monitor_output so a wide monitor cannot flood the context window.
    if (matched) state.batcher.push(line)
  }

  private async observeExit(state: MonitorState): Promise<void> {
    const result = await state.process.exited
    if (state.record.status !== "stopped") {
      state.record.status = result.signal === "SIGALRM" ? "failed" : "exited"
    }
    if (result.code !== null) state.record.exitCode = result.code
    if (result.signal !== null) state.record.signal = result.signal
    await this.finalize(state)
  }

  private async finalize(state: MonitorState): Promise<void> {
    if (state.batcher.pendingCount() > 0) {
      state.batcher.flushNow({ stillRunning: false })
    }
    state.batcher.destroy()
  }
}
