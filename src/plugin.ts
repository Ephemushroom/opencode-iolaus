import { Deferred, Effect, Stream } from "effect"
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
import { laneFallbacks, parseModelsConfig, modelString, resolveLane } from "./models"
import { agentName, categoryName } from "./prompts/catalog"
import { resolveAstGrepBinary } from "./ast-grep/binary"
import { AST_GREP_NAMESPACE, AST_GREP_NAMESPACE_DESCRIPTION, createAstGrepTools } from "./ast-grep/tools"
import type { PermissionRule } from "./ast-grep/permissions"
import { resolveGhBinary } from "./gh/binary"
import { GH_NAMESPACE, GH_NAMESPACE_DESCRIPTION, createGhTools } from "./gh/tools"
import { effectTool } from "./effect-bridge"
import { homeContract, provisionHome, resolveHome } from "./home"
import { loadGlobalConfig } from "./global-config"
import { SessionStateStore } from "./database"
import { registerRoles } from "./roles/register"
import { registerSubagentObserver } from "./dag/observe"
import { createStateSync } from "./session-state"
import { DagValidationError } from "./dag/errors"
import { admitTier, tierSource, type TierSession } from "./roles/tier"
import { admitSteering, rescueRoleAllowed } from "./roles/steering"
import { createOpenCodeDagNotifier } from "./dag/notices"

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
    const home = resolveHome(ctx.location.directory)
    const global = loadGlobalConfig(home.user)
    const options = parseOptions(global)
    trace("iolaus.loaded", { enabled: options.enabled, host: ctx.app.version })
    if (!options.enabled) return
    const provisioned = provisionHome(home)
    trace("iolaus.home.ready", { user: home.user, project: home.project, created: provisioned.created })
    const models = parseModelsConfig(global.models ?? {})
    trace("iolaus.models.loaded", { source: global.models === undefined ? "none" : "iolaus.json" })
    yield* registerAgents(ctx, options, models)
    yield* registerModes(ctx, options)
    yield* registerMcps(ctx, options.mcps)
    const defaultModel = (agent: string): string | undefined => {
      const lane = agentName(agent) ?? categoryName(agent)
      const assignment = lane ? resolveLane(lane, models) : undefined
      return assignment ? modelString(assignment) : undefined
    }
    const fallbackModels = (agent: string): readonly string[] => {
      const lane = agentName(agent) ?? categoryName(agent)
      return lane ? laneFallbacks(lane, models) : []
    }
    yield* ctx.session.hook("context", (event) => composeContext(event, ctx, options, homeContract(home)))

    // The RPC registration is created after the controller, so events emitted before it exists are dropped.
    let emit: ((sessionID: string, runID: string, sequence: number, type: string) => Effect.Effect<void, unknown>) | undefined
    const state = new SessionStateStore(home.database)
    yield* Effect.addFinalizer(() => Effect.sync(() => state.close()))
    const getTierSession = (sessionID: string): Effect.Effect<TierSession, DagValidationError> => ctx.session.get({ sessionID: sessionID as never }).pipe(
      Effect.map((session) => session as TierSession), Effect.mapError(() => new DagValidationError("Session ancestry is unavailable")))
    const source = (sessionID: string) => tierSource(sessionID, getTierSession, (runID, nodeID, childID) => controller.lineage(runID, nodeID, childID))
    const recoveryReady = yield* Deferred.make<void>()
    const controller = createDagController({
      directory: ctx.location.directory,
      databasePath: home.database,
      runner: createOpenCodeDagRunner(ctx),
      rescue: options.rescue,
      recoveryReady: Deferred.await(recoveryReady),
      defaultModel,
      fallbackModels,
      maxParallel: options.defaultConcurrency,
      admit: (owner, definition, authorizedPlan) => Effect.gen(function* () {
        const session = yield* getTierSession(owner).pipe(Effect.mapError(() => new DagValidationError("DAG owner session is unavailable")))
        const caller = yield* source(owner).pipe(Effect.mapError(() => new DagValidationError("DAG owner ancestry is unavailable")))
        yield* Effect.try({ try: () => admitTier(caller, session, definition, authorizedPlan), catch: (error) => error instanceof DagValidationError ? error : new DagValidationError(String(error)) })
      }),
      trace,
      admitSteer: (owner, node) => admitSteering(ctx, state, owner, node),
      rescueRoleAllowed: (sessionID) => rescueRoleAllowed(ctx, state, sessionID),
      notifier: createOpenCodeDagNotifier(ctx.session),
      onEvent: (event, sessionID) => Effect.andThen(stateSync.refresh(sessionID), emit?.(sessionID, event.runID, event.sequence, event.type) ?? Effect.void),
    })
    const stateSync = createStateSync(ctx.session.instructions, { controller, state, trace })
    state.onSave = (sessionID) => { Effect.runFork(stateSync.refresh(sessionID)) }
    yield* Effect.addFinalizer(() => controller.close)
    yield* ctx.tool.transform((editor) => editor.add(createDagTool(controller)))
    yield* registerRoles(ctx, options, { controller, source, directory: (sessionID) => sessionDirectory(ctx, sessionID), state, trace })
    // After the role guard, so a refused subagent call is not recorded.
    yield* registerSubagentObserver(ctx, controller, trace)

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
        config: typeof options.verify === "object" ? options.verify : undefined,
      })
    }
    trace("iolaus.verify.registered", { enabled: options.verify !== false, configured: typeof options.verify === "object" })

    const rpc = yield* registerDagRpc(ctx, controller).pipe(Effect.orDie)
    emit = (sessionID, runID, sequence, type) => rpc.events.emit("updated", { sessionID, runID, sequence, type })
    yield* ctx.event.subscribe({ types: ["plugin.updated"] }).pipe(
      Stream.filter((event) => event.location?.directory === ctx.location.directory && event.location.workspaceID === ctx.location.workspaceID),
      Stream.take(1),
      Stream.runForEach(() => Deferred.succeed(recoveryReady, undefined)),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
