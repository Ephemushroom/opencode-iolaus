import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRuntimeState, transitionRuntimeState } from "@oh-my-opencode/team-core"

import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { createTeamCoreConfig } from "./config"
import { TeamMailbox } from "./mailbox"
import { TeamSessionRegistry } from "./session-registry"
import type { TeamFeatureContext } from "./types"

describe("TeamMailbox idle wake", () => {
  test("#given an unread member-to-lead message #when concurrent member idle observers run #then the shared gate emits one queued lead summary", async () => {
    // given
    const cwd = await mkdtemp(join(tmpdir(), "oc2-team-wake-"))
    const config = createTeamCoreConfig(cwd)
    const spec = {
      version: 1 as const,
      name: "wake-team",
      createdAt: Date.now(),
      leadAgentId: "lead",
      members: [
        { name: "lead", kind: "subagent_type" as const, subagent_type: "sisyphus", backendType: "in-process" as const, isActive: true },
        { name: "worker", kind: "subagent_type" as const, subagent_type: "sisyphus-junior", backendType: "in-process" as const, isActive: true },
      ],
    }
    let runtime = await createRuntimeState(spec, "ses_lead", "project", config)
    runtime = await transitionRuntimeState(runtime.teamRunId, (state) => ({
      ...state,
      status: "active",
      members: state.members.map((member) => member.name === "lead"
        ? { ...member, sessionId: "ses_lead", status: "running" }
        : { ...member, sessionId: "ses_worker", status: "running" }),
    }), config)
    const sessions = new TeamSessionRegistry()
    sessions.registerRuntime(runtime)
    const synthetics: Array<{ readonly sessionID: string; readonly text: string }> = []
    const session: TeamFeatureContext["session"] = {
      create: async () => ({ id: "unused" }),
      prompt: async () => ({ id: "unused" }),
      synthetic: async (input) => {
        synthetics.push(input)
        return { id: "synthetic_lead" }
      },
      interrupt: async () => undefined,
    }
    const mailbox = new TeamMailbox({
      ctx: { session },
      config,
      sessions,
      gate: createSessionDispatchGate({ postDispatchHoldMs: 10 }),
    })
    await mailbox.send({ teamRunId: runtime.teamRunId, senderSessionID: "ses_worker", to: "lead", body: "worker result" })

    // when
    await Promise.all([
      mailbox.wakeLeadForMemberIdle("ses_worker"),
      mailbox.wakeLeadForMemberIdle("ses_worker"),
    ])

    // then
    expect(synthetics).toHaveLength(1)
    expect(synthetics[0]?.sessionID).toBe("ses_lead")
    expect(synthetics[0]?.text).toContain("worker result")
    expect(await mailbox.unreadForSession(runtime.teamRunId, "ses_lead")).toEqual([])
  })
})
