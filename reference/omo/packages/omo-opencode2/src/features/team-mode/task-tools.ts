import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
  type TeamModeConfig,
} from "@oh-my-opencode/team-core"

import { TeamMailbox } from "./mailbox"
import { TeamSessionRegistry } from "./session-registry"
import { inputRecord, optionalString, optionalStringArray, requiredString, taskStatus } from "./tool-input"
import type { TeamToolDefinition, TeamTrace } from "./types"

type TaskToolsOptions = {
  readonly config: TeamModeConfig
  readonly sessions: TeamSessionRegistry
  readonly mailbox: TeamMailbox
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
  readonly trace?: TeamTrace
}

const statusProperty = { type: "string", enum: ["pending", "claimed", "in_progress", "completed", "deleted"] } as const

export function createTeamTaskTools(options: TaskToolsOptions): TeamToolDefinition[] {
  const trace = options.trace ?? (() => undefined)
  const createTool: TeamToolDefinition = {
    name: "team_task_create",
    description: "Create a task on a team run's shared task list.",
    input: { type: "object", properties: { teamRunId: { type: "string" }, subject: { type: "string" }, description: { type: "string" }, blockedBy: { type: "array", items: { type: "string" } } }, required: ["teamRunId", "subject", "description"], additionalProperties: false },
    execute: async (raw) => {
      const input = inputRecord(raw)
      const teamRunId = requiredString(input, "teamRunId")
      const task = await createTask(teamRunId, { subject: requiredString(input, "subject"), description: requiredString(input, "description"), status: "pending", blocks: [], blockedBy: optionalStringArray(input, "blockedBy") ?? [] }, options.config)
      trace("omo.team.task-updated", { teamRunId, taskId: task.id, status: task.status, action: "created" })
      return { content: JSON.stringify({ taskId: task.id, task }) }
    },
  }
  const listTool: TeamToolDefinition = {
    name: "team_task_list",
    description: "List shared team tasks and surface unread mailbox messages for the caller.",
    input: { type: "object", properties: { teamRunId: { type: "string" }, status: statusProperty, owner: { type: "string" } }, required: ["teamRunId"], additionalProperties: false },
    execute: async (raw, toolCtx) => {
      const input = inputRecord(raw)
      const teamRunId = requiredString(input, "teamRunId")
      const statusValue = optionalString(input, "status")
      const status = statusValue === undefined ? undefined : taskStatus({ status: statusValue }, "status")
      const tasks = await listTasks(teamRunId, options.config, { status, owner: optionalString(input, "owner") })
      const sessionID = options.resolveSessionID(toolCtx)
      const messages = sessionID ? await options.mailbox.unreadForSession(teamRunId, sessionID) : []
      return { content: JSON.stringify({ tasks, messages }) }
    },
  }
  const getTool: TeamToolDefinition = {
    name: "team_task_get",
    description: "Get one task from a team run.",
    input: { type: "object", properties: { teamRunId: { type: "string" }, taskId: { type: "string" } }, required: ["teamRunId", "taskId"], additionalProperties: false },
    execute: async (raw) => {
      const input = inputRecord(raw)
      return { content: JSON.stringify({ task: await getTask(requiredString(input, "teamRunId"), requiredString(input, "taskId"), options.config) }) }
    },
  }
  const updateTool: TeamToolDefinition = {
    name: "team_task_update",
    description: "Claim or advance a shared team task through its allowed status transitions.",
    input: { type: "object", properties: { teamRunId: { type: "string" }, taskId: { type: "string" }, status: statusProperty, owner: { type: "string" } }, required: ["teamRunId", "taskId", "status"], additionalProperties: false },
    execute: async (raw, toolCtx) => {
      const input = inputRecord(raw)
      const teamRunId = requiredString(input, "teamRunId")
      const taskId = requiredString(input, "taskId")
      const sessionID = options.resolveSessionID(toolCtx)
      const participant = options.sessions.lookup(sessionID)
      if (!participant || participant.teamRunId !== teamRunId) throw new Error("caller is not a participant of this team run")
      const status = taskStatus(input, "status")
      const owner = optionalString(input, "owner") ?? participant.memberName
      const task = status === "claimed" ? await claimTask(teamRunId, taskId, owner, options.config) : await updateTaskStatus(teamRunId, taskId, status, owner, options.config)
      trace("omo.team.task-updated", { teamRunId, taskId, status: task.status, owner: task.owner })
      return { content: JSON.stringify({ task }) }
    },
  }
  return [createTool, listTool, getTool, updateTool]
}
