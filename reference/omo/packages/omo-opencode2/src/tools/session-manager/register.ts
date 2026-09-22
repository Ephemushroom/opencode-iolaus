import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"

import { createSessionTools, type SessionToolsOptions } from "./tools"

type Trace = (event: string, detail?: Record<string, unknown>) => void

export type RegisterSessionToolsOptions = SessionToolsOptions & { readonly trace?: Trace }

/** Adds session_list / session_read / session_search / session_info to the registry. */
export const registerSessionTools = Effect.fn("omo.registerSessionTools")(function* (ctx: Context, options: RegisterSessionToolsOptions) {
  const tools = createSessionTools(options)

  yield* ctx.tool.transform((draft) => {
    for (const tool of tools) {
      draft.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        options: { codemode: false },
        execute: (input: unknown) => Effect.tryPromise({ try: () => tool.execute(input),
          catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }) }),
      })
    }
  })

  options.trace?.("omo.session-tools.registered", { tools: tools.map((tool) => tool.name) })
})
