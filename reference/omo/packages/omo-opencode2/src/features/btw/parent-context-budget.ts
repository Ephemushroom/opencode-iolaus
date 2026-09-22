/**
 * Bounds the parent context injected into a BTW side conversation.
 * Ported from v1's btw-side/parent-context-budget.ts, adapted to the plain
 * text-pair records the v2 store reader produces (no SDK part arrays here:
 * the side conversation consumes a rendered transcript, not live parts).
 */

export const BTW_PARENT_CONTEXT_MAX_BYTES = 64 * 1024
export const BTW_PARENT_CONTEXT_MAX_MESSAGES = 64

export type TranscriptEntry = {
  readonly role: "user" | "assistant"
  readonly text: string
}

const encoder = new TextEncoder()

function serializedBytes(entries: readonly TranscriptEntry[]): number {
  return encoder.encode(JSON.stringify(entries)).byteLength
}

/**
 * Keeps the newest entries within both budgets. When the oldest surviving
 * entry alone exceeds the byte budget, it is tail-truncated (binary search on
 * kept characters) so the side conversation always sees at least one entry of
 * parent context.
 */
export function boundParentTranscript(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const candidates = entries.slice(-BTW_PARENT_CONTEXT_MAX_MESSAGES)
  const bounded: TranscriptEntry[] = []

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index]
    if (entry === undefined) continue
    if (serializedBytes([entry, ...bounded]) <= BTW_PARENT_CONTEXT_MAX_BYTES) {
      bounded.unshift(entry)
      continue
    }
    if (bounded.length === 0) {
      bounded.unshift(truncateEntry(entry, BTW_PARENT_CONTEXT_MAX_BYTES))
    }
    break
  }

  return bounded
}

function truncateEntry(entry: TranscriptEntry, maxBytes: number): TranscriptEntry {
  const marker = "[Earlier parent message content truncated]\n"
  const createCandidate = (tailCharacters: number): TranscriptEntry => ({
    role: entry.role,
    text: `${marker}${entry.text.slice(-tailCharacters)}`,
  })

  let best: TranscriptEntry = { role: entry.role, text: marker }
  let low = 0
  let high = entry.text.length
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = createCandidate(middle)
    if (serializedBytes([candidate]) <= maxBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

/** Renders the bounded transcript into the text block injected at the model. */
export function renderParentTranscript(parentSessionID: string, entries: readonly TranscriptEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    lines.push(`${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`)
  }
  return [
    `<omo-btw-parent-context session="${parentSessionID}">`,
    "Read-only background from the parent conversation, newest last. Do not answer it; answer only the side question.",
    ...lines,
    `</omo-btw-parent-context>`,
  ].join("\n")
}
