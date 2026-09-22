import type { Context } from "@opencode/plugin/promise/plugin"

import { getBtwMetadata } from "./metadata"

/**
 * Tools a BTW side conversation must never reach. Mirrors v1's
 * BTW_DELEGATION_TOOLS: a side conversation exists to answer questions, not
 * to spawn work or mutate shared state.
 */
export const BTW_BLOCKED_TOOLS = new Set([
  "task",
  "btw_start",
  "btw_reply",
  "monitor_start",
])

/** Minimal structural view of the context hook's message array. */
type ContextMessage = {
  readonly role: string
  readonly metadata?: Record<string, unknown>
}

/**
 * Registers the context-hook guard that strips delegation tools from BTW side
 * sessions. Detection reads the BTW metadata the plugin itself attached to
 * the prompt: v2 carries prompt `metadata` through to the message, so the
 * first user message in the side session is tagged `omo_btw` on every turn.
 */
export async function registerBtwToolGuard(
  ctx: Context,
  trace?: (event: string, detail?: Record<string, unknown>) => void,
): Promise<void> {
  await ctx.session.hook("context", (event) => {
    const messages = event.messages as readonly ContextMessage[]
    if (!isBtwSideSession(messages)) return
    const removed: string[] = []
    for (const name of Object.keys(event.tools)) {
      if (BTW_BLOCKED_TOOLS.has(name)) {
        delete event.tools[name]
        removed.push(name)
      }
    }
    if (removed.length > 0) {
      trace?.("omo.btw.tools-blocked", { sessionID: event.sessionID, removed })
    }
  })
}

function isBtwSideSession(messages: readonly ContextMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role !== "user") continue
    // First user message from the end: the BTW tag rides the side session's
    // very first prompt.
    return getBtwMetadata(message.metadata) !== undefined
  }
  return false
}
