import type { RuntimeState } from "@oh-my-opencode/team-core"

import type { TeamParticipant } from "./types"

export class TeamSessionRegistry {
  readonly #sessions = new Map<string, TeamParticipant>()

  register(sessionID: string, participant: TeamParticipant): void {
    this.#sessions.set(sessionID, participant)
  }

  lookup(sessionID: string | undefined): TeamParticipant | undefined {
    return sessionID === undefined ? undefined : this.#sessions.get(sessionID)
  }

  unregister(sessionID: string): void {
    this.#sessions.delete(sessionID)
  }

  unregisterTeam(teamRunId: string): void {
    for (const [sessionID, participant] of this.#sessions) {
      if (participant.teamRunId === teamRunId) this.#sessions.delete(sessionID)
    }
  }

  registerRuntime(runtime: RuntimeState): void {
    for (const member of runtime.members) {
      if (!member.sessionId) continue
      this.register(member.sessionId, {
        teamRunId: runtime.teamRunId,
        memberName: member.name,
        role: member.agentType === "leader" ? "lead" : "member",
      })
    }
  }

  clear(): void {
    this.#sessions.clear()
  }
}
