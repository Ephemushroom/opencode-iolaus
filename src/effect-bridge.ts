import { Effect } from "effect"
import type { Tool } from "@opencode/schema/tool"
import type { Info as PromiseToolInfo, ToolContext as PromiseToolContext } from "@opencode/plugin/promise/tool"

/**
 * Wraps a tool authored against the Promise API so it can be registered through
 * the Effect editor. The shell-backed namespaces (ast_grep, gh) do their own
 * error envelopes, so a rejected promise here is a defect, not a typed failure.
 */
export function effectTool(tool: PromiseToolInfo): Tool.Info {
  return {
    ...tool,
    execute: (input, context) => Effect.promise((signal) => {
      const promiseContext: PromiseToolContext = { ...context, signal, progress: (update) => Effect.runPromise(context.progress(update)) }
      return tool.execute(input as never, promiseContext)
    }),
  } as Tool.Info
}
