import { Plugin } from "@opencode/plugin"
import { parseOptions } from "./options"
import { registerAgents, registerModes } from "./registration"
import { composeContext } from "./context"
import { trace } from "./trace"
import { createDagController } from "./dag/controller"
import { createOpenCodeDagRunner } from "./dag/runner"
import { createDagTool } from "./dag/tool"

export default Plugin.define({
  id: "iolaus",
  async setup(ctx) {
    const options = parseOptions({ ...ctx.options })
    trace("iolaus.loaded", { enabled: options.enabled, host: ctx.app.version })
    if (!options.enabled) return
    await registerAgents(ctx, options)
    await registerModes(ctx, options)
    await ctx.session.hook("context", (event) => composeContext(event, ctx, options))
    const controller = createDagController({ directory: ctx.location.directory, runner: createOpenCodeDagRunner(ctx), trace })
    await ctx.tool.transform((editor) => editor.add(createDagTool(controller)))
    return () => controller.close()
  },
})
