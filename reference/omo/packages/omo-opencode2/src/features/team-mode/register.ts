import { ensureBaseDirs, resolveBaseDir } from "@oh-my-opencode/team-core"

import { loadOpenCode2Config } from "../../config"
import { createTeamCoreConfig } from "./config"
import { TeamMailbox } from "./mailbox"
import { TeamMemberRuntime } from "./member-runtime"
import { TeamSessionRegistry } from "./session-registry"
import { createTeamTools } from "./tools"
import type { RegisterTeamModeOptions, TeamFeatureContext, TeamModeRegistration } from "./types"

type TeamEvent = { readonly type: string; readonly data?: Record<string, unknown> }

function teamEvent(input: unknown): TeamEvent | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const type = Reflect.get(input, "type")
  if (typeof type !== "string") return undefined
  const rawData = Reflect.get(input, "data")
  const data = typeof rawData === "object" && rawData !== null && !Array.isArray(rawData)
    ? Object.fromEntries(Object.entries(rawData))
    : undefined
  return data === undefined ? { type } : { type, data }
}

function eventSessionID(event: TeamEvent): string | undefined {
  return typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined
}

export async function registerTeamMode(
  ctx: TeamFeatureContext,
  options: RegisterTeamModeOptions,
): Promise<TeamModeRegistration | undefined> {
  const loaded = loadOpenCode2Config({ directory: options.cwd, options: { ...ctx.options } })
  const disabled = loaded.config.disabled_hooks?.includes("team_mode") === true
  if (!loaded.config.team_mode?.enabled || disabled) {
    options.trace?.("omo.team.disabled", { reason: disabled ? "listed in disabled_hooks" : "team_mode.enabled is not true" })
    return undefined
  }

  const config = createTeamCoreConfig(options.cwd)
  await ensureBaseDirs(resolveBaseDir(config))
  const sessions = new TeamSessionRegistry()
  const runtime = new TeamMemberRuntime({ ctx, cwd: options.cwd, config, sessions, trace: options.trace })
  const mailbox = new TeamMailbox({ ctx, config, sessions, gate: options.gate, trace: options.trace })
  const tools = createTeamTools({
    ctx,
    cwd: options.cwd,
    config,
    runtime,
    sessions,
    mailbox,
    resolveSessionID: options.resolveSessionID,
    trace: options.trace,
  })
  await ctx.tool.transform((draft) => {
    for (const tool of tools) {
      draft.add({ ...tool, options: { codemode: false } })
    }
  })
  options.trace?.("omo.team.registered", { tools: tools.map((tool) => tool.name) })

  let disposed = false
  const inFlight = new Set<Promise<void>>()
  const pump = (async () => {
    for await (const rawEvent of ctx.event.subscribe()) {
      if (disposed) return
      const event = teamEvent(rawEvent)
      if (!event) continue
      const sessionID = eventSessionID(event)
      if (!sessionID || !sessions.lookup(sessionID)) continue
      const pending = handleTeamEvent(event, sessionID, runtime, mailbox, sessions)
      inFlight.add(pending)
      void pending.catch((error: unknown) => {
        options.trace?.("omo.team.event-error", { type: event.type, sessionID, message: error instanceof Error ? error.message : String(error) })
      }).finally(() => inFlight.delete(pending))
    }
  })()
  void pump.catch((error: unknown) => options.trace?.("omo.team.event-pump-error", { message: error instanceof Error ? error.message : String(error) }))

  return {
    config,
    dispose: () => {
      disposed = true
      sessions.clear()
      inFlight.clear()
    },
  }
}

async function handleTeamEvent(
  event: TeamEvent,
  sessionID: string,
  runtime: TeamMemberRuntime,
  mailbox: TeamMailbox,
  sessions: TeamSessionRegistry,
): Promise<void> {
  if (event.type === "session.idle" || event.type === "session.execution.succeeded") {
    await runtime.updateMemberStatus(sessionID, "idle")
    await mailbox.wakeLeadForMemberIdle(sessionID)
    return
  }
  if (event.type === "session.execution.failed") {
    await runtime.updateMemberStatus(sessionID, "errored")
    return
  }
  if (event.type === "session.deleted") {
    await runtime.updateMemberStatus(sessionID, "completed")
    sessions.unregister(sessionID)
  }
}
