import { Agent } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"

import { BUILTIN_COMMAND_DEFINITIONS } from "./builtin-command-definitions"
import { renderCommandTemplate } from "./render-command-template"

export interface BuiltinCommandsRegistrationContext {
  readonly command: Pick<Context["command"], "transform">
  readonly agent: {
    readonly get: (input: Parameters<Context["agent"]["get"]>[0]) => Effect.Effect<{
      readonly data?: Pick<Effect.Success<ReturnType<Context["agent"]["get"]>>["data"], "model">
    }, unknown>
  }
  readonly session: {
    readonly get: (input: Parameters<Context["session"]["get"]>[0]) => Effect.Effect<Pick<Effect.Success<ReturnType<Context["session"]["get"]>>, "agent">, unknown>
    readonly switchAgent: (input: Parameters<Context["session"]["switchAgent"]>[0]) => Effect.Effect<unknown, unknown>
    readonly switchModel: (input: Parameters<Context["session"]["switchModel"]>[0]) => Effect.Effect<unknown, unknown>
    readonly prompt: (input: Parameters<Context["session"]["prompt"]>[0]) => Effect.Effect<unknown, unknown>
  }
}

export const registerBuiltinCommands = Effect.fn("omo.registerBuiltinCommands")(function* (
  ctx: BuiltinCommandsRegistrationContext,
  trace?: (event: string, detail?: Record<string, unknown>) => void,
) {
  yield* ctx.command.transform((editor) => {
    for (const definition of BUILTIN_COMMAND_DEFINITIONS) {
      editor.add({
        name: definition.name,
        description: definition.description,
        execute: (input) => Effect.gen(function* () {
          const text = renderCommandTemplate(definition.template, {
            text: input.prompt.text, sessionID: input.sessionID, timestamp: new Date().toISOString(),
          })
          if (definition.agent !== undefined) {
            const agentID = Agent.ID.make(definition.agent)
            const selected = yield* ctx.agent.get({ agentID })
            const session = yield* ctx.session.get({ sessionID: input.sessionID })
            if (session.agent !== agentID) yield* ctx.session.switchAgent({ sessionID: input.sessionID, agent: agentID })
            if (selected.data?.model !== undefined) {
              yield* ctx.session.switchModel({ sessionID: input.sessionID, model: selected.data.model })
            }
          }
          yield* ctx.session.prompt({ ...input.prompt, sessionID: input.sessionID, text, delivery: input.delivery })
          trace?.("omo.command.invoked", { name: definition.name, sessionID: input.sessionID })
        }),
      })
    }
  })

  trace?.("omo.commands.registered", {
    commands: BUILTIN_COMMAND_DEFINITIONS.map((definition) => definition.name),
  })
})
