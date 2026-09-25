import { Agent, Plugin } from "@opencode/plugin"
import { parseOptions } from "./options"
import { registerAgents, registerModes } from "./registration"
import { registerMcps } from "./mcp"
import { registerVerifyHook } from "./verify/hook"
import { composeContext } from "./context"
import { trace } from "./trace"
import { createDagController } from "./dag/controller"
import { createOpenCodeDagRunner } from "./dag/runner"
import { createDagTool } from "./dag/tool"
import { registerDagRpc } from "./dag/register-rpc"
import { loadModelsConfig, modelString, resolveLane } from "./models"
import { agentName, categoryName } from "./prompts/catalog"
import { resolveAstGrepBinary } from "./ast-grep/binary"
import { AST_GREP_NAMESPACE, AST_GREP_NAMESPACE_DESCRIPTION, createAstGrepTools } from "./ast-grep/tools"
import type { PermissionRule } from "./ast-grep/permissions"

export default Plugin.define({
  id: "iolaus",
  async setup(ctx) {
    const options = parseOptions({ ...ctx.options })
    trace("iolaus.loaded", { enabled: options.enabled, host: ctx.app.version })
    if (!options.enabled) return
    const models = loadModelsConfig(ctx.location.directory, { inline: options.models })
    trace("iolaus.models.loaded", { sources: models.sources, diagnostics: models.diagnostics })
    await registerAgents(ctx, options, models.config)
    await registerModes(ctx, options)
    await registerMcps(ctx, options.mcps)
    const defaultModel = (agent: string): string | undefined => {
      const lane = agentName(agent) ?? categoryName(agent)
      const assignment = lane ? resolveLane(lane, models.config) : undefined
      return assignment ? modelString(assignment) : undefined
    }
    await ctx.session.hook("context", (event) => composeContext(event, ctx, options))
    let rpcRegistration: Awaited<ReturnType<typeof registerDagRpc>> | undefined
    const controller = createDagController({
      directory: ctx.location.directory,
      runner: createOpenCodeDagRunner(ctx),
      defaultModel,
      trace,
      onEvent: (event, sessionID) => rpcRegistration?.events.emit("updated", { sessionID, runID: event.runID, sequence: event.sequence, type: event.type }),
    })
    await ctx.tool.transform((editor) => editor.add(createDagTool(controller)))
    const sgPath = options.astGrep ? resolveAstGrepBinary() : undefined
    trace(sgPath ? "iolaus.ast_grep.registered" : "iolaus.ast_grep.unavailable", { enabled: options.astGrep, binary: sgPath ?? null })
    if (sgPath) {
      const tools = createAstGrepTools(sgPath, {
        async directory(sessionID) {
          const session = await ctx.session.get({ sessionID: sessionID as never })
          return String(session.location?.directory ?? ctx.location.directory)
        },
        async rules(sessionID, agent) {
          const [info, session] = await Promise.all([
            ctx.agent.get({ agentID: Agent.ID.make(agent) }).then((result) => result.data).catch(() => undefined),
            ctx.session.get({ sessionID: sessionID as never }).catch(() => undefined),
          ])
          return [...(info?.permissions ?? []), ...((session as { permissions?: readonly PermissionRule[] } | undefined)?.permissions ?? [])] as PermissionRule[]
        },
        trace,
      })
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: AST_GREP_NAMESPACE, description: AST_GREP_NAMESPACE_DESCRIPTION })
        for (const tool of tools) editor.add(tool)
      })
    }
    if (options.verify !== false) {
      await registerVerifyHook(ctx, {
        async directory(sessionID) {
          const session = await ctx.session.get({ sessionID: sessionID as never })
          return String(session.location?.directory ?? ctx.location.directory)
        },
        trace,
        ...(typeof options.verify === "object" ? { inline: options.verify } : {}),
      })
    }
    trace("iolaus.verify.registered", { enabled: options.verify !== false, inline: typeof options.verify === "object" })
    rpcRegistration = await registerDagRpc(ctx, controller)
    return async () => { controller.close(); await rpcRegistration?.dispose() }
  },
})
