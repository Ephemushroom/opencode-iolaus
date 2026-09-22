import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ackMessages,
  claimTask,
  createRuntimeState,
  createTask,
  getTask,
  listUnreadMessages,
  loadTeamSpec,
  sendMessage,
  updateTaskStatus,
} from "@oh-my-opencode/team-core"

import { createTeamCoreConfig, persistProjectTeamSpec } from "./storage"

describe("opencode2 Team Mode core bridge", () => {
  test("#given an inline project team #when persisted and loaded #then team-core round-trips the normalized registry spec", async () => {
    // given
    const cwd = await mkdtemp(join(tmpdir(), "oc2-team-registry-"))
    const config = createTeamCoreConfig(cwd)
    const spec = {
      version: 1 as const,
      name: "bridge-team",
      createdAt: Date.now(),
      leadAgentId: "lead",
      members: [
        { name: "lead", kind: "subagent_type" as const, subagent_type: "sisyphus", backendType: "in-process" as const, isActive: true },
        { name: "worker", kind: "subagent_type" as const, subagent_type: "sisyphus-junior", backendType: "in-process" as const, isActive: true },
      ],
    }

    // when
    await persistProjectTeamSpec(cwd, spec, config)
    const loaded = await loadTeamSpec(spec.name, config, cwd)

    // then
    expect(loaded).toEqual(spec)
  })

  test("#given an active team runtime #when a message is sent, polled, and acknowledged #then the mailbox transitions from unread to empty", async () => {
    // given
    const cwd = await mkdtemp(join(tmpdir(), "oc2-team-mailbox-"))
    const config = createTeamCoreConfig(cwd)
    const spec = {
      version: 1 as const,
      name: "mailbox-team",
      createdAt: Date.now(),
      leadAgentId: "lead",
      members: [
        { name: "lead", kind: "subagent_type" as const, subagent_type: "sisyphus", backendType: "in-process" as const, isActive: true },
        { name: "worker", kind: "subagent_type" as const, subagent_type: "sisyphus-junior", backendType: "in-process" as const, isActive: true },
      ],
    }
    const runtime = await createRuntimeState(spec, "ses_lead", "project", config)
    const message = {
      version: 1 as const,
      messageId: crypto.randomUUID(),
      from: "lead",
      to: "worker",
      kind: "message" as const,
      body: "inspect the adapter",
      timestamp: Date.now(),
    }

    // when
    await sendMessage(message, runtime.teamRunId, config, { isLead: true, activeMembers: ["worker"] })
    const unread = await listUnreadMessages(runtime.teamRunId, "worker", config)
    await ackMessages(runtime.teamRunId, "worker", [message.messageId], config)
    const afterAck = await listUnreadMessages(runtime.teamRunId, "worker", config)

    // then
    expect(unread.map((entry) => entry.body)).toEqual(["inspect the adapter"])
    expect(afterAck).toEqual([])
  })

  test("#given a pending task #when claimed and advanced #then team-core enforces the claim and forward transitions", async () => {
    // given
    const cwd = await mkdtemp(join(tmpdir(), "oc2-team-tasks-"))
    const config = createTeamCoreConfig(cwd)
    const spec = {
      version: 1 as const,
      name: "task-team",
      createdAt: Date.now(),
      leadAgentId: "lead",
      members: [{ name: "lead", kind: "subagent_type" as const, subagent_type: "sisyphus", backendType: "in-process" as const, isActive: true }],
    }
    const runtime = await createRuntimeState(spec, "ses_lead", "project", config)
    const task = await createTask(runtime.teamRunId, {
      subject: "Implement bridge",
      description: "Use team-core primitives",
      status: "pending",
      blocks: [],
      blockedBy: [],
    }, config)

    // when
    await claimTask(runtime.teamRunId, task.id, "lead", config)
    await updateTaskStatus(runtime.teamRunId, task.id, "in_progress", "lead", config)
    await updateTaskStatus(runtime.teamRunId, task.id, "completed", "lead", config)
    const completed = await getTask(runtime.teamRunId, task.id, config)

    // then
    expect(completed.status).toBe("completed")
    expect(completed.owner).toBe("lead")
  })
})
