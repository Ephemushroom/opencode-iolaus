import {
  createRuntimeState,
  transitionRuntimeState,
  type Member,
  type RuntimeState,
  type TeamModeConfig,
  type TeamSpec,
} from "@oh-my-opencode/team-core"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import type { Effect } from "effect"
import type { Executor, Owner } from "../../orchestration/execution/types"

import { persistProjectTeamSpec } from "./storage"
import { TeamSessionRegistry } from "./session-registry"
import type { TeamFeatureContext, TeamTrace } from "./types"

type MemberRuntimeOptions = {
  readonly ctx: Pick<TeamFeatureContext, "session">
  readonly cwd: string
  readonly config: TeamModeConfig
  readonly sessions: TeamSessionRegistry
  readonly trace?: TeamTrace
  readonly executor?: Executor
  readonly run?: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>
  readonly models?: ReadonlyMap<string, string>
}

type SpawnedMember = { readonly sessionID: string; readonly name: string }

function memberAgent(member: Member): string {
  return member.kind === "subagent_type" ? member.subagent_type : "sisyphus-junior"
}

function memberPrompt(spec: TeamSpec, member: Member, teamRunId: string): string {
  return [
    `Team: ${spec.name}`,
    `TeamRunId: ${teamRunId}`,
    `Member: ${member.name}`,
    member.kind === "category" ? `Category: ${member.category}` : undefined,
    member.prompt,
    "Use the team_* tools to read shared tasks and send results to lead. Do not create nested teams.",
  ].filter((line): line is string => typeof line === "string" && line.length > 0).join("\n")
}

export class TeamMemberRuntime {
  readonly #ctx: Pick<TeamFeatureContext, "session">
  readonly #cwd: string
  readonly #config: TeamModeConfig
  readonly #sessions: TeamSessionRegistry
  readonly #trace: TeamTrace
  readonly #executor: Executor | undefined
  readonly #run: (<A>(effect: Effect.Effect<A, unknown>) => Promise<A>) | undefined
  readonly #models: ReadonlyMap<string, string> | undefined

  constructor(options: MemberRuntimeOptions) {
    this.#ctx = options.ctx
    this.#cwd = options.cwd
    this.#config = options.config
    this.#sessions = options.sessions
    this.#trace = options.trace ?? (() => undefined)
    this.#executor = options.executor
    this.#run = options.run
    this.#models = options.models
  }

  async create(spec: TeamSpec, leadSessionID: string): Promise<RuntimeState> {
    const leadName = spec.leadAgentId
    if (!leadName) throw new Error("team spec is missing leadAgentId")
    await persistProjectTeamSpec(this.#cwd, spec, this.#config)
    let runtime = await createRuntimeState(spec, leadSessionID, "project", this.#config)
    runtime = await this.#updateLead(runtime.teamRunId, leadName, leadSessionID)
    const workers = spec.members.filter((member) => member.name !== leadName)
    const spawned: SpawnedMember[] = []

    try {
      let nextIndex = 0
      const workerCount = Math.min(this.#config.max_parallel_members, workers.length)
      await Promise.all(Array.from({ length: workerCount }, async () => {
        for (;;) {
          const member = workers[nextIndex]
          nextIndex += 1
          if (!member) return
           const spawnedMember = await this.#spawnMember(spec, runtime.teamRunId, leadSessionID, member)
          spawned.push(spawnedMember)
        }
      }))
      runtime = await transitionRuntimeState(runtime.teamRunId, (state) => ({ ...state, status: "active" }), this.#config)
      this.#trace("omo.team.created", { teamRunId: runtime.teamRunId, teamName: runtime.teamName, members: runtime.members.length })
      return runtime
    } catch (error) {
      await Promise.all(spawned.map((member) => this.#ctx.session.interrupt({ sessionID: member.sessionID }).catch(() => undefined)))
      await transitionRuntimeState(runtime.teamRunId, (state) => ({ ...state, status: "failed" }), this.#config)
      throw error
    }
  }

  async updateMemberStatus(sessionID: string, status: RuntimeState["members"][number]["status"]): Promise<void> {
    const participant = this.#sessions.lookup(sessionID)
    if (!participant) return
    await transitionRuntimeState(participant.teamRunId, (state) => ({
      ...state,
      members: state.members.map((member) => member.name === participant.memberName && member.status !== "completed" && member.status !== "shutdown_approved"
        ? { ...member, status }
        : member),
    }), this.#config)
    this.#trace("omo.team.member-status", { teamRunId: participant.teamRunId, memberName: participant.memberName, status })
  }

  async #updateLead(teamRunId: string, leadName: string, leadSessionID: string): Promise<RuntimeState> {
    this.#sessions.register(leadSessionID, { teamRunId, memberName: leadName, role: "lead" })
    return transitionRuntimeState(teamRunId, (state) => ({
      ...state,
      members: state.members.map((member) => member.name === leadName
        ? { ...member, sessionId: leadSessionID, status: "running", subagent_type: "sisyphus" }
        : member),
    }), this.#config)
  }

  async #spawnMember(spec: TeamSpec, teamRunId: string, leadSessionID: string, member: Member): Promise<SpawnedMember> {
    const agent = memberAgent(member)
    const modelName = this.#models?.get(member.kind === "category" ? member.category : agent)
    if (!this.#executor || !this.#run) {
      const child = await this.#ctx.session.create({ agent, title: `Team ${spec.name}/${member.name}` })
      this.#sessions.register(child.id, { teamRunId, memberName: member.name, role: "member" })
      await transitionRuntimeState(teamRunId, (state) => ({
        ...state,
        members: state.members.map((runtimeMember) => runtimeMember.name === member.name
          ? { ...runtimeMember, sessionId: child.id, status: "running", subagent_type: agent }
          : runtimeMember),
      }), this.#config)
      this.#trace("omo.team.member-started", { teamRunId, memberName: member.name, sessionID: child.id, agent })
      await this.#ctx.session.prompt({ sessionID: child.id, text: memberPrompt(spec, member, teamRunId) })
      return { sessionID: child.id, name: member.name }
    }
    if (!modelName) throw new Error(`No model registered for ${member.kind === "category" ? member.category : agent}`)
    const childID = Session.ID.create()
    this.#sessions.register(childID, { teamRunId, memberName: member.name, role: "member" })
    await transitionRuntimeState(teamRunId, (state) => ({
      ...state,
      members: state.members.map((runtimeMember) => runtimeMember.name === member.name
        ? {
          ...runtimeMember,
           sessionId: childID,
          status: "running",
          subagent_type: agent,
          ...(member.kind === "category" ? { category: member.category } : {}),
        }
        : runtimeMember),
    }), this.#config)
    const owner: Owner = { kind: "team", callerSessionID: Session.ID.make(leadSessionID), rootSessionID: Session.ID.make(leadSessionID), teamRunID: teamRunId, member: member.name }
    const ref = await this.#run(this.#executor.submit({
      kind: "fresh", owner, sessionID: childID, agent: Agent.ID.make(agent), model: Model.Ref.parse(modelName),
      text: memberPrompt(spec, member, teamRunId), description: `Team ${spec.name}/${member.name}`, background: true,
    }))
    this.#trace("omo.team.member-started", { teamRunId, memberName: member.name, sessionID: childID, agent, taskID: ref.taskID })
    return { sessionID: childID, name: member.name }
  }
}
