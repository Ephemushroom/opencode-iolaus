const DEFAULT_POST_DISPATCH_HOLD_MS = 2_000

export type SessionDispatchGateOptions = {
  // Callers injecting into a live parent session must leave this non-zero.
  // Zero releases the reservation the instant the body returns, which reopens
  // the window that the hold exists to close: the harness has accepted the
  // message but has not yet flipped the session back to busy, so the next idle
  // observer sees an idle session and injects again.
  readonly postDispatchHoldMs?: number
  readonly now?: () => number
}

export type SessionDispatchOutcome = "ran" | "blocked"

export type SessionDispatchGate = ReturnType<typeof createSessionDispatchGate>

type Reservation = {
  readonly token: symbol
  readonly expiresAt?: number
}

/**
 * Mutual exclusion for features that inject into a session on an observed edge.
 *
 * The bug class this closes is N observers of ONE edge, not N distinct events.
 * Features that emit per-item notifications must NOT use this: a per-session
 * reservation would drop their second concurrent item.
 *
 * One instance must be shared by every feature that injects on the same edge.
 * Separate instances each admit one dispatch, which is the double-injection
 * this is meant to prevent.
 */
export function createSessionDispatchGate(options: SessionDispatchGateOptions = {}) {
  const { postDispatchHoldMs = DEFAULT_POST_DISPATCH_HOLD_MS, now = () => Date.now() } = options
  const reservations = new Map<string, Reservation>()
  let disposed = false

  function activeReservation(sessionID: string): Reservation | undefined {
    const reservation = reservations.get(sessionID)
    if (reservation?.expiresAt !== undefined && reservation.expiresAt <= now()) {
      reservations.delete(sessionID)
      return undefined
    }
    return reservation
  }

  return {
    /**
     * Reserves the session, then runs `body`. Returns "blocked" without running
     * `body` when another caller already holds the session.
     *
     * `body` calls `markDispatched` immediately before it writes to the
     * session, which is what arms the post-dispatch hold. A body that returns
     * without calling it releases the reservation at once, so an aborted
     * attempt does not lock the session out.
     */
    async run(
      sessionID: string,
      body: (markDispatched: () => void) => Promise<void>,
    ): Promise<SessionDispatchOutcome> {
      if (disposed || activeReservation(sessionID) !== undefined) return "blocked"

      // Reserved synchronously: any await before this point would let a
      // concurrent caller observe an unreserved session and pass the check too.
      const reservation: Reservation = { token: Symbol(sessionID) }
      reservations.set(sessionID, reservation)

      let dispatched = false
      try {
        await body(() => {
          dispatched = true
        })
      } finally {
        // Token identity, not presence: a reservation taken after ours expired
        // belongs to a newer caller and must not be freed by our release.
        if (reservations.get(sessionID)?.token === reservation.token) {
          if (dispatched && postDispatchHoldMs > 0) {
            reservations.set(sessionID, { ...reservation, expiresAt: now() + postDispatchHoldMs })
          } else {
            reservations.delete(sessionID)
          }
        }
      }
      return "ran"
    },

    isReserved(sessionID: string): boolean {
      return activeReservation(sessionID) !== undefined
    },

    release(sessionID: string): void {
      reservations.delete(sessionID)
    },

    dispose(): void {
      disposed = true
      reservations.clear()
    },
  }
}
