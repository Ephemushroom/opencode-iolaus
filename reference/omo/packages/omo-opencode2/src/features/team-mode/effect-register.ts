import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Cause, Effect, Stream } from "effect"

import type { ConfiguredAgentRegistration } from "../../agents/register-configured"
import { createNativeIdlePorts } from "../../orchestration/idle-injector"
import type { Executor } from "../../orchestration/execution/types"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { loadOpenCode2Config } from "../../config"
import { ensureBaseDirs, resolveBaseDir } from "@oh-my-opencode/team-core"
import { createTeamCoreConfig } from "./config"
import { TeamMailbox } from "./mailbox"
import { TeamMemberRuntime } from "./member-runtime"
import { TeamSessionRegistry } from "./session-registry"
import { createTeamTools } from "./tools"
import type { TeamToolDefinition, TeamTrace } from "./types"
import { ExecutionError } from "../../orchestration/execution/errors"
import type { TeamFeatureContext } from "./types"

export type RegisterTeamModeEffectOptions = {
  readonly cwd: string
  readonly gate: SessionDispatchGate
  readonly executor: Executor
  readonly registration: ConfiguredAgentRegistration
  readonly trace?: TeamTrace
  readonly dispatch: (input: Parameters<TeamFeatureContext["session"]["synthetic"]>[0]) => Effect.Effect<void, ExecutionError>
}

type NativeTool = {
  readonly name: string
  readonly description: string
  readonly input: Tool.ValueSchema<unknown>
  readonly options: { readonly codemode: false }
  readonly execute: (input: unknown, context: { readonly sessionID: string }) => Effect.Effect<{ readonly content: string }, Tool.Error>
}

function toolError(error: unknown): Tool.Error {
  return new Tool.Error({ message: error instanceof Error ? error.message : String(error) })
}

function nativeTool(tool: TeamToolDefinition): NativeTool {
  return {
    name: tool.name,
    description: tool.description,
    input: tool.input,
    options: { codemode: false },
    execute: (value, context) => Effect.tryPromise({
      try: () => tool.execute(value, context),
      catch: toolError,
    }),
  }
}

export const registerTeamModeEffect = Effect.fn("omo.registerTeamModeEffect")(function* (
  ctx: Context,
  options: RegisterTeamModeEffectOptions,
) {
  const loaded = loadOpenCode2Config({ directory: options.cwd, options: { ...ctx.options } })
  const disabled = loaded.config.disabled_hooks?.includes("team_mode") === true
  if (!loaded.config.team_mode?.enabled || disabled) {
    options.trace?.("omo.team.disabled", { reason: disabled ? "listed in disabled_hooks" : "team_mode.enabled is not true" })
    return undefined
  }

  const config = createTeamCoreConfig(options.cwd)
  yield* Effect.tryPromise({ try: () => ensureBaseDirs(resolveBaseDir(config)), catch: toolError })
  const ports = yield* createNativeIdlePorts(ctx)
  const sessions = new TeamSessionRegistry()
  const session = {
    create: () => ports.run(Effect.sync(() => ({ id: Session.ID.create() }))),
    prompt: (input: { readonly sessionID: string; readonly text: string }) => ports.run(Effect.gen(function* () {
      const record = yield* options.executor.managed(Session.ID.make(input.sessionID))
      if (!record) return yield* new ExecutionError({ code: "not-found", message: "Team member has no admitted execution" })
      yield* options.executor.submit({ kind: "message", previous: record.ref, owner: record.owner,
        text: input.text, description: "Team member message", background: false })
    })),
    synthetic: (input: Parameters<TeamFeatureContext["session"]["synthetic"]>[0]) => ports.run(options.dispatch(input)),
    interrupt: (input: { readonly sessionID: string }) => ports.run(Effect.gen(function* () {
      const record = yield* options.executor.managed(Session.ID.make(input.sessionID))
      if (record) yield* options.executor.stopOwner(record.owner, "force")
    })),
  }
  const coreContext = { session }
  const runtime = new TeamMemberRuntime({ ctx: coreContext, cwd: options.cwd, config, sessions, trace: options.trace, executor: options.executor, run: ports.run, models: options.registration.models })
  const mailbox = new TeamMailbox({ ctx: coreContext, config, sessions, gate: options.gate, trace: options.trace, executor: options.executor, run: ports.run })
  const resolveSessionID = (value: unknown): string | undefined => typeof value === "object" && value !== null && typeof Reflect.get(value, "sessionID") === "string" ? Reflect.get(value, "sessionID") : undefined
  const tools = createTeamTools({ ctx: coreContext, cwd: options.cwd, config, runtime, sessions, mailbox, resolveSessionID, trace: options.trace, executor: options.executor, run: ports.run })
  yield* ctx.tool.transform((editor) => { for (const tool of tools) editor.add(nativeTool(tool)) })
  yield* ctx.event.subscribe().pipe(Stream.runForEach((event) => Effect.promise(async () => {
    if (event.type === "session.deleted") {
      const deletedID = typeof event.data === "object" && event.data !== null && "sessionID" in event.data ? String(event.data.sessionID) : ""
      await runtime.updateMemberStatus(deletedID, "completed")
      sessions.unregister(deletedID)
      return
    }
    const eventData = typeof event.data === "object" && event.data !== null ? event.data : undefined
    const sessionID = eventData !== undefined && "sessionID" in eventData ? String(eventData.sessionID) : ""
    if (!sessions.lookup(sessionID)) return
    if (event.type === "session.execution.failed") await runtime.updateMemberStatus(sessionID, "errored")
    if (event.type === "session.idle" || event.type === "session.execution.succeeded") {
      await runtime.updateMemberStatus(sessionID, "idle")
      await mailbox.wakeLeadForMemberIdle(sessionID)
    }
  }).pipe(Effect.catchCause((cause) => Effect.sync(() => options.trace?.("omo.team.event-error", { message: Cause.pretty(cause) }))))), Effect.forkScoped)
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    const records = yield* options.executor.list()
    const owners = new Map<string, typeof records[number]["owner"]>()
    for (const record of records) if (record.owner.kind === "team") owners.set(`${record.owner.teamRunID}/${record.owner.member}`, record.owner)
    for (const owner of owners.values()) yield* options.executor.closeOwner(owner).pipe(Effect.orDie)
    for (const owner of owners.values()) yield* options.executor.stopOwner(owner, "force").pipe(Effect.orDie)
    sessions.clear()
  }))
  options.trace?.("omo.team.registered", { tools: tools.map((tool) => tool.name) })
  return { config, dispose: () => sessions.clear(), executor: options.executor, registration: options.registration }
})
