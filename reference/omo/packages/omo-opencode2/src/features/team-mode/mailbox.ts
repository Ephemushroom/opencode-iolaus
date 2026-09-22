import { randomUUID } from "node:crypto"

import {
  MessageSchema,
  ackMessages,
  listUnreadMessages,
  loadRuntimeState,
  pollAndBuildInjection,
  sendMessage,
  transitionRuntimeState,
  type Message,
  type TeamModeConfig,
} from "@oh-my-opencode/team-core"
import { buildEnvelope } from "@oh-my-opencode/team-core/team-mailbox/poll"

import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import type { Executor } from "../../orchestration/execution/types"
import { Effect } from "effect"
import { TeamSessionRegistry } from "./session-registry"
import type { TeamFeatureContext, TeamTrace } from "./types"

type TeamMailboxOptions = {
  readonly ctx: Pick<TeamFeatureContext, "session">
  readonly config: TeamModeConfig
  readonly sessions: TeamSessionRegistry
  readonly gate: SessionDispatchGate
  readonly trace?: TeamTrace
  readonly executor?: Executor
  readonly run?: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>
}

export type SendTeamMessageInput = {
  readonly teamRunId: string
  readonly senderSessionID: string
  readonly to: string
  readonly body: string
  readonly kind?: Message["kind"]
  readonly summary?: string
}

export class TeamMailbox {
  readonly #ctx: Pick<TeamFeatureContext, "session">
  readonly #config: TeamModeConfig
  readonly #sessions: TeamSessionRegistry
  readonly #gate: SessionDispatchGate
  readonly #trace: TeamTrace
  readonly #executor: Executor | undefined
  readonly #run: (<A>(effect: Effect.Effect<A, unknown>) => Promise<A>) | undefined

  constructor(options: TeamMailboxOptions) {
    this.#ctx = options.ctx
    this.#config = options.config
    this.#sessions = options.sessions
    this.#gate = options.gate
    this.#trace = options.trace ?? (() => undefined)
    this.#executor = options.executor
    this.#run = options.run
  }

  async send(input: SendTeamMessageInput): Promise<{ readonly messageId: string; readonly deliveredTo: string[] }> {
    const runtime = await loadRuntimeState(input.teamRunId, this.#config)
    const sender = this.#sessions.lookup(input.senderSessionID)
    if (!sender || sender.teamRunId !== input.teamRunId) throw new Error("caller is not a participant of this team run")
    const lead = runtime.members.find((member) => member.agentType === "leader")
    if (!lead) throw new Error("team lead is missing from runtime state")
    const activeMembers = runtime.members
      .filter((member) => member.name !== sender.memberName && member.status !== "completed" && member.status !== "errored")
      .map((member) => member.name)
    const message = MessageSchema.parse({
      version: 1,
      messageId: randomUUID(),
      from: sender.memberName,
      to: input.to,
      kind: input.kind ?? "message",
      body: input.body,
      summary: input.summary,
      timestamp: Date.now(),
    })
    const result = await sendMessage(message, input.teamRunId, this.#config, {
      isLead: sender.role === "lead",
      activeMembers,
      leadRecipient: lead.name,
    })
    this.#trace("omo.team.message-sent", {
      teamRunId: input.teamRunId,
      messageId: message.messageId,
      from: message.from,
      to: message.to,
      kind: message.kind,
    })

    if (sender.role === "lead") await this.#deliverLeadMessage(runtime, message, result.deliveredTo)
    return result
  }

  async unreadForSession(teamRunId: string, sessionID: string): Promise<Message[]> {
    const participant = this.#sessions.lookup(sessionID)
    if (!participant || participant.teamRunId !== teamRunId) return []
    return listUnreadMessages(teamRunId, participant.memberName, this.#config)
  }

  async wakeLeadForMemberIdle(memberSessionID: string): Promise<void> {
    const participant = this.#sessions.lookup(memberSessionID)
    if (!participant || participant.role !== "member") return
    const runtime = await loadRuntimeState(participant.teamRunId, this.#config)
    const lead = runtime.members.find((member) => member.agentType === "leader")
    if (!lead?.sessionId) return
    const leadSessionID = lead.sessionId
    const turnMarker = `${memberSessionID}:${Date.now()}`
    await this.#gate.run(leadSessionID, async (markDispatched) => {
      const injection = await pollAndBuildInjection(leadSessionID, lead.name, runtime.teamRunId, this.#config, turnMarker)
      if (!injection.injected || !injection.content) return
      markDispatched()
      try {
        await this.#ctx.session.synthetic({
          sessionID: leadSessionID,
          text: `<omo-team-mailbox team_run_id="${runtime.teamRunId}">\n${injection.content}\n</omo-team-mailbox>`,
          description: "Team member mailbox update",
          metadata: { source: "omo.team.member-idle-wake", teamRunId: runtime.teamRunId },
          delivery: "queue",
          resume: true,
        })
        await ackMessages(runtime.teamRunId, lead.name, injection.messageIds, this.#config)
        await this.#clearPending(runtime.teamRunId, lead.name, injection.messageIds)
        this.#trace("omo.team.lead-woken", { teamRunId: runtime.teamRunId, memberName: participant.memberName, messages: injection.messageIds.length })
      } catch (error) {
        await this.#clearPending(runtime.teamRunId, lead.name, injection.messageIds)
        throw error
      }
    })
  }

  async #deliverLeadMessage(runtime: Awaited<ReturnType<typeof loadRuntimeState>>, message: Message, recipients: readonly string[]): Promise<void> {
    for (const recipientName of recipients) {
      const recipient = runtime.members.find((member) => member.name === recipientName)
      if (!recipient?.sessionId || recipient.agentType === "leader") continue
       if (this.#executor && this.#run) {
         const records = await this.#run(this.#executor.list())
         const memberRecords = records.filter((record) => record.owner.kind === "team" && record.owner.teamRunID === runtime.teamRunId && record.owner.member === recipient.name)
         const previous = memberRecords.at(-1)
         if (!previous) throw new Error(`No execution found for team member: ${recipient.name}`)
         await this.#run(this.#executor.submit({ kind: "message", owner: previous.owner, previous: previous.ref, text: buildEnvelope(message), description: `Team message from ${message.from}`, metadata: { source: "omo.team.direct-message", teamRunId: runtime.teamRunId, messageId: message.messageId }, background: true }))
       } else {
         await this.#ctx.session.synthetic({
           sessionID: recipient.sessionId,
           text: buildEnvelope(message),
           description: `Team message from ${message.from}`,
           metadata: { source: "omo.team.direct-message", teamRunId: runtime.teamRunId, messageId: message.messageId },
           delivery: "queue",
           resume: true,
         })
       }
      await ackMessages(runtime.teamRunId, recipient.name, [message.messageId], this.#config)
      this.#trace("omo.team.message-delivered", { teamRunId: runtime.teamRunId, messageId: message.messageId, recipient: recipient.name })
    }
  }

  async #clearPending(teamRunId: string, memberName: string, messageIds: readonly string[]): Promise<void> {
    const clearedIds = new Set(messageIds)
    await transitionRuntimeState(teamRunId, (state) => ({
      ...state,
      members: state.members.map((member) => member.name === memberName
        ? { ...member, pendingInjectedMessageIds: member.pendingInjectedMessageIds.filter((id) => !clearedIds.has(id)) }
        : member),
    }), this.#config)
  }
}
