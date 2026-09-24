import { Plugin } from "@opencode/plugin"
import { parseOptions } from "./options"
import { registerAgents, registerModes } from "./registration"
import { composeContext } from "./context"
import { trace } from "./trace"
import { createDagController } from "./dag/controller"
import { createOpenCodeDagRunner } from "./dag/runner"
import { createDagTool } from "./dag/tool"
import { registerDagRpc } from "./dag/register-rpc"
import { loadModelsConfig, modelString, resolveLane } from "./models"
import { agentName, categoryName } from "./prompts/catalog"

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
    rpcRegistration = await registerDagRpc(ctx, controller)
    return async () => { controller.close(); await rpcRegistration?.dispose() }
  },
})
