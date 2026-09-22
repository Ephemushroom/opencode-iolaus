import { describe, expect, test } from "bun:test"

import { MonitorDelivery } from "./delivery"
import { MonitorCapacityError, MonitorFilterError, MonitorManager, type MonitorRuntimeConfig } from "./manager"
import type { SpawnFunction } from "./process"

const BASE_CONFIG: MonitorRuntimeConfig = {
  enabled: true,
  live_mode_enabled: false,
  allowed_commands: ["fake"],
  max_monitors_per_session: 2,
  max_runtime_ms: 60_000,
  batch_max_lines: 2,
  batch_max_bytes: 1_048_576,
  flush_interval_ms: 0,
  ring_max_lines: 100,
  line_max_bytes: 8_192,
  pattern_max_length: 512,
}

type SyntheticCall = {
  sessionID: string
  text: string
  metadata: Record<string, unknown>
  delivery: string
}

type CapturingCtx = { session: { synthetic: (input: Record<string, unknown>) => Promise<void> } }

function createCapturingCtx(): { ctx: CapturingCtx; calls: SyntheticCall[] } {
  const calls: SyntheticCall[] = []
  const ctx = {
    session: {
      synthetic: async (input: Record<string, unknown>): Promise<void> => {
        calls.push({
          sessionID: String(input.sessionID),
          text: String(input.text),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
          delivery: String(input.delivery),
        })
      },
    },
  }
  return { ctx, calls }
}

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function fakeSpawn(stdout: readonly string[], opts?: { exitCode?: number }): { spawn: SpawnFunction; killed: string[] } {
  const killed: string[] = []
  const spawn: SpawnFunction = () => ({
    exited: Promise.resolve(opts?.exitCode ?? 0),
    stdout: streamOf(stdout),
    stderr: streamOf([]),
    pid: undefined,
    signalCode: null,
  })
  return { spawn, killed }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("MonitorManager", () => {
  describe("#given a monitor whose output matches the pattern", () => {
    describe("#when the process writes lines", () => {
      test("#then the matching lines are delivered to the parent session as a queued synthetic message", async () => {
        const { ctx, calls } = createCapturingCtx()
        const { spawn } = fakeSpawn(["ERROR one\nfine\nERROR two\n"])
        const manager = new MonitorManager({
          config: BASE_CONFIG,
          delivery: new MonitorDelivery({ ctx }),
          spawnDeps: { spawn },
        })

        await manager.start({ command: "fake", parentSessionId: "ses_1", matchPattern: "ERROR" })
        await settle()

        expect(calls.length).toBeGreaterThan(0)
        expect(calls[0]?.sessionID).toBe("ses_1")
        expect(calls[0]?.delivery).toBe("queue")
        expect(calls[0]?.text).toContain("ERROR one")
      })

      test("#then non-matching lines are not delivered but stay queryable", async () => {
        const { ctx, calls } = createCapturingCtx()
        const { spawn } = fakeSpawn(["ERROR one\nquiet line\n"])
        const manager = new MonitorManager({
          config: BASE_CONFIG,
          delivery: new MonitorDelivery({ ctx }),
          spawnDeps: { spawn },
        })

        const record = await manager.start({ command: "fake", parentSessionId: "ses_1", matchPattern: "ERROR" })
        await settle()

        const delivered = calls.map((call) => call.text).join("\n")
        expect(delivered).not.toContain("quiet line")
        const unmatched = manager.getOutput(record.id, { stream: "unmatched" })
        expect(unmatched?.lines.map((line) => line.text)).toContain("quiet line")
      })
    })
  })

  describe("#given the per-session monitor cap is reached", () => {
    describe("#when another monitor is started", () => {
      test("#then it is refused with the limit named", async () => {
        const { ctx } = createCapturingCtx()
        // A process that never ends, so the started monitors stay running.
        const spawn: SpawnFunction = () => ({
          exited: new Promise<number>(() => {}),
          stdout: new ReadableStream<Uint8Array>({ start() {} }),
          stderr: new ReadableStream<Uint8Array>({ start() {} }),
          pid: undefined,
          signalCode: null,
        })
        const manager = new MonitorManager({
          config: { ...BASE_CONFIG, max_monitors_per_session: 1 },
          delivery: new MonitorDelivery({ ctx }),
          spawnDeps: { spawn },
        })

        await manager.start({ command: "fake", parentSessionId: "ses_1" })

        await expect(manager.start({ command: "fake", parentSessionId: "ses_1" })).rejects.toBeInstanceOf(
          MonitorCapacityError,
        )
      })
    })
  })

  describe("#given an unsafe match pattern", () => {
    describe("#when the monitor is started", () => {
      test("#then it is rejected before any process is spawned", async () => {
        const { ctx } = createCapturingCtx()
        let spawnCalls = 0
        const spawn: SpawnFunction = () => {
          spawnCalls += 1
          return {
            exited: Promise.resolve(0),
            stdout: streamOf([]),
            stderr: streamOf([]),
            pid: undefined,
            signalCode: null,
          }
        }
        const manager = new MonitorManager({
          config: BASE_CONFIG,
          delivery: new MonitorDelivery({ ctx }),
          spawnDeps: { spawn },
        })

        await expect(
          manager.start({ command: "fake", parentSessionId: "ses_1", matchPattern: "(a+)+$" }),
        ).rejects.toBeInstanceOf(MonitorFilterError)
        expect(spawnCalls).toBe(0)
      })
    })
  })

  describe("#given monitors belonging to two sessions", () => {
    describe("#when one session is deleted", () => {
      test("#then only that session's monitors are reaped", async () => {
        const { ctx } = createCapturingCtx()
        const spawn: SpawnFunction = () => ({
          exited: new Promise<number>(() => {}),
          stdout: new ReadableStream<Uint8Array>({ start() {} }),
          stderr: new ReadableStream<Uint8Array>({ start() {} }),
          pid: undefined,
          signalCode: null,
        })
        const manager = new MonitorManager({
          config: BASE_CONFIG,
          delivery: new MonitorDelivery({ ctx }),
          spawnDeps: { spawn },
        })

        const mine = await manager.start({ command: "fake", parentSessionId: "ses_1" })
        const theirs = await manager.start({ command: "fake", parentSessionId: "ses_2" })

        await manager.stopSessionMonitors("ses_1")

        expect(manager.get(mine.id)?.status).toBe("stopped")
        expect(manager.get(theirs.id)?.status).toBe("running")
      })
    })
  })

  describe("#given a running monitor", () => {
    describe("#when the plugin disposes", () => {
      test("#then every monitor is stopped", async () => {
        const { ctx } = createCapturingCtx()
        const spawn: SpawnFunction = () => ({
          exited: new Promise<number>(() => {}),
          stdout: new ReadableStream<Uint8Array>({ start() {} }),
          stderr: new ReadableStream<Uint8Array>({ start() {} }),
          pid: undefined,
          signalCode: null,
        })
        const manager = new MonitorManager({
          config: BASE_CONFIG,
          delivery: new MonitorDelivery({ ctx }),
          spawnDeps: { spawn },
        })
        await manager.start({ command: "fake", parentSessionId: "ses_1" })

        await manager.shutdown()

        expect(manager.list("ses_1")).toHaveLength(0)
      })
    })
  })
})

describe("MonitorDelivery", () => {
  const record = { id: "mon_1", label: "build", status: "running", parentSessionId: "ses_1" }
  const batch = {
    monitorId: "mon_1",
    batchSeq: 1,
    lines: [{ stream: "stdout" as const, seq: 1, text: "line" }],
    stillRunning: true,
  }
  const counters = {
    totalLines: 1,
    matchedLines: 1,
    unmatchedLines: 0,
    droppedMatched: 0,
    droppedUnmatched: 0,
    bytesDropped: 0,
    lastSequence: 1,
  }

  describe("#given the same batch is delivered twice", () => {
    describe("#when the second delivery runs", () => {
      test("#then it is deduped so the session is not double-injected", async () => {
        const { ctx, calls } = createCapturingCtx()
        const delivery = new MonitorDelivery({ ctx })

        await delivery.deliver(record, batch, counters)
        await delivery.deliver(record, batch, counters)

        expect(calls).toHaveLength(1)
      })
    })
  })

  describe("#given two different monitors flush at the same moment", () => {
    describe("#when both deliver", () => {
      test("#then both land, because monitor output is a per-item notification and not a shared idle edge", async () => {
        const { ctx, calls } = createCapturingCtx()
        const delivery = new MonitorDelivery({ ctx })

        await Promise.all([
          delivery.deliver(record, batch, counters),
          delivery.deliver({ ...record, id: "mon_2" }, { ...batch, monitorId: "mon_2" }, counters),
        ])

        expect(calls).toHaveLength(2)
      })
    })
  })

  describe("#given the harness rejects the synthetic message", () => {
    describe("#when the same batch is retried", () => {
      test("#then the retry is allowed, because a failed delivery must not poison the dedupe set", async () => {
        let attempts = 0
        const ctx = {
          session: {
            synthetic: async (): Promise<void> => {
              attempts += 1
              if (attempts === 1) throw new Error("session busy")
            },
          },
        }
        const delivery = new MonitorDelivery({ ctx })

        const first = await delivery.deliver(record, batch, counters)
        const second = await delivery.deliver(record, batch, counters)

        expect(first).toBe(false)
        expect(second).toBe(true)
      })
    })
  })
})
