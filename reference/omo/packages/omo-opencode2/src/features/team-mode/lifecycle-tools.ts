import {
  loadRuntimeState,
  transitionRuntimeState,
  type RuntimeState,
  type TeamModeConfig,
} from "@oh-my-opencode/team-core"

import { TeamMailbox } from "./mailbox"
import { TeamMemberRuntime } from "./member-runtime"
import { TeamSessionRegistry } from "./session-registry"
import { parseInlineTeamSpec } from "./storage"
import { inputRecord, requiredString } from "./tool-input"
import type { TeamFeatureContext, TeamToolDefinition, TeamTrace } from "./types"
import type { Effect } from "effect"
import type { Executor } from "../../orchestration/execution/types"
import { Session } from "@opencode/schema/session"

type LifecycleToolsOptions = {
  readonly ctx: Pick<TeamFeatureContext, "session">
  readonly config: TeamModeConfig
  readonly runtime: TeamMemberRuntime
  readonly sessions: TeamSessionRegistry
  readonly mailbox: TeamMailbox
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
  readonly trace?: TeamTrace
  readonly executor?: Executor
  readonly run?: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>
}

function participantFor(options: LifecycleToolsOptions, teamRunId: string, toolCtx: unknown) {
  const participant = options.sessions.lookup(options.resolveSessionID(toolCtx))
  if (!participant || participant.teamRunId !== teamRunId) throw new Error("caller is not a participant of this team run")
  return participant
}

async function patchShutdownRequest(teamRunId: string, target: string, requester: string, config: TeamModeConfig): Promise<void> {
  await transitionRuntimeState(teamRunId, (state) => ({
    ...state,
    shutdownRequests: [...state.shutdownRequests, { memberId: target, requesterName: requester, requestedAt: Date.now() }],
  }), config)
}

async function resolveShutdown(
  teamRunId: string,
  memberName: string,
  config: TeamModeConfig,
  patch: (request: RuntimeState["shutdownRequests"][number]) => RuntimeState["shutdownRequests"][number],
): Promise<void> {
  await transitionRuntimeState(teamRunId, (state) => {
    const index = state.shutdownRequests.findLastIndex((request) => request.memberId === memberName)
    if (index < 0) throw new Error(`shutdown request missing for '${memberName}'`)
    return {
      ...state,
      shutdownRequests: state.shutdownRequests.map((request, requestIndex) => requestIndex === index ? patch(request) : request),
    }
  }, config)
}

export function createTeamLifecycleTools(options: LifecycleToolsOptions): TeamToolDefinition[] {
  const trace = options.trace ?? (() => undefined)
  const create: TeamToolDefinition = {
    name: "team_create",
    description: "Create a team run from an inline v1-compatible team spec.",
    input: {
      type: "object",
      properties: {
        name: { type: "string" },
        members: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", properties: { name: { type: "string" }, kind: { type: "string", enum: ["category", "subagent_type"] }, category: { type: "string" }, subagent_type: { type: "string" }, prompt: { type: "string" } }, additionalProperties: false } },
      },
      required: ["name", "members"],
      additionalProperties: false,
    },
    execute: async (raw, toolCtx) => {
      const leadSessionID = options.resolveSessionID(toolCtx)
      if (!leadSessionID) throw new Error("team_create requires the current session ID")
      if (options.sessions.lookup(leadSessionID)) throw new Error("nested teams are not supported")
      const runtime = await options.runtime.create(parseInlineTeamSpec(raw), leadSessionID)
      return { content: JSON.stringify({ teamRunId: runtime.teamRunId, runtimeState: runtime }) }
    },
  }
  const deleteTool: TeamToolDefinition = {
    name: "team_delete",
    description: "Interrupt member sessions and delete a team run. The declared project spec remains reusable.",
    input: { type: "object", properties: { teamRunId: { type: "string" }, force: { type: "boolean" } }, required: ["teamRunId"], additionalProperties: false },
    execute: async (raw, toolCtx) => {
      const input = inputRecord(raw)
      const teamRunId = requiredString(input, "teamRunId")
      const participant = participantFor(options, teamRunId, toolCtx)
      if (participant.role !== "lead") throw new Error("team_delete is lead-only")
      let state = await loadRuntimeState(teamRunId, options.config)
       const members = state.members.filter((member) => member.agentType !== "leader" && member.sessionId)
        if (options.executor && options.run) {
          const executor = options.executor
          const run = options.run
           const records = await run(executor.list())
           const owners = new Map<string, typeof records[number]["owner"]>()
           for (const record of records) {
             if (record.owner.kind === "team" && record.owner.teamRunID === teamRunId) owners.set(record.owner.member, record.owner)
           }
           for (const owner of owners.values()) await run(executor.closeOwner(owner))
           await Promise.all([...owners.values()].map((owner) => run(executor.stopOwner(owner, "force"))))
       } else {
         await Promise.all(members.map((member) => options.ctx.session.interrupt({ sessionID: member.sessionId ?? "" }).catch(() => undefined)))
       }
      if (state.status === "active" || state.status === "shutdown_requested") state = await transitionRuntimeState(teamRunId, (current) => ({ ...current, status: "deleting" }), options.config)
      if (state.status === "deleting") await transitionRuntimeState(teamRunId, (current) => ({ ...current, status: "deleted" }), options.config)
      options.sessions.unregisterTeam(teamRunId)
      trace("omo.team.deleted", { teamRunId })
      return { content: JSON.stringify({ teamRunId, deleted: true }) }
    },
  }
  const request: TeamToolDefinition = shutdownRequestTool(options, trace)
  const approve: TeamToolDefinition = shutdownDecisionTool(options, "approve", trace)
  const reject: TeamToolDefinition = shutdownDecisionTool(options, "reject", trace)
  return [create, deleteTool, request, approve, reject]
}

function shutdownRequestTool(options: LifecycleToolsOptions, trace: TeamTrace): TeamToolDefinition {
  return {
    name: "team_shutdown_request",
    description: "Request shutdown for a team member.",
    input: { type: "object", properties: { teamRunId: { type: "string" }, targetMemberName: { type: "string" } }, required: ["teamRunId", "targetMemberName"], additionalProperties: false },
    execute: async (raw, toolCtx) => {
      const input = inputRecord(raw)
      const teamRunId = requiredString(input, "teamRunId")
      const target = requiredString(input, "targetMemberName")
      const participant = participantFor(options, teamRunId, toolCtx)
      if (participant.role !== "lead") throw new Error("team_shutdown_request is lead-only")
      await patchShutdownRequest(teamRunId, target, participant.memberName, options.config)
      await options.mailbox.send({ teamRunId, senderSessionID: options.resolveSessionID(toolCtx) ?? "", to: target, body: "Shutdown requested by team lead.", kind: "shutdown_request" })
      trace("omo.team.shutdown-requested", { teamRunId, target })
      return { content: JSON.stringify({ teamRunId, targetMemberName: target, status: "shutdown_requested" }) }
    },
  }
}

function shutdownDecisionTool(options: LifecycleToolsOptions, decision: "approve" | "reject", trace: TeamTrace): TeamToolDefinition {
  const name = decision === "approve" ? "team_approve_shutdown" : "team_reject_shutdown"
  return {
    name,
    description: `${decision === "approve" ? "Approve" : "Reject"} a pending shutdown request.`,
    input: { type: "object", properties: { teamRunId: { type: "string" }, memberName: { type: "string" }, reason: { type: "string" } }, required: decision === "approve" ? ["teamRunId", "memberName"] : ["teamRunId", "memberName", "reason"], additionalProperties: false },
    execute: async (raw, toolCtx) => {
      const input = inputRecord(raw)
      const teamRunId = requiredString(input, "teamRunId")
      const memberName = requiredString(input, "memberName")
      const participant = participantFor(options, teamRunId, toolCtx)
      if (participant.role !== "lead" && participant.memberName !== memberName) throw new Error(`${name}: caller must be target member or lead`)
      const now = Date.now()
      const reason = decision === "reject" ? requiredString(input, "reason") : undefined
      await resolveShutdown(teamRunId, memberName, options.config, (request) => decision === "approve" ? { ...request, approvedAt: now } : { ...request, rejectedAt: now, rejectedReason: reason })
      if (decision === "approve" && options.executor && options.run) {
        const state = await loadRuntimeState(teamRunId, options.config)
        const member = state.members.find((entry) => entry.name === memberName)
        if (!member?.sessionId || member.agentType === "leader") throw new Error("shutdown target must be a member")
        const record = await options.run(options.executor.managed(Session.ID.make(member.sessionId)))
        if (record) await options.run(options.executor.closeOwner(record.owner))
        await options.runtime.updateMemberStatus(member.sessionId, "shutdown_approved")
      }
      trace(`omo.team.shutdown-${decision}d`, { teamRunId, memberName })
      return { content: JSON.stringify({ teamRunId, memberName, status: `shutdown_${decision}d`, reason }) }
    },
  }
}
