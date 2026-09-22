import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"

import { registerBuiltinCommands } from "./commands/register-builtin-commands"
import { createCatalogSource, type CatalogSource } from "./agents/model-resolution"
import { registerConfiguredAgents, type ConfiguredAgentRegistration } from "./agents/register-configured"
import { registerSharedSkills } from "./skills/register-shared-skills"
import { createContext7Config } from "./mcp/context7"
import { createGrepAppConfig } from "./mcp/grep-app"
import { createLspMcpConfig } from "./mcp/lsp"
import { toServerConfig, userDefinedNames } from "./mcp/types"
import { loadOpenCode2Config } from "./config"
import type { Trace } from "./plugin/trace"

export function registerNativeSurface(ctx: Context, trace?: Trace): Effect.Effect<ConfiguredAgentRegistration & { readonly catalog: CatalogSource }, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    const catalog = createCatalogSource()
    yield* ctx.catalog.transform((draft) => catalog.capture(draft))
    const config = loadOpenCode2Config({ directory: ctx.location.directory, options: { ...ctx.options } }).config
    const registration = yield* registerConfiguredAgents(ctx, { catalog, directory: ctx.location.directory, trace }).pipe(Effect.orDie)
    trace?.("omo.registration.complete", { primaries: [...registration.primaries], subagents: [...registration.subagents], categories: [...registration.categories] })
    yield* registerSharedSkills(ctx, trace)

    yield* registerBuiltinCommands(ctx, trace)

    const disabled = config.disabled_mcps ?? []
    const wanted = [
      ["context7", createContext7Config(process.env)],
      ["grep_app", createGrepAppConfig()],
      ["lsp", createLspMcpConfig({ cwd: ctx.location.directory })],
    ] as const
    yield* ctx.mcp.transform((editor) => {
      const userNames = userDefinedNames(editor)
      for (const [name, server] of wanted) {
        if (disabled.includes(name) || server === undefined || userNames.has(name)) continue
        editor.set(name, toServerConfig(server))
      }
    })
    return { ...registration, catalog }
  })
}
