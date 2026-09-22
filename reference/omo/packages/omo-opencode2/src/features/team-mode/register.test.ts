import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { registerTeamMode } from "./register"
import type { TeamFeatureContext, TeamToolDefinition } from "./types"

type PromptCall = { readonly sessionID: string; readonly text: string }
type SyntheticCall = { readonly sessionID: string; readonly text: string; readonly delivery: "queue" }

function createContextStub(): {
  readonly ctx: TeamFeatureContext
  readonly tools: Map<string, TeamToolDefinition>
  readonly prompts: PromptCall[]
  readonly synthetics: SyntheticCall[]
  readonly createdAgents: string[]
} {
  const tools = new Map<string, TeamToolDefinition>()
  const prompts: PromptCall[] = []
  const synthetics: SyntheticCall[] = []
  const createdAgents: string[] = []
  let childCounter = 0
  const ctx = {
    options: {},
    tool: {
      transform: async (callback: (draft: { add(tool: TeamToolDefinition): void }) => void | Promise<void>) => callback({
        add: (tool) => tools.set(tool.name, tool),
      }),
    },
    event: {
      subscribe: async function* () {
        return
      },
    },
    session: {
      create: async (input: { readonly agent?: string }) => {
        childCounter += 1
        createdAgents.push(input.agent ?? "")
        return { id: `ses_member_${childCounter}` }
      },
      prompt: async (input: PromptCall) => {
        prompts.push(input)
        return { id: `prompt_${prompts.length}` }
      },
      synthetic: async (input: SyntheticCall) => {
        synthetics.push(input)
        return { id: `synthetic_${synthetics.length}` }
      },
      interrupt: async () => undefined,
      get: async (input: { readonly sessionID: string }) => ({ id: input.sessionID }),
    },
  }
  return { ctx, tools, prompts, synthetics, createdAgents }
}

async function writeConfig(cwd: string, enabled: boolean): Promise<void> {
  await mkdir(join(cwd, ".omo"), { recursive: true })
  await writeFile(join(cwd, ".omo", "opencode2.json"), JSON.stringify({ team_mode: { enabled } }))
}

describe("registerTeamMode", () => {
  test("#given default configuration #when Team Mode registers #then no team tools are exposed", async () => {
    // given
    const cwd = await mkdtemp(join(tmpdir(), "oc2-team-disabled-"))
    const stub = createContextStub()
    const traces: string[] = []

    // when
    const registration = await registerTeamMode(stub.ctx, {
      cwd,
      gate: createSessionDispatchGate({ postDispatchHoldMs: 1 }),
      resolveSessionID: () => "ses_lead",
      trace: (event) => traces.push(event),
    })

    // then
    expect(registration).toBeUndefined()
    expect(stub.tools.size).toBe(0)
    expect(traces).toContain("omo.team.disabled")
  })

  test("#given enabled configuration #when Team Mode registers #then all twelve tools are exposed", async () => {
    // given
    const cwd = await mkdtemp(join(tmpdir(), "oc2-team-enabled-"))
    await writeConfig(cwd, true)
    const stub = createContextStub()

    // when
    const registration = await registerTeamMode(stub.ctx, {
      cwd,
      gate: createSessionDispatchGate({ postDispatchHoldMs: 1 }),
      resolveSessionID: () => "ses_lead",
    })

    // then
    expect(registration).toBeDefined()
    expect([...stub.tools.keys()].sort()).toEqual([
      "team_approve_shutdown",
      "team_create",
      "team_delete",
      "team_list",
      "team_reject_shutdown",
      "team_send_message",
      "team_shutdown_request",
      "team_status",
      "team_task_create",
      "team_task_get",
      "team_task_list",
      "team_task_update",
    ])
  })

  test("#given an enabled two-worker spec #when team_create executes #then members spawn with the default and overridden agents", async () => {
    // given
    const cwd = await mkdtemp(join(tmpdir(), "oc2-team-spawn-"))
    await writeConfig(cwd, true)
    const stub = createContextStub()
    await registerTeamMode(stub.ctx, {
      cwd,
      gate: createSessionDispatchGate({ postDispatchHoldMs: 1 }),
      resolveSessionID: () => "ses_lead",
    })
    const create = stub.tools.get("team_create")
    if (!create) throw new Error("team_create was not registered")

    // when
    const result = await create.execute({
      name: "adapter-team",
      members: [
        { name: "default-worker", prompt: "Inspect the adapter and report findings." },
        { name: "atlas-worker", kind: "subagent_type", subagent_type: "atlas", prompt: "Review the architecture." },
      ],
    }, { sessionID: "ses_lead" })
    const parsed = JSON.parse(result.content) as { readonly teamRunId: string }

    // then
    expect(parsed.teamRunId.length).toBeGreaterThan(0)
    expect(stub.createdAgents).toEqual(["sisyphus-junior", "atlas"])
    expect(stub.prompts).toHaveLength(2)
  })

  test("#given more than eight total members #when team_create executes #then bounds enforcement rejects the spec before spawning", async () => {
    // given
    const cwd = await mkdtemp(join(tmpdir(), "oc2-team-bounds-"))
    await writeConfig(cwd, true)
    const stub = createContextStub()
    await registerTeamMode(stub.ctx, {
      cwd,
      gate: createSessionDispatchGate({ postDispatchHoldMs: 1 }),
      resolveSessionID: () => "ses_lead",
    })
    const create = stub.tools.get("team_create")
    if (!create) throw new Error("team_create was not registered")

    // when
    const run = create.execute({
      name: "oversized-team",
      members: Array.from({ length: 8 }, (_, index) => ({ name: `worker-${index + 1}`, prompt: "Perform the assigned work." })),
    }, { sessionID: "ses_lead" })

    // then
    await expect(run).rejects.toThrow("8")
    expect(stub.createdAgents).toEqual([])
  })

  test("#given an active member #when the lead sends a direct message #then it is delivered as one queued synthetic turn", async () => {
    // given
    const cwd = await mkdtemp(join(tmpdir(), "oc2-team-message-"))
    await writeConfig(cwd, true)
    const stub = createContextStub()
    await registerTeamMode(stub.ctx, {
      cwd,
      gate: createSessionDispatchGate({ postDispatchHoldMs: 1 }),
      resolveSessionID: (toolCtx) => {
        const record = typeof toolCtx === "object" && toolCtx !== null ? toolCtx as Record<string, unknown> : {}
        return typeof record.sessionID === "string" ? record.sessionID : undefined
      },
    })
    const create = stub.tools.get("team_create")
    const send = stub.tools.get("team_send_message")
    if (!create || !send) throw new Error("team tools were not registered")
    const created = await create.execute({
      name: "message-team",
      members: [{ name: "worker", prompt: "Wait for instructions and report back." }],
    }, { sessionID: "ses_lead" })
    const { teamRunId } = JSON.parse(created.content) as { readonly teamRunId: string }

    // when
    await send.execute({ teamRunId, to: "worker", body: "start task one" }, { sessionID: "ses_lead" })

    // then
    expect(stub.synthetics).toHaveLength(1)
    expect(stub.synthetics[0]?.sessionID).toBe("ses_member_1")
    expect(stub.synthetics[0]?.delivery).toBe("queue")
    expect(stub.synthetics[0]?.text).toContain("start task one")
  })
})
