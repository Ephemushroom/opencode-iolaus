import { createEffect, createSignal, on, onCleanup } from "solid-js"

/**
 * Which sessions currently have one of this plugin's slot components mounted.
 *
 * The plugin API exposes no sidebar visibility accessor, but the host renders `sidebar.content` only while its sidebar is
 * shown (manual toggle or narrow layout hide it), so the mounted lifetime of our sidebar component is the sidebar's
 * visibility. Presence is keyed by session, so tabs never observe each other.
 */
export interface SlotPresence {
  /** Marks the slot mounted for a session and returns its release. Releasing twice is a no-op. */
  readonly enter: (sessionID: string) => () => void
  /** Whether the slot is mounted for a session. Reactive when read in a Solid computation. */
  readonly visible: (sessionID: string) => boolean
}

export function createSlotPresence(): SlotPresence {
  const [mounted, setMounted] = createSignal<ReadonlyMap<string, number>>(new Map())
  return {
    enter(sessionID) {
      setMounted((current) => adjust(current, sessionID, 1))
      let released = false
      return () => {
        if (released) return
        released = true
        setMounted((current) => adjust(current, sessionID, -1))
      }
    },
    visible: (sessionID) => (mounted().get(sessionID) ?? 0) > 0,
  }
}

/**
 * Keeps presence bound to a reactive session id for the lifetime of the calling component: slot inputs are reactive, so
 * a component may outlive the session it was created for. Each session is released before the next is entered and on
 * disposal, and `onChange` receives the id that actually changed. Only the id is tracked, so writes cannot loop.
 */
export function trackSlotPresence(presence: SlotPresence, sessionID: () => string, onChange?: (sessionID: string, mounted: boolean) => void): void {
  createEffect(on(sessionID, (id) => {
    const leave = presence.enter(id)
    onChange?.(id, true)
    onCleanup(() => { leave(); onChange?.(id, false) })
  }))
}

/** Counted presence per session; a count at zero drops the key. */
export function adjust(current: ReadonlyMap<string, number>, sessionID: string, delta: number): ReadonlyMap<string, number> {
  const next = new Map(current)
  const count = (next.get(sessionID) ?? 0) + delta
  if (count > 0) next.set(sessionID, count)
  else next.delete(sessionID)
  return next
}
