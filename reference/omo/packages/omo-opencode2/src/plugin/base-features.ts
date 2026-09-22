import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import type { ConfiguredAgentRegistration } from "../agents/register-configured"
import type { OpenCode2Config } from "../config"
import { registerContextHooks } from "../hooks/register-context-hooks"
import { registerHashlineReadEnhancer } from "../hooks/hashline-read-enhancer"
import { registerWriteExistingFileGuard } from "../hooks/write-existing-file-guard"
import { registerPrometheusMdOnly } from "../hooks/prometheus-md-only"
import { registerCommentChecker } from "../hooks/comment-checker"
import { registerHashlineEditTool } from "../tools/hashline-edit"
import { registerSessionTools } from "../tools/session-manager"
import { TodoStore, createTodoWriteTool } from "../orchestration/todo-store"
import { createSessionModelRegistry } from "../tools/look-at"
import { Tool } from "@opencode/schema/tool"
import type { SessionDispatchGate } from "../orchestration/session-dispatch-gate"
import { registerGoalFeatureEffect } from "../hooks/goal"
import { registerTodoContinuationEffect } from "../hooks/todo-continuation"
import { registerBoulderContinuationEffect } from "../hooks/boulder-continuation"
import type { Trace } from "./trace"
import type { NativeIdleDispatch } from "../orchestration/idle-injector"

export const registerBaseFeatures = Effect.fn("omo.registerBaseFeatures")(function* (ctx: Context, options: {
  readonly config: OpenCode2Config
  readonly registration: ConfiguredAgentRegistration
  readonly gate: SessionDispatchGate
  readonly trace: Trace
  readonly dispatch: NativeIdleDispatch
}) {
  const { config, registration, gate, trace, dispatch } = options
  const directory = ctx.location.directory
  const todoStore = new TodoStore()
  const sessionModels = createSessionModelRegistry()
  const todo = createTodoWriteTool({ store: todoStore, trace })
  yield* ctx.tool.transform((editor) => editor.add({ ...todo, options: { codemode: false },
    execute: (input: unknown, caller) => Effect.tryPromise({ try: () => todo.execute(input, { sessionID: caller.sessionID }),
      catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }) }) }))
  yield* registerHashlineEditTool(ctx, trace)
  yield* registerHashlineReadEnhancer(ctx, trace)
  yield* registerSessionTools(ctx, { directory, trace })
  yield* registerWriteExistingFileGuard(ctx, trace)
  yield* registerPrometheusMdOnly(ctx, trace)
  yield* registerCommentChecker(ctx, trace)
  yield* registerContextHooks({ ctx, staticSisyphusPrompt: registration.sisyphusPrompt ?? "",
    workspaceDirectory: directory, todoStore, sessionModels, trace })
  const enabled = (name: string, value: boolean | undefined) => value === true && !config.disabled_hooks?.includes(name)
  yield* registerGoalFeatureEffect(ctx, { directory, gate, trace, dispatch, enabled: enabled("goal", config.goal?.enabled), autoStart: config.goal?.auto_start })
  yield* registerTodoContinuationEffect(ctx, { gate, trace, dispatch, enabled: enabled("todo_continuation", config.todo_continuation?.enabled),
    maxConsecutive: config.todo_continuation?.max_consecutive, getTodos: (id) => todoStore.get(id) })
  yield* registerBoulderContinuationEffect(ctx, { directory, gate, trace, dispatch, enabled: enabled("boulder", config.boulder?.enabled) })
  yield* ctx.event.subscribe().pipe(Stream.runForEach((event) => Effect.sync(() => {
    if (event.type === "session.deleted") todoStore.clear(event.data.sessionID)
  })), Effect.orDie, Effect.forkScoped)
  return { todoStore, sessionModels }
})
