import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin/effect"
import { Deferred, Effect } from "effect"
import { createExecutor } from "../orchestration/execution/executor"
import { createSessionDriver } from "../orchestration/execution/session-run"
import { createExecutionTaskTools } from "../orchestration/execution/task-tools"
import { registerTeamModeEffect } from "../features/team-mode/effect-register"
import { createWorkflow, createWorkflowTool } from "../features/workflow"
import { registerNativeSurface } from "../native-registrations"
import { loadOpenCode2Config } from "../config"
import { createTrace } from "./trace"
import { registerBaseFeatures } from "./base-features"
import { createSessionDispatchGate } from "../orchestration/session-dispatch-gate"
import { createExecutionNotifications } from "../orchestration/execution/notifications"
import type { Executor } from "../orchestration/execution/types"
import { createExecutionDelivery } from "./execution-delivery"
import { registerMonitorToolsEffect } from "../tools/monitor/register"
import { registerConfiguredModelFallbackEffect } from "../features/model-fallback/register"
import { registerLookAtToolEffect } from "../tools/look-at/register"
import { registerBtwFeatureEffect } from "../features/btw/register"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"

export const plugin = Plugin.define({
  id: "omo",
  effect: (ctx) => Effect.gen(function* () {
    const trace = createTrace()
    const registration = yield* registerNativeSurface(ctx, trace)
    const config = loadOpenCode2Config({ directory: ctx.location.directory, options: { ...ctx.options } }).config
    const gate = createSessionDispatchGate()
    yield* Effect.addFinalizer(() => Effect.sync(() => gate.dispose()))
    const locationKey = createHash("sha256").update(JSON.stringify(ctx.location)).digest("hex")
    const executionDirectory = join(ctx.location.directory, ".omo", "execution")
    yield* Effect.promise(() => mkdir(executionDirectory, { recursive: true }))
    const ready = yield* Deferred.make<Executor>()
    const delivery = createExecutionDelivery(ctx, Deferred.await(ready))
    const notifications = yield* createExecutionNotifications({ storage: ctx.storage,
      prefix: `notifications/${locationKey}/`,
      dispatch: (notification) => delivery.dispatch({ sessionID: notification.callerSessionID,
        id: notification.messageID, text: notification.text, metadata: notification.metadata,
        description: "Background execution completed" }),
    })
    const executor = yield* createExecutor({
      driver: createSessionDriver(ctx), storage: ctx.storage,
      prefix: `execution/${locationKey}/`, writer: randomUUID(),
      lockPath: join(executionDirectory, `${locationKey}.lock`),
      limits: { model: 5, team: 4 },
      notify: notifications.enqueue,
    }).pipe(Effect.orDie)
    yield* Deferred.succeed(ready, executor)
    const base = yield* registerBaseFeatures(ctx, { config, registration, gate, trace,
      dispatch: (sessionID, text) => delivery.dispatch({ sessionID, text, description: "Continue unfinished work" }),
    })
    yield* registerLookAtToolEffect(ctx, { executor, catalog: registration.catalog, sessionModels: base.sessionModels, trace })
    const btwAgent = config.default_agent ?? "sisyphus"
    const btwModel = registration.models.get(btwAgent)
    yield* registerBtwFeatureEffect(ctx, { config: config.btw ?? {}, disabledHooks: config.disabled_hooks,
      executor, agent: Agent.ID.make(btwAgent), model: btwModel ? Model.Ref.parse(btwModel) : undefined,
      resolveSessionID: (value) => typeof value === "object" && value !== null && "sessionID" in value
        && typeof value.sessionID === "string" ? value.sessionID : undefined, trace })
    yield* registerMonitorToolsEffect(ctx, { cwd: ctx.location.directory, trace, dispatchManaged: delivery.managed })
    yield* registerConfiguredModelFallbackEffect(ctx, { directory: ctx.location.directory, gate, executor, trace })
    yield* registerTeamModeEffect(ctx, { cwd: ctx.location.directory, gate, executor, registration, trace, dispatch: delivery.dispatch })
    const workflow = yield* createWorkflow({ executor, storage: ctx.storage, prefix: `workflow/${locationKey}/`,
      agents: new Set([...registration.subagents, ...registration.categories]) })
    const taskTools = createExecutionTaskTools(executor, registration, trace)
    yield* ctx.tool.transform((editor) => {
      editor.add(taskTools.task)
      editor.add(taskTools.output)
      editor.add(taskTools.cancel)
      editor.add(createWorkflowTool(workflow))
    })
  }).pipe(Effect.orDie),
})
