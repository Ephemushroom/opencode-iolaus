import {
  discoverTeamSpecs,
  listActiveTeams,
  listTasks,
  loadRuntimeState,
  loadTeamSpec,
  type Task,
  type TeamModeConfig,
} from "@oh-my-opencode/team-core"

import { TeamMailbox } from "./mailbox"
import { inputRecord, optionalString, requiredString } from "./tool-input"
import type { TeamToolDefinition, TeamTrace } from "./types"

type QueryToolsOptions = {
  readonly cwd: string
  readonly config: TeamModeConfig
  readonly mailbox: TeamMailbox
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
  readonly trace?: TeamTrace
}

function taskCounts(tasks: readonly Task[]): Record<Task["status"] | "total", number> {
  const counts = { pending: 0, claimed: 0, in_progress: 0, completed: 0, deleted: 0, total: 0 }
  for (const task of tasks) {
    counts[task.status] += 1
    counts.total += 1
  }
  return counts
}

export function createTeamQueryTools(options: QueryToolsOptions): TeamToolDefinition[] {
  const trace = options.trace ?? (() => undefined)
  const status: TeamToolDefinition = {
    name: "team_status",
    description: "Return runtime members, task counts, shutdown requests, bounds, and unread caller messages for a team run.",
    input: { type: "object", properties: { teamRunId: { type: "string" } }, required: ["teamRunId"], additionalProperties: false },
    execute: async (raw, toolCtx) => {
      const teamRunId = requiredString(inputRecord(raw), "teamRunId")
      const runtime = await loadRuntimeState(teamRunId, options.config)
      const tasks = await listTasks(teamRunId, options.config)
      const sessionID = options.resolveSessionID(toolCtx)
      const messages = sessionID ? await options.mailbox.unreadForSession(teamRunId, sessionID) : []
      trace("omo.team.status-read", { teamRunId, status: runtime.status, members: runtime.members.length, messages: messages.length })
      return { content: JSON.stringify({ ...runtime, tasks: taskCounts(tasks), messages }) }
    },
  }
  const list: TeamToolDefinition = {
    name: "team_list",
    description: "List declared and active teams for this project.",
    input: { type: "object", properties: { scope: { type: "string", enum: ["user", "project", "all"] } }, additionalProperties: false },
    execute: async (raw) => {
      const scopeValue = optionalString(inputRecord(raw), "scope")
      const scope = scopeValue === "user" || scopeValue === "project" ? scopeValue : "all"
      const declared = await discoverTeamSpecs(options.config, options.cwd)
      const active = await listActiveTeams(options.config)
      const activeByName = new Map(active.map((entry) => [entry.teamName, entry]))
      const entries = []
      for (const entry of declared) {
        if (scope !== "all" && entry.scope !== scope) continue
        const spec = await loadTeamSpec(entry.name, options.config, options.cwd)
        const runtime = activeByName.get(entry.name)
        entries.push({ name: entry.name, scope: entry.scope, status: runtime?.status ?? "not-started", teamRunId: runtime?.teamRunId, memberCount: runtime?.memberCount ?? spec.members.length })
      }
      for (const runtime of active) {
        if (entries.some((entry) => entry.name === runtime.teamName)) continue
        entries.push({ name: runtime.teamName, scope: runtime.scope, status: runtime.status, teamRunId: runtime.teamRunId, memberCount: runtime.memberCount })
      }
      return { content: JSON.stringify(entries) }
    },
  }
  return [status, list]
}
