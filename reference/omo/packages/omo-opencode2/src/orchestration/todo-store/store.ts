import type { TodoItem } from "./types"

/**
 * Per-session todo state owned by the plugin.
 *
 * opencode2 ships no todo tool, so the adapter owns the list. State lives
 * outside the message stream and is re-injected into context on every
 * request, which makes it survive compaction by construction.
 */
export class TodoStore {
  private readonly sessions = new Map<string, TodoItem[]>()

  get(sessionID: string): readonly TodoItem[] {
    return this.sessions.get(sessionID) ?? []
  }

  set(sessionID: string, items: readonly TodoItem[]): void {
    if (items.length === 0) {
      this.sessions.delete(sessionID)
      return
    }
    this.sessions.set(sessionID, [...items])
  }

  clear(sessionID: string): void {
    this.sessions.delete(sessionID)
  }
}
