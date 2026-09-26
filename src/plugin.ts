import { Effect } from "effect"
import { Agent, Plugin } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
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
import { resolveGhBinary } from "./gh/binary"
import { GH_NAMESPACE, GH_NAMESPACE_DESCRIPTION, createGhTools } from "./gh/tools"
import { effectTool } from "./effect-bridge"

/** Session directory for a call, falling back to the plugin's own location. */
function sessionDirectory(ctx: Context, sessionID: string): Effect.Effect<string> {
  return ctx.session.get({ sessionID: sessionID as never }).pipe(
    Effect.map((session) => String(session.location?.directory ?? ctx.location.directory)),
    Effect.catch(() => Effect.succeed(String(ctx.location.directory))),
  )
}

/** Agent rules plus any session-level rules, for tools that must re-check permissions in-process. */
function permissionRules(ctx: Context, sessionID: string, agent: string): Effect.Effect<readonly PermissionRule[]> {
  return Effect.all([
    ctx.agent.get({ agentID: Agent.ID.make(agent) }).pipe(Effect.map((result) => result.data?.permissions ?? []), Effect.catch(() => Effect.succeed([] as readonly unknown[]))),
    ctx.session.get({ sessionID: sessionID as never }).pipe(Effect.map((session) => (session as { permissions?: readonly PermissionRule[] }).permissions ?? []), Effect.catch(() => Effect.succeed([] as readonly PermissionRule[]))),
  ], { concurrency: 2 }).pipe(Effect.map(([agentRules, sessionRules]) => [...(agentRules as readonly PermissionRule[]), ...sessionRules]))
}

export default Plugin.define({
  id: "iolaus",
  effect: (ctx) => Effect.gen(function* () {
    const options = parseOptions({ ...ctx.options })
    trace("iolaus.loaded", { enabled: options.enabled, host: ctx.app.version })
    if (!options.enabled) return
    const models = loadModelsConfig(ctx.location.directory, { inline: options.models })
    trace("iolaus.models.loaded", { sources: models.sources, diagnostics: models.diagnostics })
    yield* registerAgents(ctx, options, models.config)
    yield* registerModes(ctx, options)
    yield* registerMcps(ctx, options.mcps)
    const defaultModel = (agent: string): string | undefined => {
      const lane = agentName(agent) ?? categoryName(agent)
      const assignment = lane ? resolveLane(lane, models.config) : undefined
      return assignment ? modelString(assignment) : undefined
    }
    yield* ctx.session.hook("context", (event) => composeContext(event, ctx, options))

    // The RPC registration is created after the controller, so events emitted before it exists are dropped.
    let emit: ((sessionID: string, runID: string, sequence: number, type: string) => Effect.Effect<void, unknown>) | undefined
    const controller = createDagController({
      directory: ctx.location.directory,
      runner: createOpenCodeDagRunner(ctx),
      defaultModel,
      trace,
      onEvent: (event, sessionID) => emit?.(sessionID, event.runID, event.sequence, event.type),
    })
    yield* Effect.addFinalizer(() => controller.close)
    yield* ctx.tool.transform((editor) => editor.add(createDagTool(controller)))

    const sgPath = options.astGrep ? resolveAstGrepBinary() : undefined
    trace(sgPath ? "iolaus.ast_grep.registered" : "iolaus.ast_grep.unavailable", { enabled: options.astGrep, binary: sgPath ?? null })
    if (sgPath) {
      const tools = createAstGrepTools(sgPath, {
        directory: (sessionID) => Effect.runPromise(sessionDirectory(ctx, sessionID)),
        rules: (sessionID, agent) => Effect.runPromise(permissionRules(ctx, sessionID, agent)),
        trace,
      })
      yield* ctx.tool.transform((editor) => {
        editor.namespace({ name: AST_GREP_NAMESPACE, description: AST_GREP_NAMESPACE_DESCRIPTION })
        for (const tool of tools) editor.add(effectTool(tool))
      })
    }

    const ghBinary = options.gh ? resolveGhBinary() : undefined
    trace(ghBinary?.authenticated ? "iolaus.gh.registered" : "iolaus.gh.unavailable", { enabled: options.gh, binary: ghBinary?.path ?? null, version: ghBinary?.version ?? null, authenticated: ghBinary?.authenticated ?? false })
    if (ghBinary?.authenticated) {
      const tools = createGhTools(ghBinary, { trace })
      yield* ctx.tool.transform((editor) => {
        editor.namespace({ name: GH_NAMESPACE, description: GH_NAMESPACE_DESCRIPTION })
        for (const tool of tools) editor.add(effectTool(tool))
      })
    }

    if (options.verify !== false) {
      yield* registerVerifyHook(ctx, {
        directory: (sessionID) => Effect.runPromise(sessionDirectory(ctx, sessionID)),
        trace,
        ...(typeof options.verify === "object" ? { inline: options.verify } : {}),
      })
    }
    trace("iolaus.verify.registered", { enabled: options.verify !== false, inline: typeof options.verify === "object" })

    const rpc = yield* registerDagRpc(ctx, controller).pipe(Effect.orDie)
    emit = (sessionID, runID, sequence, type) => rpc.events.emit("updated", { sessionID, runID, sequence, type })
  }),
})
