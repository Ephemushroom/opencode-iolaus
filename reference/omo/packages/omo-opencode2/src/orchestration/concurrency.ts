/**
 * Per-model concurrency limiter for the omo task engine.
 *
 * Mirrors v1's background-agent ConcurrencyManager semantics: a default limit
 * of 5 concurrent tasks per "<provider>/<model>" key, FIFO queueing when the
 * slot is full. Harness-neutral; no config schema dependency.
 */

export class ConcurrencyLimiter {
  private readonly counts = new Map<string, number>()
  private readonly queues = new Map<string, Array<() => void>>()

  constructor(private readonly defaultLimit = 5) {}

  /** The concurrency key for a model string ("<provider>/<model>"). */
  keyFor(model: string): string {
    return model
  }

  /** Resolves when a slot for the model key is free. */
  async acquire(model: string): Promise<void> {
    const key = this.keyFor(model)
    const current = this.counts.get(key) ?? 0
    if (current < this.defaultLimit) {
      this.counts.set(key, current + 1)
      return
    }

    return new Promise<void>((resolve) => {
      const queue = this.queues.get(key) ?? []
      queue.push(resolve)
      this.queues.set(key, queue)
    })
  }

  /** Releases a slot; wakes the next queued waiter for the key, if any. */
  release(model: string): void {
    const key = this.keyFor(model)
    const queue = this.queues.get(key) ?? []
    const next = queue.shift()
    if (next !== undefined) {
      next()
      return
    }
    const current = this.counts.get(key) ?? 0
    if (current > 0) this.counts.set(key, current - 1)
  }
}
