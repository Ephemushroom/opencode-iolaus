import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, type Scope } from "effect"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  extractApplyPatchEdits,
  getString,
  isRecord,
  type CheckResult,
  type HookInput,
  type RunCommentCheckerInput,
} from "@oh-my-opencode/comment-checker-core"

import { createDefaultCommentCheckerRuntime } from "./runtime"

type Trace = (event: string, detail?: Record<string, unknown>) => void

type ContentPartLike = {
  readonly type: string
  readonly text?: string
}

type ToolResultLike = {
  readonly content?: string | readonly ContentPartLike[]
}

type CompletedEvent = {
  readonly tool: string
  readonly sessionID: string
  readonly agent?: string
  readonly status: "completed"
  readonly input: unknown
  result: ToolResultLike
}

type ErrorEvent = {
  readonly tool: string
  readonly sessionID: string
  readonly agent?: string
  readonly status: "error"
  readonly input: unknown
  readonly error: unknown
}

export type CommentCheckerAfterEvent = CompletedEvent | ErrorEvent

export type CommentCheckerRuntime = {
  readonly resolveBinary: () => string | null
  readonly run: (input: RunCommentCheckerInput) => Promise<CheckResult>
}

type CheckRequest = {
  readonly filePath: string
  readonly toolName: string
  readonly toolInput: HookInput["tool_input"]
}

const MUTATION_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch"])
const FILE_DISABLE_MARKER = "// comment-checker-disable-file"

export function createCommentCheckerAfterHandler(
  runtime: CommentCheckerRuntime = createDefaultCommentCheckerRuntime(),
  trace?: Trace,
): (event: CommentCheckerAfterEvent) => Promise<void> {
  let binaryPath: string | null | undefined

  return async (event): Promise<void> => {
    const tool = event.tool.toLowerCase()
    if (event.status !== "completed" || !MUTATION_TOOLS.has(tool)) return

    const requests = extractCheckRequests(event, tool)
    if (requests.length === 0) return

    for (const request of requests) {
      if (await isFileCheckDisabled(request.filePath)) {
        trace?.("omo.comment-checker.checked", traceDetail(event, request, "disabled"))
        continue
      }

      if (binaryPath === undefined) {
        binaryPath = runtime.resolveBinary()
      }
      if (binaryPath === null) {
        trace?.("omo.comment-checker.checked", traceDetail(event, request, "unavailable"))
        continue
      }

      let result: CheckResult
      try {
        result = await runtime.run({
          binaryPath,
          hookInput: {
            session_id: event.sessionID,
            tool_name: request.toolName,
            transcript_path: "",
            cwd: process.cwd(),
            hook_event_name: "PostToolUse",
            tool_input: request.toolInput,
            tool_response: event.result,
          },
        })
      } catch (error) {
        if (!(error instanceof Error)) throw error
        trace?.("omo.comment-checker.checked", {
          ...traceDetail(event, request, "error"),
          message: error.message,
        })
        continue
      }

      const detected = result.hasComments && result.message.length > 0
      trace?.("omo.comment-checker.checked", traceDetail(event, request, detected ? "detected" : "clean"))
      if (!detected) continue

      event.result = appendFeedback(event.result, result.message)
      trace?.("omo.comment-checker.detected", {
        ...traceDetail(event, request, "detected"),
        messageLength: result.message.length,
      })
    }
  }
}

export function registerCommentChecker(
  ctx: Context,
  trace?: Trace,
  runtime: CommentCheckerRuntime = createDefaultCommentCheckerRuntime(),
): Effect.Effect<void, never, Scope.Scope> {
  const handle = createCommentCheckerAfterHandler(runtime, trace)
  return Effect.gen(function* () {
    yield* ctx.tool.hook("execute.after", (event) => Effect.promise(() => handle(event)))
    yield* Effect.sync(() => trace?.("omo.comment-checker.registered", { tools: [...MUTATION_TOOLS] }))
  })
}

function extractCheckRequests(event: CompletedEvent, tool: string): readonly CheckRequest[] {
  const input = isRecord(event.input) ? event.input : undefined
  if (tool === "apply_patch") {
    return extractApplyPatchEdits(event.result, input).map((edit) => ({
      filePath: edit.filePath,
      toolName: "Edit",
      toolInput: {
        file_path: edit.filePath,
        old_string: edit.before,
        new_string: edit.after,
      },
    }))
  }
  if (input === undefined) return []

  const filePath = getString(input, ["filePath", "file_path", "path"])
  if (filePath === undefined) return []

  const content = getString(input, ["content"])
  const oldString = getString(input, ["oldString", "old_string"])
  const newString = getString(input, ["newString", "new_string"])
  const edits = readEdits(input["edits"])
  return [{
    filePath,
    toolName: tool.charAt(0).toUpperCase() + tool.slice(1),
    toolInput: {
      file_path: filePath,
      ...(content === undefined ? {} : { content }),
      ...(oldString === undefined ? {} : { old_string: oldString }),
      ...(newString === undefined ? {} : { new_string: newString }),
      ...(edits.length === 0 ? {} : { edits }),
    },
  }]
}

function readEdits(value: unknown): readonly { old_string: string; new_string: string }[] {
  if (!Array.isArray(value)) return []

  const edits: { old_string: string; new_string: string }[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const oldString = getString(item, ["old_string"])
    const newString = getString(item, ["new_string"])
    if (oldString !== undefined && newString !== undefined) {
      edits.push({ old_string: oldString, new_string: newString })
    }
  }
  return edits
}

function appendFeedback(result: ToolResultLike, message: string): ToolResultLike {
  const feedback = `\n\n${message}`
  if (typeof result.content === "string") {
    return { ...result, content: result.content + feedback }
  }
  if (Array.isArray(result.content)) {
    return { ...result, content: [...result.content, { type: "text", text: feedback }] }
  }
  return result
}

async function isFileCheckDisabled(filePath: string): Promise<boolean> {
  try {
    const contents = await readFile(resolve(filePath), "utf8")
    const firstLine = contents.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0]?.trim()
    return firstLine === FILE_DISABLE_MARKER
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}

function traceDetail(
  event: CompletedEvent,
  request: CheckRequest,
  outcome: "clean" | "detected" | "disabled" | "error" | "unavailable",
): Record<string, unknown> {
  return {
    sessionID: event.sessionID,
    agent: event.agent,
    tool: event.tool,
    filePath: request.filePath,
    outcome,
  }
}
