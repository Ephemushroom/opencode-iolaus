/**
 * Parsers for `session_message.data`, opencode2's per-message JSON payload.
 *
 * Shapes observed on `0.0.0-next-17444`:
 * - user:           { time: { created }, text, files: [] }
 * - assistant:      { time: { created, completed }, agent, model: { id, providerID },
 *                     content: [{ type: "reasoning" | "text", text }], finish, cost,
 *                     tokens: { input, output, reasoning, cache: { read, write } } }
 * - agent-switched: { time: { created }, agent }
 *
 * This couples to an internal schema, so every reader degrades to `unknown`
 * instead of throwing when a field is missing or changes type.
 */

export interface MessageTokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
}

export interface UserMessage {
  readonly kind: "user"
  readonly createdAt: number | undefined
  readonly text: string
  readonly fileCount: number
}

export interface AssistantMessage {
  readonly kind: "assistant"
  readonly createdAt: number | undefined
  readonly completedAt: number | undefined
  readonly agent: string | undefined
  readonly model: string | undefined
  readonly text: string
  readonly reasoning: string
  readonly finish: string | undefined
  readonly cost: number | undefined
  readonly tokens: MessageTokens | undefined
}

export interface AgentSwitchedMessage {
  readonly kind: "agent-switched"
  readonly createdAt: number | undefined
  readonly agent: string | undefined
}

export interface UnknownMessage {
  readonly kind: "unknown"
  readonly createdAt: number | undefined
  readonly rawType: string
  readonly text: string
}

export type ParsedMessage = UserMessage | AssistantMessage | AgentSwitchedMessage | UnknownMessage

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === "string" ? value : undefined
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readCreatedAt(payload: Record<string, unknown>): number | undefined {
  return readNumber(asRecord(payload.time), "created")
}

function readModel(payload: Record<string, unknown>): string | undefined {
  const model = asRecord(payload.model)
  const id = readString(model, "id")
  if (!id) return undefined
  const provider = readString(model, "providerID")
  return provider ? `${provider}/${id}` : id
}

function readTokens(payload: Record<string, unknown>): MessageTokens | undefined {
  const tokens = payload.tokens
  if (typeof tokens !== "object" || tokens === null) return undefined
  const record = asRecord(tokens)
  return {
    input: readNumber(record, "input") ?? 0,
    output: readNumber(record, "output") ?? 0,
    reasoning: readNumber(record, "reasoning") ?? 0,
  }
}

interface SplitContent {
  readonly text: string
  readonly reasoning: string
}

function splitContent(payload: Record<string, unknown>): SplitContent {
  const content = payload.content
  if (!Array.isArray(content)) return { text: "", reasoning: "" }

  const textParts: string[] = []
  const reasoningParts: string[] = []
  for (const entry of content) {
    const part = asRecord(entry)
    const text = readString(part, "text")
    if (!text) continue
    if (readString(part, "type") === "reasoning") reasoningParts.push(text)
    else textParts.push(text)
  }
  return { text: textParts.join("\n"), reasoning: reasoningParts.join("\n") }
}

/** Parses one row. `type` is the DB column; `data` is its raw JSON text. */
export function parseMessage(type: string, data: string): ParsedMessage {
  let payload: Record<string, unknown>
  try {
    payload = asRecord(JSON.parse(data))
  } catch {
    return { kind: "unknown", createdAt: undefined, rawType: type, text: "" }
  }

  const createdAt = readCreatedAt(payload)

  if (type === "user") {
    const files = payload.files
    return {
      kind: "user",
      createdAt,
      text: readString(payload, "text") ?? "",
      fileCount: Array.isArray(files) ? files.length : 0,
    }
  }

  if (type === "assistant") {
    const { text, reasoning } = splitContent(payload)
    return {
      kind: "assistant",
      createdAt,
      completedAt: readNumber(asRecord(payload.time), "completed"),
      agent: readString(payload, "agent"),
      model: readModel(payload),
      text,
      reasoning,
      finish: readString(payload, "finish"),
      cost: readNumber(payload, "cost"),
      tokens: readTokens(payload),
    }
  }

  if (type === "agent-switched") {
    return { kind: "agent-switched", createdAt, agent: readString(payload, "agent") }
  }

  const { text } = splitContent(payload)
  return { kind: "unknown", createdAt, rawType: type, text: text || (readString(payload, "text") ?? "") }
}

/** The text a search should match against, and what an excerpt is cut from. */
export function searchableText(message: ParsedMessage): string {
  switch (message.kind) {
    case "user":
      return message.text
    case "assistant":
      return message.text
    case "agent-switched":
      return message.agent ?? ""
    case "unknown":
      return message.text
  }
}
