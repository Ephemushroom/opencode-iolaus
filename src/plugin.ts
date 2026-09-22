import { Plugin } from "@opencode/plugin"
import { parseOptions } from "./options"
import { registerAgents, registerModes } from "./registration"
import { composeContext } from "./context"
import { trace } from "./trace"

export default Plugin.define({
  id: "iolaus",
  async setup(ctx) {
    const options = parseOptions({ ...ctx.options })
    trace("iolaus.loaded", { enabled: options.enabled, host: ctx.app.version })
    if (!options.enabled) return
    await registerAgents(ctx, options)
    await registerModes(ctx, options)
    await ctx.session.hook("context", (event) => composeContext(event, ctx, options))
  },
})
