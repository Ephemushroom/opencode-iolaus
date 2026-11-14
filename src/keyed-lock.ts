import { Effect, Semaphore } from "effect"

export interface KeyedLock {
  /** Runs `task` while holding the one permit of `key`; other keys run concurrently. */
  readonly withLock: <A, E, R>(key: string, task: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Keys currently held or waited on. Zero when nothing uses the lock. */
  readonly size: () => number
}

/**
 * One permit per key, created when a task uses the key and dropped once nothing holds or waits on
 * it, so a long-lived process that touches a key per run, notice or session does not keep every
 * semaphore it ever needed.
 */
export function createKeyedLock(): KeyedLock {
  const entries = new Map<string, { readonly permit: Semaphore.Semaphore; users: number }>()
  return {
    // The key is registered and its release installed with interruption masked, so a caller interrupted the
    // moment it has registered still releases the key; waiting for the permit and the task stay interruptible.
    withLock: (key, task) => Effect.uninterruptibleMask((restore) => Effect.suspend(() => {
      let entry = entries.get(key)
      if (!entry) {
        entry = { permit: Semaphore.makeUnsafe(1), users: 0 }
        entries.set(key, entry)
      }
      const current = entry
      current.users += 1
      return restore(current.permit.withPermit(task)).pipe(Effect.ensuring(Effect.sync(() => {
        current.users -= 1
        if (current.users === 0 && entries.get(key) === current) entries.delete(key)
      })))
    })),
    size: () => entries.size,
  }
}
