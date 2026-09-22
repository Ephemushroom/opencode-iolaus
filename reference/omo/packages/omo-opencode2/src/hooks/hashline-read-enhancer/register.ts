import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"

import { tagReadOutput } from "./tag-read-output"

type Trace = (event: string, detail?: Record<string, unknown>) => void

interface ContentPartLike {
  type: string
  text?: string
  [key: string]: unknown
}

interface ToolResultLike {
  content?: string | ReadonlyArray<ContentPartLike>
  [key: string]: unknown
}

function isTextPart(part: ContentPartLike): part is ContentPartLike & { text: string } {
  return part.type === "text" && typeof part.text === "string"
}

/**
 * Returns a new tool result whose `read` content carries `LINE#ID` tags.
 *
 * Handles BOTH shapes the v2 `execute.after` hook delivers (R12): a plain
 * string, and an array of content parts. Only text parts are rewritten; file
 * and other parts pass through untouched. Tagging is idempotent, so repeated
 * `execute.after` invocations never double tag.
 */
export function applyHashlineTagsToResult(result: Tool.Result): Tool.Result {
  const content = result.content
  if (typeof content === "string") {
    return { ...result, content: tagReadOutput(content) }
  }
  if (Array.isArray(content)) {
    const next = content.map((part) => (isTextPart(part) ? { ...part, text: tagReadOutput(part.text) } : part))
    return { ...result, content: next }
  }
  return result
}

function isReadTool(toolName: string): boolean {
  return toolName.toLowerCase() === "read"
}

/**
 * Registers the hashline read enhancer on `ctx.tool.hook("execute.after")`.
 *
 * The core reads the mutated `event.result` back after hooks run, so rewriting
 * the result content here is what tags every builtin `read` output with
 * `LINE#ID` hashes. The handler is cheap and idempotent because it fires for
 * every tool call.
 */
export function registerHashlineReadEnhancer(ctx: Context, trace?: Trace): Effect.Effect<void, never, import("effect").Scope.Scope> {
  return Effect.asVoid(ctx.tool.hook("execute.after", (event) => Effect.sync(() => {
    if (!isReadTool(event.tool) || event.status !== "completed") {
      return
    }
    try {
      event.result = applyHashlineTagsToResult(event.result)
      trace?.("omo.hashline.tag-applied", { tool: event.tool, sessionID: event.sessionID })
    } catch (error) {
      trace?.("omo.hashline.tag-error", { tool: event.tool, message: String(error) })
    }
  })))
}
