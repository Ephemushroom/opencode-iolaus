import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { ConfiguredAgentRegistration } from "../../agents/register-configured"
import { guideTaskResult } from "../task-result-guidance"
import { nextFallbackModel } from "../child-session"
import { isTerminal, TaskID, type Executor, type SubmitRequest } from "./types"
import { runForeground } from "./foreground"

export const TaskInput = Schema.Struct({
  prompt: Schema.String,
  description: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  subagent_type: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  load_skills: Schema.optional(Schema.Array(Schema.String)),
  run_in_background: Schema.optional(Schema.Boolean),
  task_id: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
})
const TaskReferenceInput = Schema.Struct({ task_id: Schema.String })
type ToolCaller = Pick<Tool.Context, "sessionID">
type Trace = (event: string, detail?: Record<string, unknown>) => void
const DEFAULT_CHILD_TIMEOUT = 120000
const MAX_RETRIES = 1

function failure(error: unknown): Tool.Error {
  return new Tool.Error({ message: error instanceof Error ? error.message : String(error) })
}

export function createExecutionTaskTools(executor: Executor, agents: ConfiguredAgentRegistration, trace?: Trace) {
  const owned = Effect.fn("omo.task.owned")(function* (taskID: string, caller: Session.ID) {
    const record = yield* executor.latest(TaskID.make(taskID))
    if (!record || record.owner.kind !== "task" || record.owner.callerSessionID !== caller) {
      return yield* new Tool.Error({ message: `Unknown task id: ${taskID}.` })
    }
    return record
  })
  const executeTask = Effect.fn("omo.task.execute")(function* (input: typeof TaskInput.Type, caller: ToolCaller) {
    if (!input.prompt && !input.command) return yield* new Tool.Error({ message: "prompt (or command) is required" })
    if (input.category !== undefined && input.subagent_type !== undefined) {
      return yield* new Tool.Error({ message: "category OR subagent_type are mutually exclusive" })
    }
    const parent = yield* executor.managed(caller.sessionID)
    const owner = { kind: "task" as const, callerSessionID: caller.sessionID,
      rootSessionID: parent?.owner.rootSessionID ?? caller.sessionID }
    const background = input.run_in_background === true
    const text = input.load_skills?.length
      ? `${input.prompt}\n\n[Loaded skills for this task: ${input.load_skills.join(", ")}]`
      : input.prompt
    const common = { owner, text, background, description: input.description ?? input.prompt.slice(0, 60),
      immediate: parent !== undefined && !background }
    let request: SubmitRequest
    if (input.task_id !== undefined) {
      if (input.category !== undefined || input.subagent_type !== undefined) {
        return yield* new Tool.Error({ message: "task_id continuation cannot be combined with category/subagent_type" })
      }
      const previous = yield* owned(input.task_id, caller.sessionID)
      request = { ...common, kind: "continuation", previous: previous.ref }
    } else {
      const target = input.subagent_type ?? input.category
      if (target === undefined) return yield* new Tool.Error({ message: "Must provide category or subagent_type" })
      const allowed = input.subagent_type !== undefined ? agents.subagents : agents.categories
      if (!allowed.has(target)) return yield* new Tool.Error({ message: `Unknown ${input.subagent_type !== undefined ? "agent" : "category"}: ${target}` })
      const model = input.model ?? agents.models.get(target)
      if (!model) return yield* new Tool.Error({ message: `No model registered for ${target}` })
      const resolvedModel = yield* Effect.try({ try: () => Model.Ref.parse(model), catch: failure })
      request = { ...common, kind: "fresh", agent: Agent.ID.make(target), model: resolvedModel }
    }
    trace?.("omo.task.start", { parent: caller.sessionID, background,
      ...(request.kind === "fresh" ? { agent: request.agent, model: `${request.model.providerID}/${request.model.id}` } : {}) })
     if (background) {
       const ref = yield* executor.submit(request)
       return { content: `Background task ${ref.taskID} started. Use background_output with task_id="${ref.taskID}" to retrieve the result.` }
     }
     let { ref, record: result } = yield* runForeground(executor, request, DEFAULT_CHILD_TIMEOUT)
     let retries = 0
     while (result.status === "failed" && request.kind === "fresh" && retries < MAX_RETRIES) {
       const nextModel = nextFallbackModel(request.agent, `${request.model.providerID}/${request.model.id}`)
       if (!nextModel) break
       const fallbackModel = yield* Effect.try({ try: () => Model.Ref.parse(nextModel), catch: failure })
       const replacement = yield* runForeground(executor, { ...common, kind: "fresh", agent: request.agent, model: fallbackModel }, DEFAULT_CHILD_TIMEOUT)
       ref = replacement.ref
       retries += 1
       result = replacement.record
     }
    trace?.("omo.task.finished", { taskID: ref.taskID, ok: result.status === "completed", background, length: result.output.length })
    return { content: guideTaskResult(`Task ${ref.taskID} ${result.status === "completed" ? "result" : result.status}:\n${result.output || result.reason || ""}`, trace).content }
  })
  const task = {
    name: "task", input: TaskInput, options: { codemode: false },
    description: `Delegate work by category or subagent_type. run_in_background returns immediately; task_id continues your child. Available subagents: ${[...agents.subagents].join(", ")}. Available categories: ${[...agents.categories].join(", ")}.`,
    execute: (input: typeof TaskInput.Type, caller: ToolCaller) => executeTask(input, caller).pipe(Effect.mapError(failure)),
  }
  const output = {
    name: "background_output", input: TaskReferenceInput, options: { codemode: false },
    description: "Read the current result/status of your task without waiting for completion.",
    execute: (input: typeof TaskReferenceInput.Type, caller: ToolCaller) => owned(input.task_id, caller.sessionID).pipe(
      Effect.map((record) => ({ content: `Task ${input.task_id} (agent=${record.agent}) ${isTerminal(record) ? "is" : "is still"} ${record.status}.\n${record.output || record.reason || "(no output yet)"}` })), Effect.mapError(failure)),
  }
  const cancel = {
    name: "background_cancel", input: TaskReferenceInput, options: { codemode: false },
    description: "Request cancellation of your task; capacity is retained until the child has stopped.",
    execute: (input: typeof TaskReferenceInput.Type, caller: ToolCaller) => owned(input.task_id, caller.sessionID).pipe(
      Effect.flatMap((record) => executor.cancel(record.ref)),
      Effect.as({ content: `Cancellation requested for task ${input.task_id}.` }), Effect.mapError(failure)),
  }
  return { task, output, cancel }
}
