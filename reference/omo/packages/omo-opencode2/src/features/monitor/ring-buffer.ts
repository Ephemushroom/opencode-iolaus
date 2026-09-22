import { createEmptyCounters, type MonitorCounters, type MonitorOutputResult, type OutputLine } from "./types"

type MonitorRingStream = "matched" | "unmatched" | "all"

interface MonitorRingQueryOptions {
  stream: MonitorRingStream
  since_sequence?: number
  limit?: number
}

/**
 * Bounded per-monitor line store. Drop accounting is load-bearing: monitor_output
 * consumers rely on it to know the window they are seeing is incomplete.
 */
export class MonitorRingBuffer {
  private readonly ringMaxLines: number
  private readonly matchedLines: OutputLine[] = []
  private readonly unmatchedLines: OutputLine[] = []
  private counters: MonitorCounters = createEmptyCounters()

  constructor(opts: { ringMaxLines: number }) {
    this.ringMaxLines = opts.ringMaxLines
  }

  push(line: OutputLine, matched: boolean): void {
    this.counters.totalLines += 1
    this.counters.lastSequence = Math.max(this.counters.lastSequence, line.seq)

    if (matched) {
      this.counters.matchedLines += 1
      this.pushBounded(this.matchedLines, line, true)
      return
    }

    this.counters.unmatchedLines += 1
    this.pushBounded(this.unmatchedLines, line, false)
  }

  query(opts: MonitorRingQueryOptions): MonitorOutputResult {
    const lines = this.selectLines(opts.stream)
    const since = opts.since_sequence
    const filtered = since === undefined ? lines : lines.filter((line) => line.seq > since)
    const limited = opts.limit === undefined ? filtered : filtered.slice(-opts.limit)
    return { lines: limited, counters: this.getCounters() }
  }

  getCounters(): MonitorCounters {
    return { ...this.counters }
  }

  private pushBounded(store: OutputLine[], line: OutputLine, matched: boolean): void {
    if (store.length >= this.ringMaxLines) {
      const dropped = store.shift()
      if (dropped) {
        if (matched) this.counters.droppedMatched += 1
        else this.counters.droppedUnmatched += 1
        this.counters.bytesDropped += dropped.text.length
      }
    }
    store.push(line)
  }

  private selectLines(stream: MonitorRingStream): OutputLine[] {
    if (stream === "matched") return [...this.matchedLines]
    if (stream === "unmatched") return [...this.unmatchedLines]
    return [...this.matchedLines, ...this.unmatchedLines].sort((left, right) => left.seq - right.seq)
  }
}
